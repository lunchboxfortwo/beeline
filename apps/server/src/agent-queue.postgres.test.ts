import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { AgentRunner } from '../../body/src/agent-runner.js';
import { AnswerStore } from '../../body/src/answer-store.js';
import { DaemonApiClient } from '../../body/src/daemon-api-client.js';
import { identityFromKey, type AgentRuntimeRecord } from '../../body/src/runtime.js';
import type { TokenAuth } from './auth.js';
import { PhoneService } from './phone-service.js';
import { PostgresLiveListener } from './postgres-live.js';
import { createBeelineServer } from './server.js';
import { ConnectionPresence } from './connection-presence.js';
import { AGENT_COMMAND_SCHEMA, createAgentCommand, readAgentCommands } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { groupBPostgresDatabase } from './test-fixtures/test-support-router-group-b-postgres.js';

// Waits re-check on each delivery and settled helper operation instead of a
// wall-clock poll, so a loaded machine only makes a test slower.
const harness = vi.hoisted(() => ({ deliver: vi.fn(), progress: new Set<() => void>() }));
function progressed() { for (const check of [...harness.progress]) check(); }
function until(ready: () => boolean): Promise<void> {
  return new Promise(resolve => {
    const check = () => { if (ready()) { harness.progress.delete(check); resolve(); } };
    harness.progress.add(check);
    check();
  });
}
const delivered = () => harness.deliver.mock.calls.map(([item]: [AgentCommand]) => item);
vi.mock('../../body/src/place-session.js', () => ({ PlaceSession: class {
  alive = false;
  stale = false;
  resources = { receiveCommand(_item: AgentCommand) {} };
  async start() {}
  current?: AgentCommand;
  async deliver(item: AgentCommand, batch: readonly AgentCommand[]) {
    this.current = item;
    const answering = harness.deliver(item, batch);
    progressed();
    try { return await answering; }
    finally { this.current = undefined; }
  }
  async stop() {}
  async dispose() {}
  cancel() {}
  grantPlace() { return {}; }
} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const answer = () => ({ text: 'Queue answer', steps: [], toolCalls: [], cleanup: async () => {} });

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
describe.skipIf(!url)('durable agent queue on PostgreSQL', () => {
  const human = 'a'.repeat(64), agent = 'b'.repeat(64), workspace = randomUUID(), room = randomUUID();
  let fixture: Awaited<ReturnType<typeof groupBPostgresDatabase>>, daemon: DaemonService;
  beforeAll(async () => {
    fixture = await groupBPostgresDatabase(url!);
    const db = fixture.database;
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Person','person'),($2,'agent','Agent','agent')`, [human,agent]);
    await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agent,human]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Queue')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Queue')`, [room,workspace]);
    for (const person of [human,agent]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'owner'),($1,$2,$3,'member')`, [workspace,room,person]);
    daemon = new DaemonService(db,new LiveHub());
  }, 60_000);
  afterAll(async () => fixture?.close());
  async function ask(text: string) {
    const source = randomBytes(32).toString('hex');
    await fixture.database.query(`INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES($1,$2,$3,$4,'message')`,
      [source,room,human,text]);
    return (await createAgentCommand(fixture.database,{roomId:room,agentId:agent,sourceMessageId:source,reason:'human_tag'}))!;
  }
  const answer = (requestId: string) => daemon.execute('postRoomMessage',{roomId:room,requestId,text:'durable answer'},agent);

  it('commits one answer and its done state together even with concurrent duplicate delivery', async () => {
    const item = await ask('concurrent delivery');
    const [first,second] = await Promise.all([answer(item.turn_request_id),answer(item.turn_request_id)]);
    expect(first.id).toBe(second.id);
    expect((await fixture.database.query(`SELECT state,result_message_id,completed_at IS NOT NULL done FROM agent_commands WHERE id=$1`,[item.id])).rows)
      .toEqual([{state:'complete',result_message_id:first.id,done:true}]);
    expect((await fixture.database.query(`SELECT count(*)::int n FROM messages WHERE author_id=$1 AND request_id=$2`,[agent,item.turn_request_id])).rows)
      .toEqual([{n:1}]);
  });

  it('keeps an item queued when posting fails and completes it only after a later successful post', async () => {
    const item = await ask('failed delivery');
    await fixture.database.query(`CREATE FUNCTION refuse_queue_answer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.author_id='${agent}' THEN RAISE EXCEPTION 'injected answer write failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER refuse_queue_answer BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION refuse_queue_answer()`);
    try {
      await expect(answer(item.turn_request_id)).rejects.toThrow('injected answer write failure');
      expect((await readAgentCommands(fixture.database,agent)).commands.map(command=>command.id)).toContain(item.id);
      expect((await fixture.database.query('SELECT completed_at FROM agent_commands WHERE id=$1',[item.id])).rows)
        .toEqual([{completed_at:null}]);
    } finally {
      await fixture.database.query('DROP TRIGGER refuse_queue_answer ON messages; DROP FUNCTION refuse_queue_answer()');
    }
    await answer(item.turn_request_id);
    expect((await readAgentCommands(fixture.database,agent)).commands.map(command=>command.id)).not.toContain(item.id);
  });

  it('cannot answer a stopped item', async () => {
    const item = await ask('stopped delivery');
    await fixture.database.query(`SELECT beeline_finish_agent_command($1,'cancelled','stop',NULL)`,[item.id]);
    await expect(answer(item.turn_request_id)).rejects.toThrow('command turn cancelled');
    expect((await fixture.database.query(`SELECT 1 FROM messages WHERE author_id=$1 AND request_id=$2`,[agent,item.turn_request_id])).rowCount).toBe(0);
  });

  it('retains preceding-image storage without letting it own the new answer', async () => {
    const item=await ask('rolling release overlap');
    await fixture.database.query(`UPDATE agent_commands SET generation_id='legacy-generation',
      claimed_at='2026-01-01T00:00:00Z',lease_expires_at='2026-01-02T00:00:00Z',
      execution_kind='helper',turn_owner_connection_id='legacy-connection',turn_owner_epoch=7 WHERE id=$1`,[item.id]);
    await fixture.database.query(`CREATE TABLE IF NOT EXISTS turn_owned_access_checks(id text);
      INSERT INTO turn_owned_access_checks VALUES('retained');
      CREATE OR REPLACE FUNCTION beeline_command_claim_open(text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$`);
    await fixture.database.query(AGENT_COMMAND_SCHEMA);
    expect((await fixture.database.query(`SELECT generation_id,turn_owner_connection_id,turn_owner_epoch::int epoch
      FROM agent_commands WHERE id=$1`,[item.id])).rows).toEqual([
        {generation_id:'legacy-generation',turn_owner_connection_id:'legacy-connection',epoch:7}]);
    expect((await fixture.database.query(`SELECT id,beeline_command_claim_open(id) readable
      FROM turn_owned_access_checks`)).rows).toEqual([{id:'retained',readable:true}]);
    await answer(item.turn_request_id);
    expect((await fixture.database.query('SELECT state FROM agent_commands WHERE id=$1',[item.id])).rows)
      .toEqual([{state:'complete'}]);
  });

  it('upgrades a shared legacy resume source without spending its parent answer', async () => {
    const item=await ask('legacy resume'), resumed=randomBytes(32).toString('hex');
    await fixture.database.query(`INSERT INTO agent_commands(id,room_id,agent_id,source_message_id,
      turn_request_id,action,reason,root_command_id,parent_command_id,root_source_message_id,agent_depth,state)
      SELECT $2,room_id,agent_id,source_message_id,turn_request_id,'resume','resume',root_command_id,
        id,root_source_message_id,agent_depth,'pending' FROM agent_commands WHERE id=$1`,[item.id,resumed]);
    await fixture.database.query(AGENT_COMMAND_SCHEMA);
    expect((await readAgentCommands(fixture.database,agent)).commands.map(command=>[command.id,command.turnRequestId]))
      .toEqual([[item.id,item.turn_request_id],[resumed,resumed]]);
    await answer(item.turn_request_id);
    expect((await readAgentCommands(fixture.database,agent)).commands.map(command=>command.id)).toEqual([resumed]);
    await answer(resumed);
    expect((await readAgentCommands(fixture.database,agent)).commands).toEqual([]);
  });
});

// Exercise the real writer, LISTEN/NOTIFY, machine socket, client validator and
// runner together. Only the model process is replaced; all queue state is SQL.
describe.skipIf(!url)('pending work reaches the helper on PostgreSQL', () => {
  const human = 'a'.repeat(64), opener = 'c'.repeat(64);
  const secretKeyHex = '01'.repeat(32);
  const identity = identityFromKey(secretKeyHex, 'Worker');
  const agent = identity.publicKey, workspace = randomUUID(), room = randomUUID();
  let fixture: Awaited<ReturnType<typeof groupBPostgresDatabase>>;
  let daemon: DaemonService, listener: PostgresLiveListener, presence: ConnectionPresence, phone: PhoneService;
  let server: ReturnType<typeof createBeelineServer>, baseUrl: string, root: string;
  let client: DaemonApiClient | undefined;
  let abort: AbortController | undefined, running: Promise<unknown> | undefined;
  let settled: {name: string; input: Record<string, unknown>; ok: boolean; output?: unknown}[] = [];
  /** Every id has an answer the server accepted; a refused empty answer leaves it owed. */
  const answered = (...ids: string[]) => until(() => ids.every(id => settled.some(op => op.ok &&
    op.name === 'postRoomMessage' && (op.output as {answered?: boolean}).answered !== false &&
    [op.input.requestId,...(op.input.queuedRequestIds as string[] | undefined ?? [])].includes(id))));

  beforeEach(async () => {
    harness.deliver.mockReset().mockImplementation(async () => answer());
    harness.progress.clear();
    settled = [];
    fixture = await groupBPostgresDatabase(url!);
    root = await mkdtemp(join(tmpdir(), 'queue-postgres-helper-'));
    const db = fixture.database, live = new LiveHub();
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Person','person'),($2,'agent','Worker','worker'),($3,'agent','Opener','opener')`, [human,agent,opener]);
    await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)', [agent,opener,human]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Queue delivery')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Queue delivery')`, [room,workspace]);
    for (const who of [human,agent,opener]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'owner'),($1,$2,$3,'member')`, [workspace,room,who]);
    daemon = new DaemonService(db,live);
    phone = new PhoneService(db,'http://test');
    presence = new ConnectionPresence(db,live);
    await presence.start();
    listener = PostgresLiveListener.forConnectionString(fixture.connectionString,db,live);
    const ready = deferred<void>(), release = live.subscribeResync(() => ready.resolve());
    void listener.run();
    await ready.promise;
    release();
    server = createBeelineServer({ database:db,live,daemon,phone,connectionPresence:presence,
      auth:{ authenticateDaemon:async () => agent, retiredDaemonAgent:async () => null } as unknown as TokenAuth,
      mediaMaximumBytes:1 });
    await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterEach(async () => {
    await until(() => (client?.metrics().inFlight ?? 0) === 0);
    abort?.abort();
    await running;
    client?.closeLive();
    await new Promise<void>(resolve => server?.close(() => resolve()));
    await listener?.stop();
    await presence?.stop();
    await fixture?.close();
    if (root) await rm(root,{recursive:true,force:true});
    client = undefined; abort = undefined; running = undefined;
  });

  async function connect() {
    client = new DaemonApiClient(baseUrl,'bdt_queue',agent);
    const execute = client.execute.bind(client);
    client.execute = (async (name: string, input: Record<string, unknown>) => {
      const record = (ok: boolean, output?: unknown) => { settled.push({name,input,ok,output}); progressed(); };
      try { const output = await execute(name as never,input as never); record(true,output); return output; }
      catch (error) { record(false); throw error; }
    }) as typeof client.execute;
    const runtime = { agent:{publicKey:agent,secretKeyHex,name:'Worker'}, communityId:workspace,
      rooms:[],supervisorRoot:root } as unknown as AgentRuntimeRecord;
    const runner = new AgentRunner(runtime,join(root,'runtime.json'),{
      workspaceRoot:root,agentBinary:'fixture',mcpBinary:'fixture',agentEnv:{},
    },{daemonApi:client});
    abort = new AbortController();
    const established = deferred<void>();
    running = runner.run({signal:abort.signal,onEstablished:() => established.resolve()});
    await established.promise;
  }

  async function ask(text: string, depth = 0, target = agent) {
    let parent: Awaited<ReturnType<typeof createAgentCommand>>;
    for (let level = 0; level <= depth; level++) {
      const source = randomBytes(32).toString('hex');
      await fixture.database.query(`INSERT INTO messages(id,room_id,author_id,text,presentation)
        VALUES($1,$2,$3,$4,'message')`, [source,room,human,text]);
      const command = (await createAgentCommand(fixture.database,{roomId:room,agentId:level < depth ? opener : target,
        sourceMessageId:source,reason:level ? 'agent_tag' : 'human_tag',...(parent ? {parent} : {})}))!;
      if (parent) await fixture.database.query(`SELECT beeline_finish_agent_command($1,'complete',NULL,NULL)`,[parent.id]);
      parent = command;
    }
    return parent!;
  }

  it.each(['busy','finishing'] as const)('delivers a depth-four item queued while the previous item is %s', async phase => {
    const first = await ask('First request');
    const held = deferred<ReturnType<typeof answer>>();
    harness.deliver.mockReturnValueOnce(held.promise);
    await connect();
    await until(() => delivered().length === 1);
    if (phase === 'finishing') {
      // A tool reply commits before the harness finishes returning.
      await daemon.execute('postRoomMessage',{roomId:room,requestId:first.id,text:'First reply'},agent);
    }
    const next = await ask('Follow-up request',4);
    expect(next.agent_depth).toBe(4);
    expect((await readAgentCommands(fixture.database,agent)).commands.map(item => item.id)).toContain(next.id);
    held.resolve(answer());
    await answered(next.id);
    expect(delivered().map(item => item.id)).toContain(next.id);
    expect((await fixture.database.query('SELECT state FROM agent_commands WHERE id=$1',[next.id])).rows)
      .toEqual([{state:'complete'}]);
  });

  it('delivers every pending depth-four item after helper reconnect without another insert', async () => {
    await connect();
    abort!.abort();
    await running;
    client!.closeLive();
    const backlog = await ask('Queued while disconnected',4);
    await connect();
    await answered(backlog.id);
    expect(delivered().map(item => item.id)).toContain(backlog.id);
    expect((await readAgentCommands(fixture.database,agent)).commands).toEqual([]);
  });

  it('delivers the next item in a cancelled place after restart with an empty saved answer', async () => {
    const interrupted = await ask('Interrupted before answering');
    await daemon.execute('startAgentTurn',{roomId:room,requestId:interrupted.id},agent);
    await fixture.database.query('SELECT * FROM beeline_interrupt_agent_turn($1,$2,$3,NULL,NULL)',[agent,room,interrupted.id]);
    expect((await fixture.database.query('SELECT status FROM agent_turns WHERE request_id=$1',[interrupted.id])).rows)
      .toEqual([{status:'cancelled'}]);
    await new AnswerStore(join(root,'answers')).save({itemId:interrupted.id,roomId:room,
      requestId:interrupted.id,text:'',harnessEnded:true});
    const next = await ask('Next request after release restart');
    await connect();
    await answered(interrupted.id,next.id);
    expect(delivered().map(item => item.id)).toContain(next.id);
    expect((await readAgentCommands(fixture.database,agent)).commands).toEqual([]);
  });

  it('keeps the working status after reconnect while the same harness continues its turn', async () => {
    const item = await ask('Keep working across a socket reconnect');
    const held = deferred<ReturnType<typeof answer>>();
    harness.deliver.mockReturnValueOnce(held.promise);
    await connect();
    const state = async () => (await phone.readLiveDelta(room,human,{type:'turn',agentId:agent,requestId:item.id}));
    const started = () => settled.filter(op => op.ok && op.name === 'startAgentTurn' && op.input.requestId === item.id).length;
    await until(() => started() === 1);
    expect(await state()).toMatchObject({turn:{status:'working'}});
    const epoch = (await fixture.database.query('SELECT epoch FROM agent_connections WHERE agent_id=$1',[agent])).rows[0]!.epoch;
    const reopened = deferred<void>(), release = client!.onLiveOpen(() => reopened.resolve());
    client!.reconnectLive();
    try {
      await reopened.promise;
      expect((await fixture.database.query('SELECT epoch FROM agent_connections WHERE agent_id=$1',[agent])).rows[0]!.epoch)
        .not.toBe(epoch);
      // The reopened socket re-announces the running turn.
      await until(() => started() === 2);
      expect(await state()).toMatchObject({turn:{status:'working'}});
      expect(harness.deliver).toHaveBeenCalledTimes(1);
    } finally { release(); held.resolve(answer()); }
    await answered(item.id);
    expect((await readAgentCommands(fixture.database,agent)).commands).toEqual([]);
    expect(await state()).toMatchObject({agentState:null,turn:{status:'complete'}});
  });

  it('delivers input queued while the preceding harness returns cancelled', async () => {
    const first = await ask('Before cancellation');
    const held = deferred<ReturnType<typeof answer> & {stopReason:string}>();
    harness.deliver.mockReturnValueOnce(held.promise);
    await connect();
    await until(() => delivered().length === 1);
    const next = await ask('After cancellation');
    held.resolve({...answer(),text:'',stopReason:'cancelled'});
    await answered(first.id,next.id);
    // The unanswered first request may share the next prompt with the new input.
    const deliveredIds = harness.deliver.mock.calls.flatMap(
      ([, batch]: [AgentCommand, readonly AgentCommand[]]) => batch.map(item => item.id),
    );
    expect(deliveredIds).toContain(next.id);
    expect((await readAgentCommands(fixture.database,agent)).commands).toEqual([]);
    expect(harness.deliver.mock.calls[0]![0].id).toBe(first.id);
  });

  it.each([0,4])('pushes the depth-%i opening brief to the named implementer while another place is busy', async depth => {
    const first = await ask('Busy in parent');
    const held = deferred<ReturnType<typeof answer>>();
    harness.deliver.mockReturnValueOnce(held.promise);
    await connect();
    await until(() => delivered().length === 1);
    const source = await ask('Open this thread',depth,opener);
    const spec = 'Implement the approved queue fix';
    const {cornerId} = await daemon.execute('createCorner',{roomId:room,requestId:source.id,
      idempotencyKey:randomUUID(),name:'Queue-brief',objective:spec,implementer:'worker',
      brief:{spec,approval:{sourceMessageId:source.source_message_id!}}},opener);
    const brief = () => delivered().find(item => item.roomId === cornerId);
    try {
      await until(() => brief() !== undefined);
      expect(brief()).toMatchObject({reason:'corner_objective',agentDepth:depth,source:{body:expect.stringContaining(spec)}});
      expect(delivered().map(item => item.id)).toContain(first.id);
    } finally { held.resolve(answer()); }
    await answered(first.id,brief()!.id);
    expect((await readAgentCommands(fixture.database,agent)).commands).toEqual([]);
  });
});

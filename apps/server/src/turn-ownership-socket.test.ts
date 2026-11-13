import { DaemonApiClient } from '../../body/src/daemon-api-client.js';
import { MachineLink } from '../../body/src/machine-link.js';
import type { AddressInfo } from 'node:net';
import { setTimeout as realTimeout, clearTimeout as realClearTimeout } from 'node:timers';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentCommand } from './agent-command.js';
import type { TokenAuth } from './auth.js';
import { ConnectionPresence } from './connection-presence.js';
import { MACHINE_SOCKET_PROTOCOL } from './daemon-live.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import type { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import type { PostgresDatabase } from './database.js';
import { groupBPostgresDatabase } from './test-fixtures/test-support-router-group-b-postgres.js';
import { PostgresLiveListener } from './postgres-live.js';
import { PhoneService as RealPhoneService } from './phone-service.js';
import { HelperDaemonService } from './test-fixtures/helper-daemon.js';
import { CommandExecutionContext, runServerCommandIntake } from '../../body/src/server-command-intake.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { OwnedModelAttempts } from './owned-model-attempt.js';
import { OwnedModelCredentials } from './owned-model-credential.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const agent = 'a'.repeat(64), owner = 'b'.repeat(64);
const room = '11111111-1111-4111-8111-111111111111', workspace = '22222222-2222-4222-8222-222222222222';
type Frame = Record<string, any>;
const postgresUrl = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
describe.each(['pglite', ...(postgresUrl ? ['postgres'] : [])])('P12 actual selected turn control socket (%s)', backend => {
  let db: PgliteDatabase | PostgresDatabase, live: LiveHub, presence: ConnectionPresence, daemon: DaemonService;
  let closeDatabase: () => Promise<void>;
  let connectionString: string | undefined;
  let listener: PostgresLiveListener | undefined, listening: Promise<void> | undefined;
  let server: ReturnType<typeof createBeelineServer> | undefined;
  const sockets: WebSocket[] = [], releases: Promise<void>[] = [];
  let command: NonNullable<Awaited<ReturnType<typeof createAgentCommand>>>;
  let stateRoot: string;
  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), 'turn-owner-'));
    if (backend === 'postgres') {
      const fixture = await groupBPostgresDatabase(postgresUrl!);
      db = fixture.database; closeDatabase = fixture.close;
      connectionString = fixture.connectionString;
    } else { db = await migratedDatabase(); closeDatabase = () => db.close(); connectionString = undefined; }
    live = new LiveHub();
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Synthetic owner'),($2,'agent','Synthetic agent')`, [owner, agent]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, owner]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic workspace')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Synthetic Room')`, [room, workspace]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner'),($1,NULL,$4,'member'),($1,$3,$4,'member')`, [workspace, owner, room, agent]);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('synthetic-request',$1,$2,'Synthetic work')`, [room, owner]);
    command = (await createAgentCommand(db, { roomId: room, agentId: agent, sourceMessageId: 'synthetic-request', reason: 'human_mention' }))!;
    expect(command).toBeDefined();
    // Only Date and the two actual connection control owners are driven.
    // PostgreSQL's pool, socket and transaction timers keep real time.
    vi.useFakeTimers({ toFake: ['Date'] });
    presence = new ConnectionPresence(db, live);
    const release = presence.releaseConnection.bind(presence);
    vi.spyOn(presence, 'releaseConnection').mockImplementation((...args) => {
      const work = release(...args); releases.push(work); return work;
    });
    daemon = new DaemonService(db, live);
  }, 60_000);
  afterEach(async () => {
    // Node HTTP and pg pool shutdown use real control timers. Business-clock
    // assertions finish before teardown; never freeze connection cleanup.
    vi.useRealTimers();
    for (const socket of sockets.splice(0)) socket.terminate();
    if (server) { await new Promise<void>(done => server!.close(() => done())); server = undefined; }
    await listener?.stop(); await listening; listener = undefined; listening = undefined;
    await Promise.all(releases.splice(0)); await presence?.stop(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await closeDatabase?.();
    await rm(stateRoot, { recursive: true, force: true });
  });
  async function connect(enabled = true, identity = agent) {
    vi.stubEnv('BEELINE_NETWORK_ROUTER_V1', enabled ? '1' : '0');
    if (!server) {
      server = createBeelineServer({ database: db, live, daemon, connectionPresence: presence,
        auth: { authenticateDaemon: async (token: string) => token === 'bdt_synthetic' ? agent : token === 'bdt_synthetic_peer' ? 'c'.repeat(64) : null,
          retiredDaemonAgent: async () => null, authenticatePhone: async () => null } as unknown as TokenAuth,
        phone: { canReadRooms: async () => new Set([room]) } as unknown as PhoneService });
      await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
    }
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/phone/live`, [MACHINE_SOCKET_PROTOCOL]);
    sockets.push(socket); const frames: Frame[] = [];
    let closed: { code: number; reason: string } | undefined;
    socket.on('close', (code, reason) => { closed = { code, reason: reason.toString() }; });
    socket.on('message', raw => frames.push(JSON.parse(raw.toString())));
    await new Promise<void>((done, reject) => { socket.once('open', done); socket.once('error', reject); });
    const next = async (predicate: (frame: Frame) => boolean, label = predicate.toString()) => {
      const current = frames.find(predicate); if (current) return current;
      return new Promise<Frame>((resolve, reject) => {
        const release = () => { realClearTimeout(deadline); socket.off('message', observe); };
        const observe = () => { const result = frames.find(predicate); if (result) { release(); resolve(result); } };
        const deadline = realTimeout(() => { release(); reject(new Error(
          `Missing ${label}; state=${socket.readyState}; close=${JSON.stringify(closed)}; frames=${JSON.stringify(frames)}`)); }, 2_000);
        socket.on('message', observe);
      });
    };
    const send = (frame: Frame) => socket.send(JSON.stringify({ agentId: identity, ...frame }));
    send({ type: 'register', token: identity === agent ? 'bdt_synthetic' : 'bdt_synthetic_peer', lifecycleId: 'synthetic-lifecycle', turnOwnershipV1: true, intakeHeartbeat: true });
    const registered = await next(frame => frame.type === 'registered');
    return { socket, frames, send, next, registered };
  }
  async function claim(client: Awaited<ReturnType<typeof connect>>, generationId = 'generation', requestId = 'claim') {
    client.send({ type: 'turn-operation', operation: 'claimAgentCommand', requestId,
      input: { roomId: room, commandId: command.id, generationId } });
    return client.next(frame => frame.type === 'turn-result' && frame.requestId === requestId, `turn result ${requestId}`);
  }

  it.each([
    { kind: 'ordinary', provider: 'no model call' },
    { kind: 'free-agent model', provider: 'a model call made before the restart' },
    { kind: 'free-agent model', provider: 'a model call made after the resume' },
  ])('Reproduction TURN-1: a $kind turn with $provider survives a deploy, a reconnect and a helper restart, and its report reaches the commander', async ({ kind, provider }) => {
    const freeAgent = kind !== 'ordinary', callBeforeRestart = provider.endsWith('before the restart');
    // A commander in a DM with the owner orders this agent to work in the Room.
    const commander = 'd'.repeat(64), dm = '33333333-3333-4333-8333-333333333333';
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Commander','commander')`, [commander]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [commander, owner]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants,created_by)
      VALUES($1,$2,'Owner and Commander',jsonb_build_array($3::text,$4::text),$3)`, [dm, workspace, owner, commander]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'member'),($1,$3,$2,'member'),($1,$4,$2,'member'),($1,$4,$5,'member')`, [workspace, commander, room, dm, owner]);
    await db.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`, [command.id]);
    if (freeAgent) await db.query(`INSERT INTO free_agents(agent_id,owner_id,sealed_keys,model_token_hash,state,model)
      VALUES($1,$2,'synthetic sealed fixture',$3,'running','synthetic/model')`, [agent, owner, 'c'.repeat(64)]);
    const people = new RealPhoneService(db, 'http://test');
    await people.execute('sendRoomMessage', { roomId: dm, messageId: 'e'.repeat(64), text: 'Have the agent build it' }, owner);
    const commanders = new HelperDaemonService(db, live);
    const asked = (await commanders.execute('getAgentCommands', { roomId: dm }, commander)).commands[0]!;
    await commanders.execute('claimAgentCommand', { roomId: dm, commandId: asked.id, generationId: 'commander' }, commander);
    await commanders.execute('order', { roomId: dm, requestId: asked.turnRequestId, generationId: 'commander',
      address: room, agent, text: 'Build it and report.' }, commander);

    // Two server instances share the database; a deploy replaces the first.
    vi.stubEnv('BEELINE_NETWORK_ROUTER_V1', '1');
    const credentials = new OwnedModelCredentials({ currentVersion: 'test-v1', key: version => version === 'test-v1' ? Buffer.alloc(32, 7) : undefined },
      () => 'synthetic/model');
    const instances: { server: ReturnType<typeof createBeelineServer>; presence: ConnectionPresence }[] = [];
    const startInstance = async (instanceId: string) => {
      const instancePresence = new ConnectionPresence(db, live, { instanceId });
      const instanceDaemon = new DaemonService(db, live);
      if (freeAgent) instanceDaemon.setOwnedModel({ credentials, ready: () => true });
      const instance = createBeelineServer({ database: db, live, daemon: instanceDaemon, connectionPresence: instancePresence,
        auth: { authenticateDaemon: async (token: string) => token === 'bdt_synthetic' ? agent : null,
          retiredDaemonAgent: async () => null, authenticatePhone: async () => null } as unknown as TokenAuth,
        phone: { canReadRooms: async () => new Set([room]) } as unknown as PhoneService });
      await new Promise<void>(done => instance.listen(0, '127.0.0.1', done));
      instances.push({ server: instance, presence: instancePresence });
      return `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
    };
    let origin = await startInstance('before-deploy');
    const helperSockets: WebSocket[] = [];
    const claims: { modelCredential?: { token: string } }[] = [];
    // One helper process: its machine link, API client and command intake.
    const startHelper = (run: (command: AgentCommand, context: CommandExecutionContext) => Promise<void>) => {
      const machine = new MachineLink({ baseUrl: origin, readVault: vi.fn(async () => ({ connections: [] })), log: vi.fn(),
        factory: (_url, protocols, options) => {
          const socket = new WebSocket(`${origin.replace('http', 'ws')}/v1/phone/live`, protocols, options);
          helperSockets.push(socket); sockets.push(socket); return socket;
        } });
      const client = new DaemonApiClient(origin, 'bdt_synthetic', agent, fetch, undefined, undefined, machine);
      const api = new Proxy(client, { get: (target, key) => key === 'execute'
        ? async (name: string, input: Record<string, unknown>) => {
          const result = await target.execute(name as never, input as never);
          if (name === 'claimAgentTurn') claims.push(result as never);
          return result;
        }
        : (value => typeof value === 'function' ? value.bind(target) : value)(Reflect.get(target, key)) });
      const context = new CommandExecutionContext(join(stateRoot, `helper-${claims.length}-${helperSockets.length}`));
      const controller = new AbortController(), errors: unknown[] = [];
      let stopped!: () => void;
      const stop = new Promise<void>(resolve => { stopped = resolve; });
      const intake = runServerCommandIntake({ api, roomId: room, agentId: agent, context, signal: controller.signal,
        run: command => Promise.race([run(command, context), stop]), stop: () => stopped(), onError: error => errors.push(error) });
      return { machine, api: client, context, controller, intake, errors };
    };
    const drop = async () => {
      const socket = helperSockets.at(-1)!;
      const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
      socket.terminate(); await closed;
    };
    // The model provider is the one external effect. It must run exactly once.
    const providerCalls: string[] = [], attempts = new OwnedModelAttempts(db, credentials);
    const modelRequestId = '11111111-1111-4111-8111-111111111111';
    const callModel = async (token: string) => {
      const actor = await credentials.authenticate(db, token);
      const admitted = await attempts.reserve(actor, modelRequestId, { step: 'build' }, async () => ({
        reservation: { day: '2026-11-12', reserved: 16, maxOutput: 8, reservedUsd: 0.01, credit: 0 },
        payload: { model: actor.binding.model, max_tokens: 8, messages: [] } }));
      if (admitted.permit) await attempts.handoff(admitted.permit, async body => { providerCalls.push(body); return 'answer'; });
      return actor;
    };
    let started!: (work: AgentCommand) => void;
    const running = new Promise<AgentCommand>(resolve => { started = resolve; });
    // The first process starts the turn and is still working when it is interrupted.
    let helper = startHelper(async work => { started(work); await new Promise(() => {}); });
    let restarted: ReturnType<typeof startHelper> | undefined;
    try {
      const work = await running;
      expect(work.reason).toBe('order');
      const generationId = helper.context.generationId;
      const turn = { roomId: room, requestId: work.turnRequestId, generationId };
      // The provider answer stays UNKNOWN across the deploy and the restart.
      if (callBeforeRestart) await callModel(claims[0]!.modelCredential!.token);

      // Deploy: the first instance stops renewing its lease and its sockets end.
      origin = await startInstance('after-deploy');
      await instances[0]!.presence.stop();
      await db.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '1 hour' WHERE instance_id='before-deploy'`);
      await new Promise<void>(done => instances[0]!.server.close(() => done()));
      await drop(); await helper.api.waitForConnection();
      await helper.api.execute('postAgentThought', { ...turn, text: 'Started the build.' });

      // The socket drops again; the same helper process carries on.
      await drop(); await helper.api.waitForConnection();
      await helper.api.execute('postAgentThought', { ...turn, text: 'Still building.' });
      // The invocation's model credential still holds on the new instance.
      if (freeAgent) await credentials.assertCurrent(db, await credentials.authenticate(db, claims[0]!.modelCredential!.token));

      // The helper process restarts mid-turn. Its turn is neither failed nor consumed.
      helper.controller.abort(); await helper.intake;
      helper.api.closeLive(); helper.machine.stop();
      expect(helper.errors).toEqual([]);
      expect((await db.query('SELECT state,generation_id FROM agent_commands WHERE id=$1', [work.id])).rows[0])
        .toEqual({ state: 'claimed', generation_id: generationId });

      // The next process resumes the same turn from its record and reports.
      let finished!: () => void;
      const reported = new Promise<void>(resolve => { finished = resolve; });
      restarted = startHelper(async (resumed, context) => {
        expect(resumed.turnRequestId).toBe(work.turnRequestId);
        expect(context.generationId).toBe(generationId);
        if (freeAgent) {
          // The same invocation keeps its one credential. Repeating the model
          // request reads the original attempt; it never dispatches again.
          expect(claims.at(-1)!.modelCredential).toEqual(claims[0]!.modelCredential);
          const actor = await callModel(claims.at(-1)!.modelCredential!.token);
          await attempts.settleUsage(actor, modelRequestId, { tokens: 2, usd: 0 }, 'succeeded', async () => {});
        }
        await restarted!.api.execute('report', { ...turn, status: 'done', text: 'Built it after the deploy and the restart.' } as never);
        finished();
      });
      helper = restarted;
      await reported;
      await vi.waitFor(async () => expect((await db.query('SELECT state FROM agent_commands WHERE id=$1', [work.id])).rows[0])
        .toEqual({ state: 'complete' }), { timeout: 5_000 });
      expect(helper.errors).toEqual([]);
      expect(providerCalls).toHaveLength(freeAgent ? 1 : 0);
      if (freeAgent) expect((await db.query('SELECT state FROM owned_model_attempts')).rows).toEqual([{ state: 'succeeded' }]);
      const reports = (await commanders.execute('getAgentCommands', { roomId: dm }, commander)).commands
        .filter(item => item.reason === 'report');
      expect(reports.map(item => item.source.body).join('\n')).toContain('Built it after the deploy and the restart.');
    } finally {
      helper.controller.abort(); await helper.intake.catch(() => {});
      helper.api.closeLive(); helper.machine.stop();
      for (const instance of instances.splice(0)) {
        await instance.presence.stop();
        if (instance.server.listening) await new Promise<void>(done => instance.server.close(() => done()));
      }
    }
  }, 30_000);

  it('binds the actual registration and replays a claim without row writes', async () => {
    const client = await connect();
    expect(client.registered.capabilities).toMatchObject({ turnOwnershipV1: true });
    expect(await claim(client)).toHaveProperty('result');
    const versions = async () => (await db.query(`SELECT command.xmin::text command_version,turn.xmin::text turn_version,
      turn.created_at::text,turn.started_at::text,binding.xmin::text binding_version
      FROM agent_commands command JOIN agent_turns turn ON turn.room_id=command.room_id AND turn.agent_id=command.agent_id
        AND turn.request_id=command.turn_request_id JOIN agent_command_generation_owners binding ON binding.command_id=command.id
        AND binding.generation_id=command.generation_id WHERE command.id=$1`, [command.id])).rows;
    const before = await versions();
    for (let i = 0; i < 10; i += 1) expect(await claim(client, 'generation', `replay-${i}`)).toHaveProperty('result');
    expect(await versions()).toEqual(before);
    client.send({ type: 'turn-operation', operation: 'postAgentTurnReceipt', requestId: 'freshness',
      input: { agentId: agent, roomId: room, requestId: command.turn_request_id, generationId: 'generation', status: 'working', heartbeat: true } });
    expect(await client.next(frame => frame.requestId === 'freshness')).toHaveProperty('error');
    expect(await versions()).toEqual(before);
  });

  it('binds a free-agent claim to its machine while the optional model rollout is disabled', async () => {
    await db.query(`WITH workspace AS (SELECT $2::uuid) INSERT INTO free_agents(agent_id,owner_id,state,sealed_keys,model_token_hash) VALUES($1,$3,'running','fixture',$4)`,[agent,workspace,owner,'c'.repeat(64)]);
    expect(daemon.ownedModelReady()).toBe(false);
    const client=await connect();
    expect(client.registered.capabilities).toMatchObject({turnOwnershipV1:true});
    expect(await claim(client)).toHaveProperty('result');
    expect((await db.query('SELECT turn_owner_connection_id FROM agent_commands WHERE id=$1',[command.id])).rows[0])
      .toMatchObject({turn_owner_connection_id:client.registered.capabilities.turnConnectionId});
  });

  it('F14 scopes 1,000 irrelevant facts to zero inbox reads and sends one targeted command', async () => {
    const peer = 'c'.repeat(64);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Peer')`, [peer]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [peer, owner]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`, [workspace, peer, room]);
    if (connectionString) {
      const ready = new Promise<void>(resolve => { const stop = live.subscribeResync(() => { stop(); resolve(); }); });
      listener = PostgresLiveListener.forConnectionString(connectionString, db, live); listening = listener.run(); await ready;
    }
    const client = await connect();
    client.send({ type: 'subscribe', roomId: room, inbox: false });
    expect(await client.next(frame => frame.type === 'subscribed')).toMatchObject({ capabilities: { inboxSnapshot: false } });
    const other = await connect(true, peer);
    other.send({ type: 'subscribe', roomId: room, inbox: false }); await other.next(frame => frame.type === 'subscribed');
    const execute = vi.spyOn(daemon, 'execute');
    for (let i = 0; i < 1000; i++) live.publish({ type: 'invalidate', roomId: room,
      reason: i % 2 ? 'postgres:agent_turns' : 'postgres:agent_activity', messageId: `unrelated-${i}` });
    const after = client.frames.length;
    const otherBefore = other.frames.filter(frame => frame.type === 'commands').length;
    let expected = [command.id];
    if (connectionString) {
      await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('new-command-source',$1,$2,'New targeted work')`, [room, owner]);
      const nextCommand = await createAgentCommand(db, { roomId: room, agentId: agent, sourceMessageId: 'new-command-source', reason: 'human_mention' });
      expect(nextCommand).toBeDefined(); expected.push(nextCommand!.id);
    } else live.publish({ type: 'invalidate', roomId: room, reason: 'postgres:agent_commands', targetAgentId: agent });
    const delivered = await client.next(frame => client.frames.indexOf(frame) >= after && frame.type === 'commands');
    expect(delivered.commands.map((value: Frame) => value.id).sort()).toEqual(expected.sort());
    expect(other.frames.filter(frame => frame.type === 'commands')).toHaveLength(otherBefore);
    expect(execute.mock.calls.filter(([name]) => name === 'getRoomInbox')).toHaveLength(0);
    expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands')).toHaveLength(1);
    expect(await claim(client)).toHaveProperty('result');
  });

  it('F22 repeated hosting readiness uses the known verdict with zero PostgreSQL probes', async () => {
    await connect();
    const queries = vi.spyOn(db, 'query');
    const before = queries.mock.calls.length;
    const origin = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    for (let i = 0; i < 60; i++) {
      const response = await fetch(`${origin}/readyz`, { headers: { connection: 'close' } });
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    }
    expect(queries.mock.calls.slice(before)).toEqual([]);
  });

  it('rejects a forged source field before dispatch, even in the disabled router cohort', async () => {
    const selected=await connect(false),execute=vi.spyOn(daemon,'execute');
    selected.send({ type: 'turn-operation', operation: 'claimAgentCommand', requestId: 'forged',
      input: { roomId: room, commandId: command.id, generationId: 'generation', source: { connectionId: 'forged', epoch: 1 } } });
    expect(await selected.next(frame => frame.requestId === 'forged')).toHaveProperty('error');
    expect(execute).not.toHaveBeenCalled();
  });
});

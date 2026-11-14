import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createAgentCommand } from './agent-command.js';
import { TokenAuth } from './auth.js';
import { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { POSTGRES_LIVE_CHANNEL, PostgresLiveListener, type LivePgClient } from './postgres-live.js';
import { COMMAND_COMPLETION_CHANNEL } from './command-completion.js';
import { createBeelineServer } from './server.js';
import { PgliteDatabase, migratedDatabase } from './test-support.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333';
const HUMAN = '1'.repeat(64), WORKER = 'b'.repeat(64), REVIEWER = 'c'.repeat(64);

class PgliteListenClient extends EventEmitter implements LivePgClient {
  private readonly releases = new Map<string, () => Promise<void>>();
  constructor(private readonly database: PgliteDatabase) { super(); }
  async connect(): Promise<void> {}
  async query(sql: string): Promise<void> {
    const channel = [POSTGRES_LIVE_CHANNEL, COMMAND_COMPLETION_CHANNEL]
      .find(value => sql === `LISTEN ${value}`);
    if (!channel) throw new Error(`unexpected query: ${sql}`);
    if (this.releases.has(channel)) return;
    this.releases.set(channel, await this.database.client.listen(channel, payload =>
      this.emit('notification', { channel, payload })));
  }
  async end(): Promise<void> {
    await Promise.all([...this.releases.values()].map(release => release()));
    this.releases.clear();
  }
}

let db: PgliteDatabase, server: ReturnType<typeof createBeelineServer>, listener: PostgresLiveListener;
let origin: string;
const tokens = new Map<string, string>();

beforeAll(async () => {
  db = await migratedDatabase();
  for (const [id, kind, name] of [[HUMAN, 'human', 'Human'], [WORKER, 'agent', 'Worker'], [REVIEWER, 'agent', 'Reviewer']])
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,$2,$3)`, [id, kind, name]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [WORKER, REVIEWER, HUMAN]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Held review proof')`, [WORKSPACE]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,reviewer_agent_id) VALUES($1,$2,'Team',$3)`, [PARENT, WORKSPACE, REVIEWER]);
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'fix')`, [CORNER, WORKSPACE, PARENT, HUMAN]);
  for (const room of [null, PARENT])
    for (const who of [HUMAN, WORKER, REVIEWER])
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WORKSPACE, room, who]);
  const auth = new TokenAuth(db, async () => ({ subject: 'proof', login: 'proof' }));
  const live = new LiveHub();
  listener = new PostgresLiveListener(db, live, () => new PgliteListenClient(db));
  void listener.run();
  await vi.waitFor(() => expect(listener.projectionHealth().connected).toBe(true));
  server = createBeelineServer({ database: db, auth, live, phone: new PhoneService(db, 'http://placeholder'), daemon: new DaemonService(db, live) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const agent of [WORKER, REVIEWER]) tokens.set(agent,
    (await auth.exchangeDaemonToken((await auth.createDaemonExchange(agent)).exchangeToken))!.daemonToken);
}, 30_000);

afterAll(async () => {
  await listener?.stop();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.close();
});

async function call(agent: string, operation: string, payload: object) {
  const response = await fetch(`http://${origin}/v1/daemon/operations/${operation}`, {
    method: 'POST', headers: { authorization: `Bearer ${tokens.get(agent)}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}

async function source(text: string): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [id, CORNER, HUMAN, text]);
  return id;
}

describe('Reproduction S-07: review items reach the native helper queue', () => {
  it('delivers while another agent is busy and completes only after each answer', async () => {
    const work=await createAgentCommand(db,{roomId:CORNER,agentId:WORKER,
      sourceMessageId:await source('@worker fix it'),reason:'human_tag'});
    await call(WORKER,'startAgentTurn',{roomId:CORNER,requestId:work!.id});
    const socket=new WebSocket(`ws://${origin}/v1/phone/live`,['beeline.machine.1']);
    const frames:Record<string,unknown>[]=[];
    socket.on('message',raw=>frames.push(JSON.parse(raw.toString()) as Record<string,unknown>));
    await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    try {
      socket.send(JSON.stringify({type:'register',agentId:REVIEWER,token:tokens.get(REVIEWER),queueV1:true}));
      await expect.poll(()=>frames.some(frame=>frame.type==='registered'),{timeout:5000}).toBe(true);
      socket.send(JSON.stringify({type:'subscribe-queue',agentId:REVIEWER}));
      await expect.poll(()=>frames.some(frame=>frame.type==='commands'),{timeout:5000}).toBe(true);
      const review=await createAgentCommand(db,{roomId:CORNER,agentId:REVIEWER,
        sourceMessageId:await source('Checks passed'),reason:'corner_check'});
      await expect.poll(()=>frames.some(frame=>frame.type==='commands'&&
        (frame.commands as {id:string}[]).some(item=>item.id===review!.id)),{timeout:5000}).toBe(true);
      expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[work!.id])).rows[0]?.state).toBe('pending');
      await call(WORKER,'postRoomMessage',{roomId:CORNER,requestId:work!.id,text:'The work is ready.'});
      expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[review!.id])).rows[0]?.state).toBe('pending');
      await call(REVIEWER,'postRoomMessage',{roomId:CORNER,requestId:review!.id,text:'The review is ready.'});
      expect((await db.query('SELECT state FROM agent_commands WHERE id=ANY($1::text[])',[[work!.id,review!.id]])).rows)
        .toEqual([{state:'complete'},{state:'complete'}]);
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      socket.close();
      await new Promise<void>(resolve=>socket.once('close',()=>resolve()));
    }
  });
});

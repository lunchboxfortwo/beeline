import { isAgentReachable } from '@beeline/api-contract/agent-access';
import type { AddressInfo } from 'node:net';
import { afterEach,describe,expect,it,vi } from 'vitest';
import WebSocket from 'ws';
import { createAgentCommand } from './agent-command.js';
import type { TokenAuth } from './auth.js';
import { ConnectionPresence } from './connection-presence.js';
import { MACHINE_SOCKET_PROTOCOL } from './daemon-live.js';
import { DaemonService } from './daemon-service.js';
import { type SqlDatabase } from './database.js';
import { LiveHub } from './live.js';
import type { PhoneService } from './phone-service.js';
import { ReleaseNotifier } from './release-notify.js';
import { ROUTER_COMMAND_SCHEMA } from './router-command-ledger.js';
import { createBeelineServer,type ServerOptions } from './server.js';
import { startQueuedCommand } from './test-fixtures/queued-turn.test-support.js';
import { migratedDatabase,PgliteDatabase } from './test-support.js';

const AGENT_A = 'a'.repeat(64);
const AGENT_B = 'b'.repeat(64);
const AGENT_RETIRED = 'c'.repeat(64);
const AGENT_UNKNOWN = 'd'.repeat(64);
const TOKENS: Record<string, string> = { bdt_a: AGENT_A, bdt_b: AGENT_B };

type Frame = Record<string, unknown>;
type Server = ReturnType<typeof createBeelineServer>;

const servers: Server[] = [];
const sockets: WebSocket[] = [];
const requestDatabases:PgliteDatabase[]=[];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for(const database of requestDatabases.splice(0))await database.close();
});

function auth(): TokenAuth {
  return {
    authenticateDaemon: vi.fn(async (token: string) => TOKENS[token] ?? null),
    retiredDaemonAgent: vi.fn(async (token: string) => (token === 'bdt_retired' ? AGENT_RETIRED : null)),
    authenticatePhone: vi.fn(async () => null),
  } as unknown as TokenAuth;
}

function daemonStub(): DaemonService {
  return {
    negotiateOwnedModel:vi.fn(async()=>({freeAgent:false})),
    execute: vi.fn(async (name: string, input: { roomId: string }, agentId: string) =>
      name === 'getAgentCommands'
        ? { commandProtocol: 2, commands: ['room-a', 'room-b', 'corner-a'].map(roomId => ({ id: `${agentId}-${roomId}`, roomId })) }
        : { items: [{ id: `${agentId.slice(0, 1)}-${input.roomId}-${Date.now()}` }] }),
  } as unknown as DaemonService;
}

async function start(overrides: Partial<ServerOptions> = {}): Promise<{ server: Server; port: number }> {
  const database=overrides.database??new PgliteDatabase();
  if(!overrides.database){requestDatabases.push(database as PgliteDatabase);await database.query(ROUTER_COMMAND_SCHEMA);}
  const server = createBeelineServer({
    database,
    auth: auth(),
    phone: { canReadRooms: vi.fn(async (ids: readonly string[]) => new Set(ids)) } as unknown as PhoneService,
    daemon: daemonStub(),
    live: new LiveHub(),
    mediaMaximumBytes: 1,
    ...overrides,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

/** A socket that records every frame, so a test can wait for one it has not seen yet. */
async function connect(port: number, protocol: string, options: WebSocket.ClientOptions = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, [protocol], options);
  sockets.push(socket);
  const frames: Frame[] = [];
  socket.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as Frame));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  const next = async (match: (frame: Frame) => boolean, timeout = 3_000): Promise<Frame> => {
    let found: Frame | undefined;
    await vi.waitFor(() => {
      found = frames.find(match);
      expect(found).toBeDefined();
    }, { timeout });
    return found!;
  };
  const send = (frame: Frame) => socket.send(JSON.stringify(frame));
  return { socket, frames, next, send };
}

const machine = (port: number, options?: WebSocket.ClientOptions) =>
  connect(port, MACHINE_SOCKET_PROTOCOL, options);

it('correlates a registration exception without logging the daemon token', async () => {
  const tokenAuth = auth();
  vi.mocked(tokenAuth.authenticateDaemon).mockRejectedValue(new Error('database checkout deadline'));
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const { port } = await start({ auth: tokenAuth });
    const client = await machine(port);
    client.send({ type: 'register', agentId: AGENT_A, token: 'bdt_private_fixture' });
    expect(await client.next(frame => frame.type === 'register-refused')).toMatchObject({
      agentId: AGENT_A, code: 'registration_failed',
    });
    const entry = error.mock.calls.find(([label]) => label === '[live] agent registration failed');
    expect(JSON.parse(String(entry?.[1]))).toMatchObject({ agentId: AGENT_A, stage: 'authentication' });
    expect(JSON.stringify(entry)).not.toContain('bdt_private_fixture');
  } finally { error.mockRestore(); }
});

async function register(
  client: Awaited<ReturnType<typeof machine>>,
  agentId: string,
  token: string,
): Promise<Frame> {
  const after = client.frames.length;
  client.send({ type: 'register', agentId, token, lifecycleId: `life-${agentId.slice(0, 1)}` });
  return client.next((frame) =>
    client.frames.indexOf(frame) >= after && frame.agentId === agentId &&
    (frame.type === 'registered' || frame.type === 'register-refused'));
}

describe('one machine socket for every agent on a helper machine', () => {
  it.each([true,false])('negotiates real machine usage/overlay registration only with opt-in and gates enabled=%s',async enabled=>{
    vi.stubEnv('BEELINE_NETWORK_ROUTER_V1',enabled?'1':'0');
    try{
      const owner='e'.repeat(64),execute=vi.fn(async()=>({id:'synthetic-receipt',createdAt:1}));
      const database={query:vi.fn(async()=>({rows:[{owner_id:owner}],rowCount:1})),transaction:vi.fn()} as unknown as SqlDatabase;
      const presence={instanceId:'synthetic-registration',holdServerConnection:()=>()=>undefined,renewLease:async()=>undefined,
        claimConnection:vi.fn(async()=>7),releaseConnection:vi.fn(async()=>undefined)} as unknown as ConnectionPresence;
      const {port}=await start({database,connectionPresence:presence,daemon:{execute,negotiateOwnedModel:async()=>({freeAgent:false})} as unknown as DaemonService});
      const client=await machine(port);
      client.send({type:'register',agentId:AGENT_A,token:'bdt_a',overlayV1:true,usageAccountV1:true});
      const registered=await client.next(frame=>frame.type==='registered'&&frame.agentId===AGENT_A);
      const capabilities=registered.capabilities as Record<string,unknown>;
      if(enabled){
        expect(capabilities).toMatchObject({overlayV1:true,usageAccountV1:true,usageOwnerId:owner,usageConnectionEpoch:7,usageConnectionId:expect.any(String)});
        client.send({type:'usage-operation',agentId:AGENT_A,requestId:'actual-registered-write',operation:'postAgentUsage',input:{agentId:AGENT_A,
          usage:{updatedAt:100,windows:[],context:{used:1,size:10}},usageSource:{v:1,ownerId:owner,revision:1,
            source:{connectionId:capabilities.usageConnectionId,epoch:capabilities.usageConnectionEpoch}}}});
        expect(await client.next(frame=>frame.type==='usage-result'&&frame.requestId==='actual-registered-write')).toMatchObject({result:{id:'synthetic-receipt'}});
        expect(execute).toHaveBeenCalledOnce();
      }else{expect(capabilities).not.toHaveProperty('overlayV1');expect(capabilities).not.toHaveProperty('usageAccountV1');}
      expect((await register(client,AGENT_B,'bdt_b')).capabilities).not.toHaveProperty('usageAccountV1');
    }finally{vi.unstubAllEnvs();}
  });

  it.each([MACHINE_SOCKET_PROTOCOL, 'bearer.bdt_a'])(
    'sends release pushes without Room or agent routing fields over %s', async (protocol) => {
      const live = new LiveHub();
      const database = { query: vi.fn(async () => ({ rows: [] })) } as unknown as SqlDatabase;
      const releaseNotify = new ReleaseNotifier(database, { live });
      const { port } = await start({ live, releaseNotify });
      const client = await connect(port, protocol);
      await client.next((frame) => frame.type === 'hello');
      if (protocol === MACHINE_SOCKET_PROTOCOL) await register(client, AGENT_A, 'bdt_a');
      live.publish({ type: 'helper-release', version: 'v0.1.35', sha: 'release-sha' });
      expect(await client.next((frame) => frame.type === 'helper-release')).toEqual({
        type: 'helper-release', version: 'v0.1.35', sha: 'release-sha',
      });
    },
  );

  it('authorizes each agent separately; a retired, invalid or mismatched token rejects only that agent', async () => {
    const live = new LiveHub();
    const { port } = await start({ live });
    const client = await machine(port);
    expect(await client.next((frame) => frame.type === 'hello')).toMatchObject({
      protocol: 'machine',
    });

    expect(await register(client, AGENT_RETIRED, 'bdt_retired')).toMatchObject({
      type: 'register-refused', code: 'agent_removed',
    });
    expect(await register(client, AGENT_UNKNOWN, 'bdt_unknown')).toMatchObject({
      type: 'register-refused', code: 'daemon_token_required',
    });
    // A token is only ever good for the agent it was issued to.
    client.send({ type: 'register', agentId: AGENT_B, token: 'bdt_a' });
    expect(await client.next((frame) => frame.type === 'register-refused' && frame.agentId === AGENT_B))
      .toMatchObject({ code: 'daemon_token_required' });
    expect(await register(client, AGENT_B, 'bdt_b')).toMatchObject({ type: 'registered' });
    expect(await register(client, AGENT_A, 'bdt_a')).toMatchObject({ type: 'registered' });

    // Frames naming an agent that never registered reach nobody.
    client.send({ type: 'subscribe-queue', agentId: AGENT_RETIRED, roomId: 'room-c' });
    client.send({ type: 'subscribe-queue', agentId: AGENT_B, roomId: 'room-b' });
    client.send({ type: 'subscribe-queue', agentId: AGENT_A, roomId: 'room-a' });
    await client.next((frame) => frame.type === 'commands' && frame.agentId === AGENT_B);
    await client.next((frame) => frame.type === 'commands' && frame.agentId === AGENT_A);

    const before = client.frames.length;
    live.publish({ type: 'invalidate', roomId: 'room-b', reason: 'postgres:agent_commands', targetAgentId: AGENT_B });
    const inbox = await client.next((frame, ) =>
      client.frames.indexOf(frame) >= before && frame.type === 'commands');
    expect(inbox).toMatchObject({ agentId: AGENT_B });
    expect(client.frames.some((frame) => frame.agentId === AGENT_RETIRED && frame.type !== 'register-refused'))
      .toBe(false);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it.each(['postgres:rooms', 'postgres:corner_facts'])('BRANCH-DERIVED: sends corner completion from archived state via %s', async reason => {
    const live = new LiveHub();
    const { port } = await start({ live });
    const client = await machine(port);
    await register(client, AGENT_A, 'bdt_a');
    client.send({ type: 'subscribe-queue', agentId: AGENT_A, roomId: 'corner-a' });
    await client.next(frame => frame.type === 'commands');
    live.publish({ type: 'invalidate', roomId: 'corner-a', reason, closeRequested: true });
    expect(await client.next(frame => frame.type === 'corner-complete')).toMatchObject({
      roomId: 'corner-a', agentId: AGENT_A,
    });
  });

  it('keeps all intake while one agent waits, without blocking its sibling', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const daemon = daemonStub();
    let first = true;
    vi.mocked(daemon.execute).mockImplementation(async (name, _input, agentId) => {
      if (name === 'getAgentCommands' && agentId === AGENT_A && first) { first = false; await held; }
      return { commandProtocol: 2, commands: [] } as never;
    });
    const { port } = await start({ daemon });
    const client = await machine(port);
    await register(client, AGENT_A, 'bdt_a'); await register(client, AGENT_B, 'bdt_b');
    try {
      const padding = 'x'.repeat(60 * 1024);
      for (let index = 0; index < 40; index++) client.send({ type: 'subscribe-queue', agentId: AGENT_A, padding });
      client.send({ type: 'subscribe-queue', agentId: AGENT_B });
      await client.next(frame => frame.type === 'commands' && frame.agentId === AGENT_B);
      expect(client.frames.some(frame => frame.type === 'live-refused')).toBe(false);
    } finally { release(); }
    await client.next(frame => frame.type === 'commands' && frame.agentId === AGENT_A);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('keeps one winner per agent across old per-agent sockets and machine registrations', async () => {
    const { port } = await start();
    const old = await connect(port, 'bearer.bdt_a');
    await old.next((frame) => frame.type === 'hello');
    const oldClosed = new Promise<void>((resolve) => old.socket.once('close', () => resolve()));
    const client = await machine(port);
    await register(client, AGENT_A, 'bdt_a');
    await register(client, AGENT_B, 'bdt_b');
    await oldClosed;

    // An old helper process that comes back takes the agent; its sibling stays.
    const returning = await connect(port, 'bearer.bdt_a');
    await returning.next((frame) => frame.type === 'hello');
    expect(await client.next((frame) => frame.type === 'unregistered' && frame.agentId === AGENT_A))
      .toMatchObject({ reason: 'replaced' });
    client.send({ type: 'subscribe-queue', agentId: AGENT_B, roomId: 'room-b' });
    await client.next((frame) => frame.type === 'commands' && frame.agentId === AGENT_B);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });
});

describe('machine connection preserves the queue through errors',()=>{
  it.each(['getAgentCommands'])('keeps the connection and subscriptions when %s fails',async operation=>{
    const live=new LiveHub(),daemon=daemonStub();const {port}=await start({live,daemon});const client=await machine(port);
    await register(client,AGENT_A,'bdt_a');client.send({type:'subscribe-queue',agentId:AGENT_A,roomId:'room-a'});
    await client.next(frame=>frame.type==='commands');const error=vi.spyOn(console,'error').mockImplementation(()=>undefined);
    const change=()=>live.publish({type:'invalidate',roomId:'room-a',reason:operation==='getAgentCommands'?'postgres:agent_commands':'postgres:messages',targetAgentId:AGENT_A,...(operation==='getRoomInbox'?{messageId:'changed-message'}:{})});
    try{
      vi.mocked(daemon.execute).mockRejectedValueOnce(new Error('transient read failure'));change();
      await vi.waitFor(()=>expect(error).toHaveBeenCalled());
      expect(client.socket.readyState).toBe(WebSocket.OPEN);expect(client.frames.some(frame=>frame.type==='unregistered')).toBe(false);
      const before=client.frames.length;change();
      await client.next(frame=>client.frames.indexOf(frame)>=before&&frame.type==='commands');
    }finally{error.mockRestore();}
  });
  it('keeps idle helpers connected without application pings or database reads',async()=>{
    const query=vi.fn();const {port}=await start({liveHeartbeatMs:10,database:{query,transaction:vi.fn()} as unknown as SqlDatabase});
    const client=await machine(port,{autoPong:false});const ping=vi.fn();client.socket.on('ping',ping);
    await new Promise(resolve=>setTimeout(resolve,100));expect(client.socket.readyState).toBe(WebSocket.OPEN);
    expect(ping).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalled();
  });
});

describe('held presence for a live connection', () => {
  const ROOM = '22222222-2222-4222-8222-222222222222';
  const WORKSPACE = '11111111-1111-4111-8111-111111111111';
  const HUMAN = 'e'.repeat(64);

  async function seeded() {
    const database = await migratedDatabase();
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner',NULL),($2,'agent','Bee','bee')`,
      [HUMAN, AGENT_A],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT_A, HUMAN]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [ROOM, WORKSPACE]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,$2,$3,'member'),($1,NULL,$3,'member'),($1,$2,$4,'owner')`,
      [WORKSPACE, ROOM, AGENT_A, HUMAN],
    );
    return database;
  }

  async function presenceBody(database: SqlDatabase) {
    return (
      await database.query<{ body: Record<string, unknown> }>(
        `SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence'`, [AGENT_A],
      )
    ).rows[0]?.body;
  }

  it.each(['room event', 'resync'])('delivers a committed tag after one failed push on the next %s', async recovery => {
    const database = await seeded();
    requestDatabases.push(database);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Sibling')`, [AGENT_B]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT_B, HUMAN]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'member'),($1,NULL,$3,'member')`, [WORKSPACE, ROOM, AGENT_B]);
    const live = new LiveHub(), daemon = new DaemonService(database, live);
    const presence = new ConnectionPresence(database, live);
    const execute = daemon.execute.bind(daemon);
    let failNextPush = false;
    const calls = vi.spyOn(daemon, 'execute').mockImplementation(async (...args) => {
      if (args[0] === 'getAgentCommands' && args[2] === AGENT_A && failNextPush) {
        failNextPush = false;
        throw new Error('transient read failure');
      }
      return execute(...args);
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { port } = await start({ database, live, daemon, connectionPresence: presence });
      const client = await machine(port);
      for (const [agentId, token] of [[AGENT_A, 'bdt_a'], [AGENT_B, 'bdt_b']]) {
        await register(client, agentId, token);
        client.send({ type: 'subscribe-queue', agentId, roomId: ROOM, inbox: false });
        await client.next(frame => frame.type === 'commands' && frame.agentId === agentId);
      }
      const command = (agentId: string) => createAgentCommand(database, {
        roomId: ROOM, agentId, sourceMessageId: null, reason: 'human_tag',
      });
      const claimed = (await command(AGENT_A))!;
      const owner = (await database.query<{ connectionId: string; epoch: number }>(
        `SELECT connection_id "connectionId",epoch::integer epoch FROM agent_connections WHERE agent_id=$1`, [AGENT_A],
      )).rows[0]!;
      await startQueuedCommand(daemon, { roomId: ROOM, commandId: claimed.id }, AGENT_A);
      const missed = (await command(AGENT_A))!, sibling = (await command(AGENT_B))!;
      // Both inserts have committed. No more commands are inserted to recover delivery.
      const change = (agentId: string) => live.publish({
        type: 'invalidate', roomId: ROOM, reason: 'postgres:agent_commands', targetAgentId: agentId,
      });
      failNextPush = true;
      change(AGENT_A);
      await vi.waitFor(() => expect(error).toHaveBeenCalledWith('[live] queue push failed', 'transient read failure'));
      await client.next(frame => frame.type === 'commands' && frame.error === 'transient read failure');
      const reads = () => calls.mock.calls.filter(([name, , agent]) => name === 'getAgentCommands' && agent === AGENT_A).length;
      const failedReads = reads();
      const delivered = (frame: Frame, id: string) => frame.type === 'commands' && Array.isArray(frame.commands) &&
        (frame.commands as { id: string }[]).some(command => command.id === id);
      change(AGENT_B);
      await client.next(frame => delivered(frame, sibling.id));
      expect(reads()).toBe(failedReads);
      expect(client.frames.some(frame => delivered(frame, missed.id))).toBe(false);
      if (recovery === 'resync') live.resync();
      else change(AGENT_A);
      const recovered = await client.next(frame => delivered(frame, missed.id));
      expect(recovered.commands).toEqual([expect.objectContaining({ id: claimed.id }),
        expect.objectContaining({ id: missed.id })]);
      // The running turn is listed only with its generation, for its helper to resume.
      expect(client.frames.flatMap(frame => frame.type === 'commands' && Array.isArray(frame.commands) ? frame.commands as { id: string; generationId?: string }[] : [])
        .filter(command => command.id === claimed.id).every(command => command.generationId === undefined)).toBe(true);
      expect(client.frames.filter(frame => delivered(frame, sibling.id)).length).toBeGreaterThan(0);
      expect(client.frames.some(frame => frame.type === 'unregistered')).toBe(false);
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
      expect((await database.query('SELECT state FROM agent_commands WHERE id=$1', [missed.id])).rows)
        .toEqual([{ state: 'pending' }]);
    } finally {
      error.mockRestore();
      await presence.stop();
    }
  });

  it.each(['update', 'crash', 'ordinary-close'] as const)('releases a %s socket silently and retains offline presence', async (kind) => {
    const database = await seeded();
    const live = new LiveHub();
    const presence = new ConnectionPresence(database, live);
    try {
      await database.query(`UPDATE agents SET machine_id='test-machine',machine_name='Test' WHERE agent_id=$1`, [AGENT_A]);
      await database.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [WORKSPACE, HUMAN]);
      const { port } = await start({ database, live, connectionPresence: presence });
      const client = await machine(port);
      await register(client, AGENT_A, 'bdt_a');
      if (kind === 'update') client.socket.close(4002, 'helper-update');
      else if (kind === 'crash') client.socket.terminate();
      else client.socket.close();
      await vi.waitFor(async () => expect(await presenceBody(database)).toMatchObject({ status: 'offline', held: false }));
      expect((await database.query(`SELECT 1 FROM messages WHERE card_type='machine-offline'`)).rowCount)
        .toBe(0);
      expect((await database.query(`SELECT 1 FROM agent_connections WHERE agent_id=$1 AND released_at IS NOT NULL`, [AGENT_A])).rowCount).toBe(1);
    } finally {
      await presence.stop();
      await database.close();
    }
  });

  it('stays online past the 90-second horizon while held, and goes offline when the socket dies', async () => {
    const database = await seeded();
    const live = new LiveHub();
    const presence = new ConnectionPresence(database, live);
    try {
      const { port } = await start({ database, live, connectionPresence: presence });
      const client = await machine(port);
      await register(client, AGENT_A, 'bdt_a');
      expect(await presenceBody(database)).toMatchObject({ status: 'online', held: true });

      // Ten idle minutes: no HTTP evidence, no Room event, no database write.
      await database.query(
        `UPDATE live_outputs SET updated_at=now()-interval '10 minutes',
           body=body || jsonb_build_object('observedAt',(extract(epoch FROM now())::bigint-600))
         WHERE agent_id=$1 AND kind='presence'`,
        [AGENT_A],
      );
      const daemon = new DaemonService(database, live);
      expect((await daemon.releaseReadiness()).daemons).toEqual([
        expect.objectContaining({ agentPubkey: AGENT_A, state: 'ready' }),
      ]);
      const body = await presenceBody(database);
      expect(isAgentReachable('online', Number(body?.observedAt) * 1000, Date.now(), body?.held === true))
        .toBe(true);

      client.socket.terminate();
      await vi.waitFor(async () =>
        expect(await presenceBody(database)).toMatchObject({ status: 'offline', held: false }));
      expect((await daemon.releaseReadiness()).daemons).toEqual([
        expect.objectContaining({ agentPubkey: AGENT_A, state: 'offline' }),
      ]);
    } finally {
      await presence.stop();
      await database.close();
    }
  });

  it('lets the newest connection win across two server instances; a late close of the old one changes nothing', async () => {
    const database = await seeded();
    // One hub stands in for the PostgreSQL listener both instances share.
    const live = new LiveHub();
    const first = new ConnectionPresence(database, live, { instanceId: 'server-1' });
    const second = new ConnectionPresence(database, live, { instanceId: 'server-2' });
    try {
      const one = await start({ database, live, connectionPresence: first });
      const two = await start({ database, live, connectionPresence: second });
      const older = await machine(one.port);
      await register(older, AGENT_A, 'bdt_a');
      const newer = await machine(two.port);
      await register(newer, AGENT_A, 'bdt_a');
      expect(await older.next((frame) => frame.type === 'unregistered' && frame.agentId === AGENT_A))
        .toMatchObject({ reason: 'replaced' });
      const held = await presenceBody(database);
      expect(held).toMatchObject({ status: 'online', held: true });

      // The old machine's socket closes late: the newer connection keeps the agent online.
      older.socket.terminate();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await presenceBody(database)).toMatchObject({
        status: 'online', held: true, connectionId: held?.connectionId,
      });
      const connection = (await database.query<{ epoch: string; instance_id: string }>(
        `SELECT epoch,instance_id FROM agent_connections WHERE agent_id=$1`, [AGENT_A],
      )).rows[0];
      expect(connection).toMatchObject({ instance_id: 'server-2' });
      expect(Number(connection?.epoch)).toBe(2);
    } finally {
      await first.stop();
      await second.stop();
      await database.close();
    }
  });

  it('survives a server restart: the connection stays held until the helper reconnects', async () => {
    const database = await seeded();
    const live = new LiveHub();
    const restarting = new ConnectionPresence(database, live, { instanceId: 'server-old' });
    const successor = new ConnectionPresence(database, live, { instanceId: 'server-new' });
    try {
      const old = await start({ database, live, connectionPresence: restarting });
      const client = await machine(old.port);
      await register(client, AGENT_A, 'bdt_a');
      // A deploy closes the server; its sockets end but nothing goes offline.
      await new Promise<void>((resolve) => old.server.close(() => resolve()));
      servers.splice(servers.indexOf(old.server), 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await presenceBody(database)).toMatchObject({ status: 'online', held: true });

      const next = await start({ database, live, connectionPresence: successor });
      const back = await machine(next.port);
      await register(back, AGENT_A, 'bdt_a');
      expect(await presenceBody(database)).toMatchObject({ status: 'online', held: true });
      const rows = (await database.query<{ instance_id: string; epoch: string | number }>(
        `SELECT instance_id,epoch FROM agent_connections`,
      )).rows;
      expect(rows.map((row) => [row.instance_id, Number(row.epoch)])).toEqual([['server-new', 2]]);
    } finally {
      await restarting.stop();
      await successor.stop();
      await database.close();
    }
  });
});

it('F14 unrelated turn/activity/usage changes make zero daemon inbox reads', async () => {
  const live=new LiveHub(),daemon=daemonStub();
  const {port}=await start({live,daemon});const client=await machine(port);
  await register(client,AGENT_A,'bdt_a');
  client.send({type:'subscribe-queue',agentId:AGENT_A,roomId:'room-a'});
  await client.next(frame=>frame.type==='commands'&&frame.agentId===AGENT_A);
  vi.mocked(daemon.execute).mockClear();
  for(const table of ['agent_turns','agent_activity','agent_usage','agents','agent_grants','corner_follows'])
    live.publish({type:'invalidate',roomId:'room-a',reason:`postgres:${table}`,messageId:'another-agent-source'});
  const after=client.frames.length;
  live.publish({type:'invalidate',roomId:'room-a',reason:'postgres:agent_commands',targetAgentId:AGENT_A});
  await client.next(frame=>client.frames.indexOf(frame)>=after&&frame.type==='commands');
  expect(vi.mocked(daemon.execute).mock.calls.filter(([name])=>name==='getRoomInbox')).toHaveLength(0);
  expect(vi.mocked(daemon.execute).mock.calls.filter(([name])=>name==='getAgentCommands')).toHaveLength(1);
});

it('carries ordinary daemon families through the registered machine owner with no HTTP, sharing old-wire service behavior', async () => {
  const {DaemonApiClient} = await import('../../body/src/daemon-api-client.js');
  const daemon = daemonStub();
  const token = `bdt_${'a'.repeat(43)}`;
  const tokenAuth = auth();
  vi.mocked(tokenAuth.authenticateDaemon).mockImplementation(async candidate => candidate === token ? AGENT_A : null);
  const {port} = await start({daemon, auth: tokenAuth});
  const origin = `http://127.0.0.1:${port}`;
  const http = vi.fn<typeof fetch>();
  const api = new DaemonApiClient(origin, token, AGENT_A, http);
  try {
    const input = {agentId: AGENT_A};
    await api.execute('getAgentConfiguration', input);
    await api.execute('listRooms', input);
    await api.execute('postAgentMachineReport', {agentId: AGENT_A, report: {}} as never);
    expect(http).not.toHaveBeenCalled();
    expect(vi.mocked(daemon.execute).mock.calls.map(call => [call[0], call[2]]))
      .toEqual([['getAgentConfiguration', AGENT_A], ['listRooms', AGENT_A], ['postAgentMachineReport', AGENT_A]]);
    const old = await fetch(`${origin}/v1/daemon/operations/getAgentConfiguration`, {
      method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify(input),
    });
    expect(old.status).toBe(200);
    expect(vi.mocked(daemon.execute).mock.calls.at(-1)).toEqual(['getAgentConfiguration', input, AGENT_A]);
  } finally { api.closeLive(); }
});

it('serves controls and subscriptions while 65 ordinary operations await external work', async () => {
  let finish!: (value: unknown) => void;
  const held = new Promise(resolve => { finish = resolve; });
  const daemon = daemonStub();
  vi.mocked(daemon.execute).mockImplementation(async (name: string) => {
    if (name === 'searchMcpRegistry') return held;
    if (name === 'getAgentCommands') return {commandProtocol: 1, commands: []};
    return {id: 'done', createdAt: 1};
  });
  const {port} = await start({daemon});
  const client = await machine(port);
  client.send({type: 'register', agentId: AGENT_A, token: 'bdt_a', daemonOperationsV1: true});
  expect(await client.next(frame => frame.type === 'registered')).toMatchObject({capabilities: {daemonOperationsV1: true}});
  try {
    for (let index = 0; index < 65; index++)
      client.send({type: 'daemon-operation', agentId: AGENT_A, requestId: `held-${index}`, operation: 'searchMcpRegistry', input: {roomId: 'room', query: 'proof'}});
    client.send({type: 'daemon-operation', agentId: AGENT_A, requestId: 'stop', operation: 'stopAgentTurn', input: {roomId: 'room'}});
    expect(await client.next(frame => frame.requestId === 'stop')).toMatchObject({type: 'daemon-operation-result', result: {id: 'done'}});
    client.send({type: 'subscribe-queue', agentId: AGENT_A, requestId: 'subscribe', roomId: 'room', inbox: false});
    await client.next(frame => frame.type === 'commands');
    await vi.waitFor(() => expect(vi.mocked(daemon.execute).mock.calls.filter(([name]) => name === 'searchMcpRegistry')).toHaveLength(65));
    expect(client.frames.some(frame => String(frame.requestId).startsWith('held-'))).toBe(false);
  } finally { finish({id: 'wake', createdAt: 1}); }
  expect(await client.next(frame => frame.requestId === 'held-64')).toMatchObject({result: {id: 'wake'}});
});

it('rejects unknown operations before effects', async () => {
  const daemon = daemonStub();
  const {port} = await start({daemon});
  const client = await machine(port);
  client.send({type: 'register', agentId: AGENT_A, token: 'bdt_a', daemonOperationsV1: true});
  await client.next(frame => frame.type === 'registered');
  for (const [operation, status] of [['notAnOperation', 400]] as const) {
    client.send({type: 'daemon-operation', agentId: AGENT_A, requestId: operation, operation, input: {}});
    expect(await client.next(frame => frame.requestId === operation)).toMatchObject({status});
  }
  expect(daemon.execute).not.toHaveBeenCalled();
});

it('publishes a final reply over 64 KB without dropping its tool steps', async () => {
  const daemon = daemonStub();
  vi.mocked(daemon.execute).mockResolvedValue({id:'final-reply',createdAt:1});
  const {port} = await start({daemon});
  const client = await machine(port);
  client.send({type:'register',agentId:AGENT_A,token:'bdt_a',daemonOperationsV1:true});
  await client.next(frame => frame.type === 'registered');
  const input = {roomId:'room',requestId:'turn',text:'Finished.',steps:Array.from({length:70},(_,index) => ({
    kind:'tool',title:`Read ${index}`,operation:'read',status:'completed',output:'a'.repeat(3000),
  }))};
  expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(64 * 1024);
  client.send({type:'daemon-operation',agentId:AGENT_A,requestId:'publish',operation:'postRoomMessage',input});
  expect(await client.next(frame => frame.requestId === 'publish')).toMatchObject({
    type:'daemon-operation-result',result:{id:'final-reply'},
  });
  expect(daemon.execute).toHaveBeenCalledWith('postRoomMessage',input,AGENT_A,undefined);

  client.frames.splice(0);
  client.send({type:'request-result',agentId:AGENT_A,requestId:'publish'});
  expect(await client.next(frame => frame.requestId === 'publish')).toMatchObject({type:'request-missing'});
  client.frames.splice(0);

  client.send({type:'daemon-operation',agentId:AGENT_A,requestId:'publish',operation:'postRoomMessage',input});
  expect(await client.next(frame => frame.requestId === 'publish')).toMatchObject({result:{id:'final-reply'}});
  // The native answer owner handles this replay; the transport cannot cap or claim it.
  expect(daemon.execute).toHaveBeenCalledTimes(2);
});

it('publishes an answer without consulting the generic RPC admission ledger', async () => {
  const database = new PgliteDatabase();
  requestDatabases.push(database);
  const query = database.query.bind(database);
  vi.spyOn(database,'query').mockImplementation((sql,values) => {
    if(sql.includes('INSERT INTO router_commands')) return Promise.reject(new Error('fixture admission failure'));
    return query(sql,values);
  });
  const error = vi.spyOn(console,'error').mockImplementation(() => undefined);
  try {
    const daemon = daemonStub();
    const {port} = await start({database,daemon});
    const client = await machine(port);
    client.send({type:'register',agentId:AGENT_A,token:'bdt_a',daemonOperationsV1:true});
    await client.next(frame => frame.type === 'registered');
    client.send({type:'daemon-operation',agentId:AGENT_A,requestId:'publish',operation:'postRoomMessage',
      input:{roomId:'room',requestId:'turn',text:'Finished.'}});
    expect(await client.next(frame => frame.requestId === 'publish')).toMatchObject({
      type:'daemon-operation-result',result:expect.anything(),
    });
    expect(daemon.execute).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  } finally { error.mockRestore(); }
});

it('binds helper credentials once at registration and keeps the established session delivering', async () => {
  const tokenAuth = auth(), daemon = daemonStub();
  const {port} = await start({auth: tokenAuth, daemon});
  const client = await machine(port);
  client.send({type: 'register', agentId: AGENT_A, token: 'bdt_a', daemonOperationsV1: true});
  await client.next(frame => frame.type === 'registered');
  vi.mocked(tokenAuth.authenticateDaemon).mockResolvedValue(null);
  client.send({type: 'daemon-operation', agentId: AGENT_A, requestId: 'established', operation: 'listRooms', input: {agentId: AGENT_A}});
  expect(await client.next(frame => frame.requestId === 'established')).toMatchObject({result:expect.anything()});
  expect(tokenAuth.authenticateDaemon).toHaveBeenCalledTimes(1);
  expect(daemon.execute).toHaveBeenCalledTimes(1);
});

it('dispatches turn controls with the registered machine owner through the ordinary request path',async()=>{
  const database=new PgliteDatabase();await database.query(ROUTER_COMMAND_SCHEMA);
  const daemon={execute:vi.fn(async()=>({id:'ok',createdAt:1})),negotiateOwnedModel:async()=>({freeAgent:false})} as unknown as DaemonService;
  const presence={instanceId:'operation-owner',renewLease:async()=>undefined,claimConnection:async()=>7,releaseConnection:async()=>{}} as unknown as ConnectionPresence;
  try{
    const {port}=await start({daemon,database,connectionPresence:presence});const client=await machine(port);
    client.send({type:'register',agentId:AGENT_A,token:'bdt_a',daemonOperationsV1:true,queueV1:true});
    const registered=await client.next(frame=>frame.type==='registered');
    client.send({type:'daemon-operation',agentId:AGENT_A,requestId:'start',operation:'startAgentTurn',input:{roomId:'room',requestId:'command'}});
    await client.next(frame=>frame.requestId==='start');
    expect(daemon.execute).toHaveBeenCalledWith('startAgentTurn',{roomId:'room',requestId:'command'},AGENT_A,undefined);
  }finally{await database.close();}
});


it('accepts more than eight machine sockets and a batch of more than 64 owned agents', async () => {
  const tokenAuth = auth();
  vi.mocked(tokenAuth.authenticateDaemon).mockImplementation(async token => token.startsWith('bdt_') ? token.slice(4) : null);
  const { port } = await start({ auth: tokenAuth });
  const connected = [];
  for (let index = 0; index < 9; index++) connected.push(await machine(port));
  expect(connected.every(client => client.socket.readyState === WebSocket.OPEN)).toBe(true);
  const agents = Array.from({ length: 65 }, (_, index) => {
    const agentId = index.toString(16).padStart(64, '0');
    return { agentId, token: `bdt_${agentId}` };
  });
  connected[0]!.send({ type: 'register-machine', agents });
  await vi.waitFor(() => expect(connected[0]!.frames.filter(frame => frame.type === 'registered')).toHaveLength(65));
  expect(connected[0]!.frames.some(frame => frame.type === 'register-refused')).toBe(false);
});

it('sends a queued answer despite an existing machine output backlog', async () => {
  const { machineConnectionOutput } = await import('./machine-connection.js');
  const send = vi.fn();
  const client = { readyState: WebSocket.OPEN, OPEN: WebSocket.OPEN, bufferedAmount: 32 * 1024 * 1024, send };
  expect(machineConnectionOutput(client as unknown as WebSocket)('stored answer')).toBe(true);
  expect(send).toHaveBeenCalledWith('stored answer');
});


it('registers a ready agent while its batch sibling is still authenticating', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const tokenAuth = auth();
  vi.mocked(tokenAuth.authenticateDaemon).mockImplementation(async token => {
    if (token === 'bdt_a') await held;
    return TOKENS[token] ?? null;
  });
  const { port } = await start({ auth: tokenAuth });
  const client = await machine(port);
  try {
    client.send({ type: 'register-machine', agents: [{agentId:AGENT_A,token:'bdt_a'},{agentId:AGENT_B,token:'bdt_b'}] });
    expect(await client.next(frame => frame.type === 'registered' && frame.agentId === AGENT_B)).toMatchObject({ agentId: AGENT_B });
    expect(client.frames.some(frame => frame.type === 'registered' && frame.agentId === AGENT_A)).toBe(false);
  } finally { release(); }
  await client.next(frame => frame.type === 'registered' && frame.agentId === AGENT_A);
});

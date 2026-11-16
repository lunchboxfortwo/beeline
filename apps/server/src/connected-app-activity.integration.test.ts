import { startQueuedCommand, startQueuedTurn } from './test-fixtures/queued-turn.test-support.js';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { createAgentCommand } from './agent-command.js';
import { PhoneService } from './phone-service.js';
import { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';
import { claimAgentConnection, releaseAgentConnection } from './connection-presence.js';
import { RoomsMcpAgentTools, pendingMcpWakes } from './rooms-mcp-agent.js';
import { LiveHub } from './live.js';

const H = 'a'.repeat(64), APP = 'b'.repeat(64), MACHINE = 'c'.repeat(64), SENDER = 'd'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
let db: PgliteDatabase, phone: PhoneService, daemon: DaemonService;
beforeAll(async () => {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','App','app'),
    ($3,'agent','Machine','machine'),($4,'agent','Sender','sender')`, [H, APP, MACHINE, SENDER]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$4),($2,$4),($3,$4)`, [APP, MACHINE, SENDER, H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'R1')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Room'),($2,$3,'Origin')`, [R, C, W]);
  await db.query(`UPDATE rooms SET parent_id=$1 WHERE id=$2`, [R, C]);
  for (const who of [H, APP, MACHINE, SENDER]) for (const room of [null, R])
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`, [W, room, who]);
  await db.query(`INSERT INTO rooms_mcp_clients(id,name,redirects) VALUES('r1-app','R1 app','[]')`);
  await db.query(`INSERT INTO rooms_mcp_members(client_id,owner_id,member_id,model_label)
    VALUES('r1-app',$1,$2,'ChatGPT')`, [H, APP]);
  phone = new PhoneService(db, 'http://test');
  daemon = new DaemonService(db, new LiveHub());
}, 30_000);
afterAll(async () => db.close());
beforeEach(async () => {
  vi.restoreAllMocks();
  await db.query('DELETE FROM agent_commands');
  await db.query('DELETE FROM agent_turns');
});
const report = (text: string, agentId = APP, authorId = SENDER, origin = C, id?: string) => createAgentCommand(db, {
  id, roomId: R, agentId, sourceMessageId: null, reason: 'report',
  privatePayload: { kind: 'report', text, authorId, fromRoomId: origin, originCornerId: origin },
});
const working = async (agentId: string) => (await phone.readRoom(R, H))!.latestAgentTurns
  .filter(t => t.agentPubkey === agentId && t.status === 'working');

it('R1: dispatch waits for pickup, while claimed machine and MCP turns are visible', async () => {
  await report('needs-decision: approve the numbered list');
  const machine = await report('needs-decision: another decision', MACHINE);
  expect(await working(APP)).toEqual([]);
  expect(await working(MACHINE)).toEqual([]);
  await startQueuedCommand(daemon, { roomId:R, commandId:machine!.id }, MACHINE);
  expect(await working(MACHINE)).toEqual([expect.objectContaining({  })]);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const execute = daemon.execute.bind(daemon);
  vi.spyOn(daemon, 'execute').mockImplementation(async (...args) => {
    if (args[0] === 'searchInstitutionalHistory') {
      entered();
      await gate;
      return { items: [] } as never;
    }
    return execute(...args);
  });
  const call = new RoomsMcpAgentTools(db, daemon).call(APP, 'search', { address: R, scope: 'history', query: 'numbered list' });
  await started;
  try {
    expect(await working(APP)).toEqual([]);
  } finally { release(); await call; }
  expect(await working(APP)).toEqual([]);
});

it('R1: three reports about one unhandled decision remain ordered and independently owed', async () => {
  const first = await report('needs-decision: approve the list');
  const second = await report('needs-decision: all checks passed; approve the list');
  const third = await report('needs-decision: latest context for the same approval');
  expect((await db.query(`SELECT id,state,cancellation_reason FROM agent_commands ORDER BY inbox_sequence`)).rows).toEqual([
    { id: first!.id, state: 'pending', cancellation_reason: null },
    { id: second!.id, state: 'pending', cancellation_reason: null },
    { id: third!.id, state: 'pending', cancellation_reason: null },
  ]);
  expect((await db.query(`SELECT private_payload->>'text' text FROM agent_commands WHERE state='pending'`)).rows)
    .toEqual([{text:'needs-decision: approve the list'},{text:'needs-decision: all checks passed; approve the list'},{text:'needs-decision: latest context for the same approval'}]);
  // Replaying an already accepted id cannot cancel its replacement.
  await report('needs-decision: approve the list', APP, SENDER, C, first!.id);
  expect((await db.query(`SELECT id FROM agent_commands WHERE state='pending'`)).rows).toEqual([{id:first!.id},{id:second!.id},{id:third!.id}]);
});

it('R1: status, sender, origin and recipient distinguish new reports; claimed work survives', async () => {
  const claimed = await report('needs-decision: active decision');
  await db.transaction(tx => startQueuedTurn(tx, R, APP, claimed!.id));
  expect(await working(APP)).toEqual([expect.objectContaining({  })]);
  await report('needs-decision: newer context');
  await report('blocked: different status');
  await report('needs-decision: different sender', APP, MACHINE);
  await report('needs-decision: different origin', APP, SENDER, R);
  await report('needs-decision: different recipient', MACHINE);
  expect((await db.query(`SELECT state,count(*)::int n FROM agent_commands GROUP BY state ORDER BY state`)).rows)
    .toEqual([{state:'pending',n:6}]);
});

it('R1: a claimed report survives a dropped socket and a helper restart, unsuperseded; handled reports and machine queues keep their history', async () => {
  await claimAgentConnection(db,new LiveHub(),APP,{}, {connectionId:'first-helper',instanceId:'helper-fixture'});
  const expired = await report('needs-decision: old context');
  await startQueuedCommand(daemon, { roomId:R, commandId:expired!.id }, APP);
  await db.query(`UPDATE agent_commands SET created_at=now()-interval '1 day' WHERE id=$1`,[expired!.id]);
  await report('needs-decision: context while the first is claimed');
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[expired!.id])).rows).toEqual([{state:'pending'}]);
  const source=(await db.query<{connection_id:string}>('SELECT connection_id FROM agent_connections WHERE agent_id=$1',[APP])).rows[0]!;
  await releaseAgentConnection(db,new LiveHub(),APP,source.connection_id);
  // A dropped socket keeps the running turn; the same helper continues it.
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[expired!.id])).rows).toEqual([{state:'pending'}]);
  await claimAgentConnection(db,new LiveHub(),APP,{lifecycleId:'restarted-helper'},
    {connectionId:'restarted-helper',instanceId:'helper-fixture'});
  // Replacement ends the old execution; its independently owed report is redelivered.
  const current=await report('needs-decision: new context after a helper restart');
  expect((await db.query(`SELECT status,ended_at FROM agent_turns WHERE request_id=$1`, [expired!.turn_request_id])).rows)
    .toEqual([{ status: 'cancelled', ended_at: expect.any(Date) }]);
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[expired!.id])).rows).toEqual([{state:'pending'}]);
  await startQueuedCommand(daemon, { roomId:R, commandId:expired!.id }, APP);
  expect((await db.query(`SELECT status,ended_at FROM agent_turns WHERE request_id=$1`, [expired!.turn_request_id])).rows)
    .toEqual([{ status: 'working', ended_at: null }]);
  await db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE id=$1`, [current!.id]);
  await report('needs-decision: a later decision after handling');
  expect((await db.query(`SELECT state FROM agent_commands WHERE id=$1`, [current!.id])).rows).toEqual([{ state: 'complete' }]);
  await report('needs-decision: machine decision', MACHINE);
  await report('needs-decision: another machine update', MACHINE);
  expect((await db.query(`SELECT count(*)::int n FROM agent_commands WHERE agent_id=$1 AND state='pending'`, [MACHINE])).rows)
    .toEqual([{ n: 2 }]);
});

it('every independent pending wake is readable beyond the retired 30-command page',async()=>{
  for(let index=0;index<36;index++)await report(`Update ${index}`,MACHINE);
  const wakes=await pendingMcpWakes(db,MACHINE);
  expect(wakes).toHaveLength(36);
  expect(new Set(wakes.map(wake=>wake.id)).size).toBe(36);
  for(const wake of wakes)expect(wake).not.toHaveProperty('deliveryVersion');
  // The helper rejects a wake frame without these fields, which stops every delivery to a joined session.
  for(const wake of wakes){for(const field of ['id','address','reason'] as const)expect(typeof wake[field],field).toBe('string');expect(wake.createdAt).toBeTruthy();}
});

import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { migrate, type SqlDatabase } from './database.js';
import { PgliteDatabase, insertCornerFacts } from './test-support.js';
import { HelperDaemonService } from './test-fixtures/helper-daemon.js';
import { startQueuedCommand } from './test-fixtures/queued-turn.test-support.js';
import { createAgentCommand, readAgentCommands } from './agent-command.js';
import { refreshCornerAttention, runCornerAttention } from './corner-attention.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { cornerIdleSql } from './corner-idle.js';
import { loadCornerWaiting } from './corner-waiting.js';
import { modelText } from './message-origin.js';

const WS = '11111111-1111-4111-8111-111111111111', ROOM = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const HUMAN = 'a'.repeat(64), COMMANDER = 'b'.repeat(64), WORKER = 'c'.repeat(64), REVIEWER = 'd'.repeat(64);
let db: SqlDatabase, pg: PgliteDatabase, daemon: HelperDaemonService, phone: PhoneService;
beforeAll(async () => {
  pg = new PgliteDatabase(); db = pg; await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Commander','commander'),
    ($3,'agent','Worker','worker'),($4,'agent','Reviewer','reviewer')`, [HUMAN, COMMANDER, WORKER, REVIEWER]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$4),($2,$4),($3,$4)', [COMMANDER, WORKER, REVIEWER, HUMAN]);
  daemon = new HelperDaemonService(db, new LiveHub()); phone = new PhoneService(db, 'http://test');
}, 30_000);
afterAll(async () => pg.close());
beforeEach(async () => {
  await db.query('DELETE FROM workspaces'); await db.query('DELETE FROM agent_connections');
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Worker blocks')", [WS]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by,reviewer_agent_id)
    VALUES($1,$2,'Room',$3,$4)`, [ROOM, WS, HUMAN, REVIEWER]);
  for (const member of [HUMAN, COMMANDER, WORKER, REVIEWER]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [WS, member, ROOM]);
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by)
    VALUES($1,$2,$3,'Corner',$4)`, [C, WS, ROOM, COMMANDER]);
  await insertCornerFacts(db, { cornerId: C, ownerAgentId: WORKER, commissionedBy: HUMAN });
  // Like the incident, the worker is the creator; the opening route still names the commander.
  await db.query("UPDATE rooms SET created_by=$2,created_at=now()-interval '1 day' WHERE id=$1", [C, WORKER]);
});
const state = async () => { await refreshCornerAttention(db, C); return (await daemon.execute('getCornerRestoreState', { cornerId: C }, WORKER)).state; };
async function input(agent = WORKER) {
  const command = (await createAgentCommand(db, { id: randomUUID(), roomId: C, agentId: agent,
    sourceMessageId: null, reason: 'order', privatePayload: { kind: 'order', authorId: agent === WORKER ? COMMANDER : HUMAN,
      fromRoomId: ROOM, text: modelText('Continue.') } }))!;
  await startQueuedCommand(daemon, { roomId: C, commandId: command.id }, agent);
  return { roomId: C, requestId: command.turn_request_id };
}
const idleReports = async () => (await db.query(`SELECT id FROM agent_commands WHERE room_id=$1 AND reason='report'
  AND private_payload->>'authorId'=$2 AND private_payload->>'text' LIKE 'blocked: Thread % is idle.%'`, [C, SYSTEM_IDENTITY_ID])).rows;
async function reactions(count = 8) {
  for (let i = 0; i < count; i++) {
    await refreshCornerAttention(db, C);
    const report = (await readAgentCommands(db, COMMANDER, C)).commands.find(c => c.source.authorId === SYSTEM_IDENTITY_ID && c.source.body.includes(' is idle.'));
    if (!report) break;
    await startQueuedCommand(daemon, { roomId: C, commandId: report.id }, COMMANDER);
    await daemon.execute('postRoomMessage', { roomId: C, requestId: report.turnRequestId, text: 'Still waiting on secrets.' }, COMMANDER);
  }
}
it('IDLE-BUDGET: commander reactions produce exactly one notice until a person event', async () => {
  await reactions(); await runCornerAttention(db);
  expect(await idleReports()).toHaveLength(1);
  await db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status)
    SELECT $1,'legacy-reaction-'||n,$2,'complete' FROM generate_series(1,728) n`, [C, COMMANDER]);
  await runCornerAttention(db);
  expect(await idleReports()).toHaveLength(1);
  await daemon.execute('postRoomMessage', { ...await input(), text: 'Worker finished more work.' }, WORKER);
  await reactions();
  expect(await idleReports()).toHaveLength(1); // Worker output is not a budget reset.
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation)
    VALUES('person-input',$1,$2,'Use option one.','message')`, [C, HUMAN]);
  await reactions();
  expect(await idleReports()).toHaveLength(2);
});
it.each(['blocked', 'needs_decision'] as const)('WORKER-BLOCK: real %s report survives orders, turns and prose until worker outcome', async status => {
  const turn = await input();
  await daemon.execute('report', { ...turn, status, text: 'The router-login secrets are missing.' }, WORKER);
  expect(await state()).toBe('waiting');
  expect((await db.query("SELECT id FROM messages WHERE card_type='agent-command'")).rows).toEqual([]);
  const next = await input(); // Commander orders the worker; a wake is not work output.
  expect(await state()).toBe('waiting');
  await daemon.execute('postRoomMessage', { ...next, text: 'I confirmed the decision. Still waiting on secrets.' }, WORKER);
  await reactions();
  expect(await state()).toBe('waiting');
  expect(await idleReports()).toHaveLength(0);
  const finished = await input();
  await daemon.execute('report', { ...finished, status: status === 'blocked' ? 'done' : 'failed', text: 'The task is complete.' }, WORKER);
  expect(await state()).toBe('idle');
});
it('WORKER-ROLE: a worker-created corner displays worker activity and excludes commander-only activity', async () => {
  const commander = await input(COMMANDER);
  expect(await state()).toBe('idle');
  await daemon.execute('postRoomMessage', { ...commander, text: 'Acknowledged.' }, COMMANDER);
  const worker = await input();
  expect(await state()).toBe('working');
  await daemon.execute('postRoomMessage', { ...worker, text: 'Finished.' }, WORKER);
  expect(await state()).toBe('idle');
});
it('WORKER-BLOCK: native ask cards replace the block and remain open through commander chatter', async () => {
  await daemon.execute('report', { ...await input(), status: 'blocked', text: 'Need a decision.' }, WORKER);
  const ask = await input();
  const choice = await daemon.execute('askRoomChoice', { ...ask, prompt: 'Which scope?',
    options: [{ label: 'One', consequence: 'Continue' }, { label: 'Two', consequence: 'Stop' }] }, WORKER);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation)
    VALUES('commander-chatter',$1,$2,'Use option one.','message'),('person-chatter',$1,$3,'Looking.','message')`, [C, COMMANDER, HUMAN]);
  expect(await state()).toBe('waiting');
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]).toMatchObject({ state: 'waiting' });
  await phone.execute('answerChoice', { choiceId: choice.choiceId, optionId: 'A' }, HUMAN);
  await daemon.execute('postRoomMessage', { ...ask, text: 'Continuing with that choice.' }, WORKER);
  expect(await state()).toBe('working'); // The native decision queued its own continuation.
});

it('counts a notice sent before the thread wording change against the same idle budget', async () => {
  await reactions();
  const [notice] = await idleReports();
  expect(notice).toBeDefined();
  await db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{text}',
    to_jsonb(replace(private_payload->>'text','blocked: Thread ','blocked: Corner '))) WHERE id=$1`, [notice!.id]);
  expect((await db.query(cornerIdleSql('$1'), [C])).rows[0]).toMatchObject({ idle_report_count: 1 });
  await runCornerAttention(db); await refreshCornerAttention(db, C);
  expect((await db.query(`SELECT id FROM agent_commands WHERE room_id=$1 AND reason='report'
    AND private_payload->>'authorId'=$2`, [C, SYSTEM_IDENTITY_ID])).rows).toHaveLength(1);
});

it('IDLE-BUDGET: only human grant decisions and human hold releases replenish notices', async () => {
  await reactions(); expect(await idleReports()).toHaveLength(1);
  const grant = randomUUID();
  await db.query(`INSERT INTO agent_grants(id,agent_id,workspace_id,room_id,kind,target,reason,requested_by,status,decided_by,decided_at)
    VALUES($1,$2,$3,$4,'command','true','Proof',$5,'approved',$6,clock_timestamp())`, [grant, WORKER, WS, C, HUMAN, COMMANDER]);
  await reactions(); expect(await idleReports()).toHaveLength(1);
  await db.query('UPDATE agent_grants SET decided_by=$2,decided_at=clock_timestamp() WHERE id=$1', [grant, HUMAN]);
  await reactions(); expect(await idleReports()).toHaveLength(2);
  const hold = await phone.execute('setCornerHold', { cornerId: C }, HUMAN);
  await reactions(); expect(await idleReports()).toHaveLength(2);
  await phone.execute('setCornerHold', { cornerId: C, releaseHoldId: hold.holdId }, HUMAN);
  await reactions(); expect(await idleReports()).toHaveLength(3);
});

it('WORKER-BLOCK: a granted-run activity row, rather than read/think activity, lifts the block', async () => {
  await daemon.execute('report', { ...await input(), status: 'blocked', text: 'Waiting for execution.' }, WORKER);
  const next = await input();
  await daemon.execute('postAgentActivity', { ...next, activity: [{ kind: 'tool', title: 'read status', operation: 'read' }] }, WORKER);
  expect(await state()).toBe('waiting');
  const grant = randomUUID();
  await db.query(`INSERT INTO agent_grants(id,agent_id,workspace_id,room_id,kind,target,reason,requested_by,status)
    VALUES($1,$2,$3,$4,'command','true','Proof',$5,'approved')`, [grant, WORKER, WS, ROOM, HUMAN]);
  await daemon.execute('postAgentActivity', { ...next, activity: [{ kind: 'tool',
    title: `ran true under grant ${grant} · asked by Owner`, operation: 'execute', status: 'exit 0' }] }, WORKER);
  expect(await state()).toBe('working');
});

it('IDLE-BUDGET: moving a PR head cannot rearm receipts after completed notices are retired', async () => {
  await reactions();
  const reports = await idleReports(); expect(reports).toHaveLength(1);
  await db.query('DELETE FROM agent_commands WHERE id=ANY($1::text[])', [reports.map(row => row.id)]);
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [C, JSON.stringify({
    checks: 'unknown', pr: { number: 1, headSha: 'new-head' },
    checksSummary: { status: 'unknown', total: 0, checks: [], failing: [], fetchStartedAt: 0, updatedAt: 0 },
  })]);
  await reactions();
  expect(await idleReports()).toHaveLength(0);
});

it('IDLE-BUDGET: a native human permission decision restores one notice', async () => {
  await reactions(); expect(await idleReports()).toHaveLength(1);
  await db.query(`INSERT INTO permission_authority(permission_id,room_id,principal_id,request_id,scope,status)
    VALUES('permission-proof',$1,$2,'permission-request','{}'::jsonb,'pending')`, [C, HUMAN]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
    VALUES('permission-ask',$1,$2,'Allow edits','card','permission',$3::jsonb)`, [C, WORKER, JSON.stringify({
      permissionId: 'permission-proof', requestId: 'permission-request', agent: { pubkey: WORKER }, repository: 'owner/widgets',
    })]);
  await phone.execute('decideWritePermission', { permissionId: 'permission-proof', roomId: C, agentId: WORKER,
    requestId: 'permission-request', repository: 'owner/widgets', decision: 'allow' }, HUMAN);
  await reactions(); expect(await idleReports()).toHaveLength(2);
});

it.each([false, true])('REPORT-REPLY: owner yes clears Ruby’s report (threaded=%s) and silence spends the sole idle notice', async threaded => {
  // Retained human-directed report, as in still-river-thread; no new work output follows it.
  await db.query(`UPDATE identities SET name='Ruby' WHERE id=$1`, [WORKER]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,card,created_at)
    VALUES('ruby-decision',$1,$2,'needs-decision: Use this approach?',
      jsonb_build_object('reportToId',$3::text,'reportStatus','needs-decision'),now()-interval '1 minute')`, [C, WORKER, HUMAN]);
  expect(await state()).toBe('waiting');
  expect(await loadCornerWaiting(db, C)).toBeDefined();
  expect((await phone.execute('readNeedsYou', { workspaceId: WS }, HUMAN)).items.map(item => item.messageId)).toContain('ruby-decision');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,reply_to_message_id)
    VALUES('owner-yes',$1,$2,'yes',$3)`, [C, HUMAN, threaded ? 'ruby-decision' : null]);
  expect(await loadCornerWaiting(db, C)).toBeUndefined();
  expect((await db.query('SELECT corner_has_explicit_wait($1) waiting', [C])).rows).toEqual([{ waiting: false }]);
  expect(await state()).toBe('idle');
  expect((await phone.readCorners(ROOM, HUMAN))!.corners[0]).toMatchObject({ state: 'idle' });
  expect((await phone.execute('readNeedsYou', { workspaceId: WS }, HUMAN)).items).toEqual([]);
  expect(await idleReports()).toHaveLength(1);
  expect((await db.query(cornerIdleSql('$1'), [C])).rows[0]).toMatchObject({ idle_eligible: true, idle_report_count: 1 });
  const notice = (await readAgentCommands(db, COMMANDER, C)).commands.find(item => item.source.authorId === SYSTEM_IDENTITY_ID)!;
  await startQueuedCommand(daemon, { roomId: C, commandId: notice.id }, COMMANDER);
  expect(await daemon.execute('markAgentTurnSilent', { roomId: C, requestId: notice.turnRequestId }, COMMANDER)).toMatchObject({ answered: true });
  await runCornerAttention(db); await refreshCornerAttention(db, C);
  expect(await state()).toBe('idle');
  expect(await idleReports()).toHaveLength(1);
});

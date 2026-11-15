import { createHash } from 'node:crypto';
import { HUMAN, ROOM, RUBY, WORKER, authority, claim, commands, expect, it, open, rootFixture, worker } from './test-support-commander.integration.test-support.js';
import { cornerBlockerSql, cornerRowState, chatCornerCounts } from './chat-corner-counts.js';
import { cornerWaitingReportSql } from './corner-waiting-report.js';

async function blocked(text = 'Need a decision.', status: 'blocked' | 'needs_decision' = 'blocked') {
  const opened = await open(), turn = await worker(opened.cornerId);
  const report = await rootFixture.daemon.execute('report', { ...authority(turn), status, text }, WORKER);
  return { cornerId: opened.cornerId, report };
}
const blocker = async (cornerId: string) => (await rootFixture.db.query<{
  item_id: string; kind: 'message' | 'report' | 'merge-hold'; reason: 'approve' | 'connect' | 'question'; person_id: string;
}>(`SELECT blocker.* FROM rooms c ${cornerBlockerSql()} WHERE c.id=$1`, [cornerId])).rows[0]!;

it.each([
  ['squire-approval', 'approve'], ['permission', 'approve'], ['grant-request', 'approve'],
  ['connector-offer', 'connect'], ['app-sign-in', 'connect'], ['agent-sign-in', 'connect'],
  ['choice', 'question'], ['needs-decision:', 'question'], ['blocked:', 'question'],
])('R1: projects %s as waiting to %s from the indexed blocker', async (kind, reason) => {
  const { cornerId } = await open();
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,card_type)
    VALUES('item',$1,$2,'Question',$3)`, [cornerId, WORKER, kind]);
  await rootFixture.db.query(`INSERT INTO corner_owed(corner_id,message_id,person_id,created_at,blocking,answerable)
    VALUES($1,'item',$2,now(),true,false) ON CONFLICT(message_id,person_id)
    DO UPDATE SET blocking=true,answerable=false`, [cornerId, HUMAN]);
  const selected = await blocker(cornerId);
  const row = { id: cornerId, name: 'Corner', parent_id: 'parent', archived_at: null,
    lifecycle: null, latest_turn_status: null, blocking: true,
    waiting_item_id: selected.item_id, waiting_reason: selected.reason };
  expect(cornerRowState(row)).toEqual({ state: 'waiting', reason, itemId: 'item' });
  expect(chatCornerCounts([row]).get('parent')?.openCorners[0]?.state).toBe('waiting');
});

it('R1: chooses the oldest blocker deterministically', async () => {
  const { cornerId } = await open();
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,card_type)
    VALUES('older',$1,$2,'Approval','permission'),('newer',$1,$2,'Connect','connector-offer')`, [cornerId, WORKER]);
  await rootFixture.db.query(`INSERT INTO corner_owed(corner_id,message_id,person_id,created_at,blocking,answerable)
    VALUES($1,'older',$2,'2026-01-01',true,false),($1,'newer',$2,'2026-01-02',true,false)`, [cornerId, HUMAN]);
  expect(await blocker(cornerId)).toMatchObject({ item_id: 'older' });
});

it.each(['done:', 'failed:', 'unreachable', 'addressed message'])(
  'R1: %s alone stays idle even when owed', () => {
    expect(cornerRowState({ archived_at: null, lifecycle: null, latest_turn_status: null,
      blocking: false })).toEqual({ state: 'idle' });
  },
);

it.each(['blocked', 'needs_decision'] as const)('REPORT-WAITING-DERIVED: real %s delivery opens a wait without a transcript copy', async status => {
  const { cornerId, report } = await blocked('@captain choose a scope.', status);
  expect((await rootFixture.db.query(`SELECT private_payload->>'reportStatus' status FROM agent_commands WHERE id=$1`, [report.id])).rows)
    .toEqual([{ status: status.replace('_', '-') }]);
  expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE card_type='agent-command'`)).rows).toEqual([]);
  expect(await blocker(cornerId)).toMatchObject({ item_id: report.id, kind: 'report' });
  const waiting = (await rootFixture.db.query<{ person_id: string }>(`SELECT waiting.* FROM rooms c
    CROSS JOIN LATERAL (${cornerWaitingReportSql('c')}) waiting WHERE c.id=$1 ORDER BY person_id`, [cornerId])).rows;
  expect(waiting.map(row => row.person_id)).toEqual([HUMAN, RUBY].sort());
});

it('REPORT-WAITING-DERIVED: commander orders and old answered markers cannot clear a worker block', async () => {
  const { cornerId, report } = await blocked();
  const delivery = (await commands(cornerId, RUBY)).find(item => item.id === report.id)!;
  await claim(delivery);
  await rootFixture.daemon.execute('order', { ...authority(delivery), address: cornerId, text: 'Use option one.' }, RUBY);
  await rootFixture.db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{waitingAnswered}','true') WHERE id=$1`, [report.id]);
  expect(await blocker(cornerId)).toMatchObject({ item_id: report.id });
  const next = await worker(cornerId);
  await rootFixture.daemon.execute('report', { ...authority(next), status: 'done', text: 'Work completed.' }, WORKER);
  expect((await blocker(cornerId)).item_id).toBeNull();
});

it('REPORT-WAITING-DERIVED: automatic blocked final prose creates no explicit report wait', async () => {
  const { cornerId } = await open(), turn = await worker(cornerId);
  await rootFixture.daemon.execute('postRoomMessage', { ...authority(turn), text: 'blocked: progress note' }, WORKER);
  const waiting = await rootFixture.db.query(`SELECT waiting.* FROM rooms c
    CROSS JOIN LATERAL (${cornerWaitingReportSql('c')}) waiting WHERE c.id=$1`, [cornerId]);
  expect(waiting.rows).toEqual([]);
});

it('R1: holds rank behind a real private report, and retain their actual message target', async () => {
  const { cornerId, report } = await blocked();
  const hold = await rootFixture.phone.execute('setCornerHold', { cornerId }, HUMAN);
  expect(await blocker(cornerId)).toMatchObject({ item_id: report.id, kind: 'report' });
  const delivery = (await commands(cornerId, RUBY)).find(item => item.id === report.id)!;
  await claim(delivery);
  await rootFixture.daemon.execute('order', { ...authority(delivery), address: cornerId, text: 'Finish.' }, RUBY);
  const next = await worker(cornerId);
  await rootFixture.daemon.execute('report', { ...authority(next), status: 'done', text: 'Finished.' }, WORKER);
  const selected = await blocker(cornerId);
  expect(selected).toMatchObject({ item_id: hold.holdId, kind: 'merge-hold' });
  expect(cornerRowState({ archived_at: null, lifecycle: null, latest_turn_status: null, blocking: true,
    waiting_item_id: selected.item_id, waiting_reason: selected.reason, waiting_kind: selected.kind }))
    .toMatchObject({ itemId: createHash('sha256').update(`corner-hold:${hold.holdId}`).digest('hex') });
});

const waitingPeople = async (cornerId: string) => (await rootFixture.db.query<{ person_id: string }>(
  `SELECT waiting.person_id FROM rooms c CROSS JOIN LATERAL (${cornerWaitingReportSql('c')}) waiting
    WHERE c.id=$1 ORDER BY waiting.person_id`, [cornerId])).rows.map(row => row.person_id);

it.each((['blocked', 'needs_decision'] as const).flatMap(status => [true, false].map(humanFirst => ({ status, humanFirst }))))('REPORT-REPLY: $status clears separately for the commander and tagged human (humanFirst=$humanFirst)', async ({ status, humanFirst }) => {
  const { cornerId } = await blocked('@captain choose a scope.', status);
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text)
    VALUES('first-answer',$1,$2,'yes')`, [cornerId, humanFirst ? HUMAN : RUBY]);
  expect(await waitingPeople(cornerId)).toEqual([humanFirst ? RUBY : HUMAN]);
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text)
    VALUES('second-answer',$1,$2,'Acknowledged.')`, [cornerId, humanFirst ? RUBY : HUMAN]);
  expect(await waitingPeople(cornerId)).toEqual([]);
});

it('REPORT-REPLY: other people, worker prose, orders and System lines cannot answer for the addressee', async () => {
  const { cornerId } = await blocked(); // Addressed only to Ruby.
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,system_event,deleted_at) VALUES
    ('other-person',$1,$2,'yes','message',NULL,NULL),
    ('worker-prose',$1,$3,'Still blocked.','message',NULL,NULL),
    ('commander-system',$1,$4,'System event','message','{}'::jsonb,NULL),
    ('commander-deleted',$1,$4,'yes','message',NULL,now()),
    ('commander-activity',$1,$4,'read','activity',NULL,NULL),
    ('commander-old',$1,$4,'Earlier answer','message',NULL,NULL)`, [cornerId, HUMAN, WORKER, RUBY]);
  await rootFixture.db.query(`UPDATE messages SET created_at='2026-01-01' WHERE id='commander-old'`);
  expect(await waitingPeople(cornerId)).toEqual([RUBY]);
});

it.each(['corner', 'thread'] as const)('REPORT-REPLY: a forwarded human report clears on its addressee’s %s answer', async surface => {
  const { cornerId } = await open();
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,card,created_at)
    VALUES('forwarded-report',$1,$2,'needs-decision: Choose a scope.',
      jsonb_build_object('reportToId',$3::text,'sourceRoomId',$4::text),now()-interval '1 minute')`, [ROOM, WORKER, HUMAN, cornerId]);
  expect(await waitingPeople(cornerId)).toEqual([HUMAN]);
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,reply_to_message_id)
    VALUES('forwarded-answer',$1,$2,'yes',$3)`, [surface === 'corner' ? cornerId : ROOM, HUMAN,
      surface === 'thread' ? 'forwarded-report' : null]);
  expect(await waitingPeople(cornerId)).toEqual([]);
});

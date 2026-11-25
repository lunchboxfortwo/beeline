import { closeAgentAsk } from './agent-open-asks.js';
import { createHash } from 'node:crypto';
import { threadWorkState } from '@beeline/api-contract/phone';
import { HUMAN, DM, ROOM, RUBY, WORKER, authority, claim, commands, expect, it, open, rootFixture, worker } from './test-support-commander.integration.test-support.js';
import { cornerBlockerSql, cornerFactsSql, cornerRowState, chatCornerCounts } from './chat-corner-counts.js';
import { cornerWaitingReportSql } from './corner-waiting-report.js';
import { refreshCornerAttention } from './corner-attention.js';

async function blocked(text = 'Need a decision.', status: 'blocked' | 'needs_decision' = 'blocked') {
  const opened = await open(), turn = await worker(opened.cornerId);
  const report = await rootFixture.daemon.execute('message', { ...authority(turn), type:'blocked', text }, WORKER);
  await rootFixture.daemon.execute('postRoomMessage',{...authority(turn),text:'',harnessEnded:true},WORKER);
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
    machine: { state: 'waiting' as const }, lifecycle: null, latest_turn_status: null, blocking: true,
    waiting_item_id: selected.item_id, waiting_reason: selected.reason };
  expect(cornerRowState(row)).toEqual({ state: 'waiting', reason, itemId: 'item' });
  expect(chatCornerCounts([row], 'viewer').get('parent')?.openCorners[0]?.state).toBe('waiting');
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

it.each(['blocked', 'needs_decision'] as const)('REPORT-WAITING-DERIVED: real %s delivery opens a closeable wait', async status => {
  const { cornerId, report } = await blocked('@captain choose a scope.', status);
  expect((await rootFixture.db.query(`SELECT private_payload->>'reportStatus' status FROM agent_commands WHERE id=$1`, [report.id])).rows)
    .toEqual([{ status: 'blocked' }]);
  expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE card_type='agent-command'`)).rows).toEqual([]);
  expect(await blocker(cornerId)).toMatchObject({ item_id: report.id, kind: 'report' });
  const waiting = (await rootFixture.db.query<{ person_id: string }>(`SELECT waiting.* FROM rooms c
    CROSS JOIN LATERAL (${cornerWaitingReportSql('c')}) waiting WHERE c.id=$1 ORDER BY person_id`, [cornerId])).rows;
  expect(waiting.map(row => row.person_id)).toEqual([RUBY]);
});

it('REPORT-WAITING-DERIVED: commander orders and old answered markers cannot clear a worker block', async () => {
  const { cornerId, report } = await blocked();
  const delivery = (await commands(DM, RUBY)).find(item => item.id === report.id)!;
  await claim(delivery);
  await rootFixture.daemon.execute('message', { ...authority(delivery), type:'normal',address:`${WORKER}@${cornerId}`, text: 'Use option one.' }, RUBY);
  await rootFixture.db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{waitingAnswered}','true') WHERE id=$1`, [report.id]);
  expect(await blocker(cornerId)).toMatchObject({ item_id: report.id });
  const next = await worker(cornerId);
  await closeAgentAsk(rootFixture.db,WORKER,{messageId:report.id,reason:'answered'});
  await rootFixture.daemon.execute('postRoomMessage', { ...authority(next), harnessEnded: true, text: 'Work completed.' }, WORKER);
  expect((await blocker(cornerId)).item_id).toBeNull();
});

it('REPORT-WAITING-DERIVED: closing prose by itself leaves no report wait', async () => {
  const { cornerId } = await open(), turn = await worker(cornerId);
  await rootFixture.daemon.execute('postRoomMessage', { ...authority(turn), text: 'blocked: progress note' }, WORKER);
  const waiting = await rootFixture.db.query(`SELECT waiting.* FROM rooms c
    CROSS JOIN LATERAL (${cornerWaitingReportSql('c')}) waiting WHERE c.id=$1`, [cornerId]);
  expect(waiting.rows).toHaveLength(0);
});

it('R1: holds rank behind a real private report, and retain their actual message target', async () => {
  const { cornerId, report } = await blocked();
  const hold = await rootFixture.phone.execute('setCornerHold', { cornerId }, HUMAN);
  expect(await blocker(cornerId)).toMatchObject({ item_id: report.id, kind: 'report' });
  const delivery = (await commands(DM, RUBY)).find(item => item.id === report.id)!;
  await claim(delivery);
  await rootFixture.daemon.execute('message', { ...authority(delivery), type:'normal',address:`${WORKER}@${cornerId}`, text: 'Finish.' }, RUBY);
  const next = await worker(cornerId);
  await closeAgentAsk(rootFixture.db,WORKER,{messageId:report.id,reason:'answered'});
  await rootFixture.daemon.execute('postRoomMessage', { ...authority(next), harnessEnded: true, text: 'Finished.' }, WORKER);
  const selected = await blocker(cornerId);
  expect(selected).toMatchObject({ item_id: hold.holdId, kind: 'merge-hold' });
  expect(cornerRowState({ archived_at: null, machine: { state: 'waiting' }, lifecycle: null, latest_turn_status: null, blocking: true,
    waiting_item_id: selected.item_id, waiting_reason: selected.reason, waiting_kind: selected.kind }))
    .toMatchObject({ itemId: createHash('sha256').update(`corner-hold:${hold.holdId}`).digest('hex') });
});

const waitingPeople = async (cornerId: string) => (await rootFixture.db.query<{ person_id: string }>(
  `SELECT waiting.person_id FROM rooms c CROSS JOIN LATERAL (${cornerWaitingReportSql('c')}) waiting
    WHERE c.id=$1 ORDER BY waiting.person_id`, [cornerId])).rows.map(row => row.person_id);

it.each((['blocked', 'needs_decision'] as const).flatMap(status => [true, false].map(humanFirst => ({ status, humanFirst }))))('REPORT-REPLY: $status retains its commander block through unrelated answers (humanFirst=$humanFirst)', async ({ status, humanFirst }) => {
  const { cornerId } = await blocked('@captain choose a scope.', status);
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text)
    VALUES('first-answer',$1,$2,'yes')`, [cornerId, humanFirst ? HUMAN : RUBY]);
  expect(await waitingPeople(cornerId)).toEqual([RUBY]);
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text)
    VALUES('second-answer',$1,$2,'Acknowledged.')`, [cornerId, humanFirst ? RUBY : HUMAN]);
  expect(await waitingPeople(cornerId)).toEqual([RUBY]);
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
      jsonb_build_object('reportStatus','blocked','reportToId',$3::text,'sourceRoomId',$4::text),now()-interval '1 minute')`, [ROOM, WORKER, HUMAN, cornerId]);
  expect(await waitingPeople(cornerId)).toEqual([HUMAN]);
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,reply_to_message_id)
    VALUES('forwarded-answer',$1,$2,'yes',$3)`, [surface === 'corner' ? cornerId : ROOM, HUMAN,
      surface === 'thread' ? 'forwarded-report' : null]);
  expect(await waitingPeople(cornerId)).toEqual([HUMAN]);
  await closeAgentAsk(rootFixture.db,WORKER,{messageId:'forwarded-report',reason:'answered'});
  expect(await waitingPeople(cornerId)).toEqual([]);
});

it('selects each outstanding report recipient for their own corner surfaces', async () => {
  const { cornerId } = await blocked('@captain choose a scope.');
  // The attention worker commits the state machine before clients reread it.
  await refreshCornerAttention(rootFixture.db, cornerId);
  const facts = cornerFactsSql('$2');
  const read = async (viewer: string) => (await rootFixture.db.query<any>(
    `SELECT c.id,c.name,c.parent_id,c.archived_at,${facts.columns} FROM rooms c ${facts.joins} WHERE c.id=$1`,
    [cornerId, viewer])).rows[0];
  for (const viewer of [HUMAN, RUBY]) {
    const row = await read(viewer);
    expect(row.waiting_person_id).toBe(RUBY);
    expect(threadWorkState(chatCornerCounts([row], viewer).get(ROOM)!.openCorners[0]!, viewer)).toBe(viewer===RUBY?'needs-you':'in-progress');
    expect((await rootFixture.phone.readCorners(ROOM, viewer))?.corners.find(row => row.corner.id === cornerId)?.blocker?.personId).toBe(RUBY);
  }
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('recipient-answer',$1,$2,'Yes')`, [cornerId, HUMAN]);
  expect((await read(HUMAN)).waiting_person_id).toBe(RUBY);
  expect((await read(RUBY)).waiting_person_id).toBe(RUBY);
});

it.each(['backlog', 'done'])('keeps no stored %s for a thread; corner rows and deck summaries read its machine', async workState => {
  const { cornerId } = await open();
  await rootFixture.db.query(`INSERT INTO work_items(id,room_id,state,opened_by) VALUES($1,$2,$3,$4)
    ON CONFLICT(id) DO UPDATE SET state=excluded.state`, [cornerId, ROOM, workState, HUMAN]);
  expect((await rootFixture.db.query('SELECT state FROM work_items WHERE id=$1', [cornerId])).rows).toEqual([{ state: null }]);
  const view = await rootFixture.phone.readCorners(ROOM, HUMAN);
  const machine = (await rootFixture.db.query<{ state: string }>(`SELECT machine->>'state' state FROM corner_facts WHERE corner_id=$1`, [cornerId])).rows[0]!.state;
  expect(view?.corners.find(row => row.corner.id === cornerId)).toMatchObject({ state: machine });
  expect(view?.summary?.openCorners.find(row => row.id === cornerId)).toMatchObject({ state: machine });
  expect(view?.corners.find(row => row.corner.id === cornerId)).not.toHaveProperty('workState');
});

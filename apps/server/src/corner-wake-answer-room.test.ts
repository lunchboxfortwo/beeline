import { queueCornerMergeConflict } from './agent-command.js';
import { A,advanceCorner,B,beforeEach,C,commands,expect,H,it,R,result,rootFixture,systemLine } from './test-support-corner-review-dispatch.test-support.js';

const head = 'e'.repeat(40);
const ROOT = 'f'.repeat(64);
const lifecycle = (checks: string, extra = {}) => rootFixture.db.query(
  `UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
  [C, JSON.stringify({ checks, lifecycle: 'in-review', pr: { number: 51, headSha: head, title: 'Thread work',
    url: 'https://github.com/acme/repo/pull/51', ...extra } })]);
const github = (verb: string, kind?: string) => systemLine(rootFixture.db, { roomId: C, authorId: H,
  subject: { kind: 'github', name: 'GitHub' }, verb, ...(kind ? { kind } : {}), object: { text: 'ci', headSha: head } });

beforeEach(async () => {
  // The corner was commissioned by a person's message in the parent chat.
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@hoots build the thread work')
    ON CONFLICT(id) DO NOTHING`, [ROOT, R, H]);
  await rootFixture.db.query(`UPDATE agent_commands SET root_source_message_id=$2,return_room_id=$3::uuid,
    private_payload=private_payload||jsonb_build_object('authorId',$4::text,'fromRoomId',$3::text)
    WHERE room_id=$1 AND reason='corner_objective'`, [C, ROOT, R, H]);
});

async function answeredInCorner(agentId: string, reason: string) {
  const [wake] = await commands(agentId, C);
  expect(wake).toMatchObject({ reason, roomId: C, returnRoomId: C });
  const posted = await result(wake!, `Handled ${reason}.`);
  expect((await rootFixture.db.query('SELECT room_id FROM messages WHERE id=$1', [posted.id])).rows).toEqual([{ room_id: C }]);
  expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE room_id=$1 AND author_id=$2 AND created_at>(SELECT created_at FROM messages WHERE id=$3)`,
    [R, agentId, ROOT])).rows).toEqual([]);
  // Answering wakes no commander; any other wake the machine queued stays in the corner too.
  expect((await rootFixture.db.query<{ room_id: string; return_room_id: string }>(
    `SELECT room_id,return_room_id FROM agent_commands WHERE state='pending'`)).rows
    .every(item => item.room_id === C && item.return_room_id === C)).toBe(true);
}

it('a passing-check review wake answers in its corner, not the commissioning chat', async () => {
  await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
  await lifecycle('passing');
  await github('passed a check', 'check-passed');
  await answeredInCorner(B, 'corner_review_dispatch');
});

it('a failing-check wake answers in its corner', async () => {
  await lifecycle('failing');
  await github('failed a check', 'check-failed');
  await answeredInCorner(A, 'corner_check');
});

it('a merge-conflict wake answers in its corner', async () => {
  await lifecycle('passing', { mergeability: 'dirty' });
  await expect(queueCornerMergeConflict(rootFixture.db, C, (await github('found merge conflicts in')).id)).resolves.toBe(true);
  await answeredInCorner(A, 'corner_merge_conflict');
});

it('a merge-refused wake answers in its corner', async () => {
  await lifecycle('passing');
  await advanceCorner(rootFixture.db, C, { kind: 'merge-refused', headSha: head, reason: 'base moved' });
  await answeredInCorner(A, 'corner_merge_refused');
});

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

async function answeredAtCommander(agentId: string, reason: string) {
  const [wake] = await commands(agentId, C);
  expect(wake).toMatchObject({ reason, roomId: C, returnRoomId:R });
  const posted = await result(wake!, `Handled ${reason}.`);
  expect((await rootFixture.db.query('SELECT room_id FROM messages WHERE id=$1', [posted.id])).rows).toEqual([{room_id:R}]);
  expect((await rootFixture.db.query('SELECT 1 FROM messages WHERE room_id=$1 AND id=$2',[C,posted.id])).rowCount).toBe(0);

}

it('a passing-check review wake replies to the commissioning sender at its recorded chat', async () => {
  await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
  await lifecycle('passing');
  await github('passed a check', 'check-passed');
  await answeredAtCommander(B, 'corner_review_dispatch');
});

it('a failing-check wake replies to its thread commander', async () => {
  await lifecycle('failing');
  await github('failed a check', 'check-failed');
  await answeredAtCommander(A, 'corner_check');
});

it('a merge-conflict wake replies to its thread commander', async () => {
  await lifecycle('passing', { mergeability: 'dirty' });
  await expect(queueCornerMergeConflict(rootFixture.db, C, (await github('found merge conflicts in')).id)).resolves.toBe(true);
  await answeredAtCommander(A, 'corner_merge_conflict');
});

it('a merge-refused wake replies to its thread commander', async () => {
  await lifecycle('passing');
  await advanceCorner(rootFixture.db, C, { kind: 'merge-refused', headSha: head, reason: 'base moved' });
  await answeredAtCommander(A, 'corner_merge_refused');
});

import { describe, it, expect, A, B, F, H, R, SHA, rootFixture, open, fallback, greenHead, advanceCorner, fixtureScope18, pushToCorner } from './test-support-corner-lifecycle.test-support.js';
import { queueCornerMergeConflict } from './agent-command.js';

/** A thread turn "takes a turn in the chat" when a queue item for the thread's
 * implementer or reviewer is addressed to any room but the thread. Queue items
 * are the only authority for a turn (`agent_commands`), so this reads them. */
async function outsideThread(thread: string, before: string[]) {
  return (await rootFixture.db.query<{ agent_id: string; room_id: string; reason: string }>(
    `SELECT agent_id,room_id,reason FROM agent_commands WHERE agent_id=ANY($1::text[]) AND room_id<>$2
       AND NOT (id=ANY($3::text[])) ORDER BY created_at,id`, [[A, B], thread, before])).rows;
}
const ids = async () => (await rootFixture.db.query<{ id: string }>('SELECT id FROM agent_commands')).rows.map(row => row.id);
const pendingFor = async (thread: string, agent: string) => (await rootFixture.db.query<{ id: string; reason: string }>(
  "SELECT id,reason FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND state='pending' ORDER BY created_at,id", [thread, agent])).rows;
const settle = () => rootFixture.db.query("UPDATE agent_commands SET state='complete' WHERE state='pending'");

/** Condition 3: no implementer or reviewer work takes a turn in the chat. */
describe('C3: thread work never takes a turn in the parent chat', () => {
  it.each(['another agent', 'the implementer itself'] as const)('opened by %s: repair wakes, review requests, findings, merge-gate wakes and replies stay in the thread', async opener => {
    if (opener === 'another agent') await fallback('', false);
    const thread = await open('owner/widgets', false, opener === 'another agent' ? F : A);
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
    const before = await ids();
    const db = rootFixture.db;
    // Implementer replies to its task, then a failing head wakes it for repair.
    const task = (await pendingFor(thread, A)).find(row => row.reason === 'corner_objective')!;
    await rootFixture.daemon.execute('reply', { id: task.id, text: 'Opened the pull request' }, A);
    await db.query('UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1', [thread,
      JSON.stringify({ lifecycle: 'in-review', checks: 'unknown', pr: { number: 7, headSha: SHA, url: 'https://github.com/owner/widgets/pull/7' } })]);
    await pushToCorner(thread, SHA);
    rootFixture.githubApp.readCommitCheckRollup.mockResolvedValueOnce({ state: 'failed', total: 1, failing: ['typecheck'], checks: [{ name: 'typecheck', status: 'failed' }] });
    await fixtureScope18().checkRun(thread, 'typecheck', 'failure');
    for (const wake of await pendingFor(thread, A))
      await rootFixture.daemon.execute('reply', { id: wake.id, text: 'blocked: need build access', ask: { question: 'Grant access?', options: ['Yes', 'No'] } }, A);
    // An agent commander answers in its own place; the answer wakes the implementer in the thread.
    const asked = (await pendingFor(R, F)).filter(row => row.reason === 'reply');
    expect(asked.length).toBe(opener === 'another agent' ? 2 : 0);
    for (const row of asked) await rootFixture.daemon.execute('reply', { id: row.id, text: 'Access granted' }, F);
    expect((await pendingFor(thread, A)).map(row => row.reason)).toEqual(asked.map(() => 'reply'));
    await settle();
    // A green head requests review; the reviewer's findings and reply stay in the thread.
    await greenHead(thread, 7, SHA);
    const review = (await pendingFor(thread, B)).find(row => row.reason === 'corner_review_dispatch')!;
    expect(review).toBeDefined();
    await rootFixture.daemon.execute('message', { roomId: thread, to: { agent: 'implementer', place: thread }, text: 'FAIL: add the missing test' }, B);
    await rootFixture.daemon.execute('reply', { id: review.id, text: 'Findings sent to the implementer' }, B);
    await settle();
    // Merge gate wakes: a provider refusal and a live conflict.
    await advanceCorner(db, thread, { kind: 'merge-refused', headSha: SHA, reason: 'Provider refused the merge' });
    await db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{pr,mergeability}','"dirty"') WHERE corner_id=$1`, [thread]);
    const note = await db.query<{ id: string }>('SELECT id FROM messages WHERE room_id=$1 ORDER BY created_at DESC LIMIT 1', [thread]);
    await queueCornerMergeConflict(db, thread, note.rows[0]!.id);
    for (const wake of await pendingFor(thread, A)) await rootFixture.daemon.execute('reply', { id: wake.id, text: 'Resolving' }, A);
    await settle();
    // Every event above reached a thread worker, so the empty result is not vacuous.
    const inThread = (await db.query<{ reason: string }>(`SELECT DISTINCT reason FROM agent_commands
      WHERE room_id=$1 AND agent_id=ANY($2::text[]) AND NOT (id=ANY($3::text[])) ORDER BY reason`, [thread, [A, B], before])).rows.map(row => row.reason);
    expect(inThread).toEqual(expect.arrayContaining(['corner_check', 'corner_merge_conflict', 'corner_merge_refused', 'corner_review_dispatch', 'message']));
    expect(await outsideThread(thread, before)).toEqual([]);
  });
});

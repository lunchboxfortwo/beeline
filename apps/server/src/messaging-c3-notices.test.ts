import { describe, it, expect } from 'vitest';
import { queueMessage, type CommandRow } from './agent-command.js';
import { sendMessage } from './agent-messaging.js';
import { modelText } from './message-origin.js';
import { refreshCornerAttention } from './corner-attention.js';
import { loadCorner } from './corner-lifecycle-read-state.js';
import { becomeThreadImplementer, noteReviewBlocked } from './corner-lifecycle.js';
import { A, B, C, CHAT, THREAD, daemon, db } from './messaging-conditions.test-support.js';

/** Queue items for the thread's current implementer or reviewer anywhere but the thread. */
const outsideThread = async () => (await db.query<{ agent_id: string; room_id: string; reason: string }>(
  `SELECT command.agent_id,command.room_id,command.reason FROM agent_commands command JOIN corner_facts fact ON fact.corner_id=$1
   JOIN rooms chat ON chat.id=$2 WHERE command.agent_id IN (fact.implementer_agent_id,chat.reviewer_agent_id) AND command.room_id<>$1
   ORDER BY command.created_at,command.id`, [THREAD, CHAT])).rows;
const notices = async () => (await db.query<{ agent_id: string; room_id: string; id: string }>(
  "SELECT id,agent_id,room_id FROM agent_commands WHERE private_payload->>'automatic'='true' AND state='pending' ORDER BY created_at,id")).rows;

/** An idle thread whose opening task came from `commander` at `place`. */
async function idleThread(commander: string, place: string) {
  const opening = await queueMessage(db, { roomId: THREAD, agentId: B, sourceMessageId: null, reason: 'corner_objective',
    privatePayload: { kind: 'message', authorId: commander, fromRoomId: place, text: modelText('Build widget'),
      route: { from: { agent: commander, place }, to: { agent: B, place: THREAD } } } });
  await db.query("UPDATE agent_commands SET state='complete' WHERE id=$1", [opening!.id]);
  await db.query('DELETE FROM agent_turns WHERE room_id=$1', [THREAD]);
  await db.query("UPDATE rooms SET created_at=now()-interval '1 day' WHERE id=$1", [THREAD]);
}

/** Condition 3: idle and merge-gate notices about thread work never start a worker turn in the chat. */
describe('C3: thread notices reach the commander without a worker turn in the chat', () => {
  it('an idle notice reaches an agent commander and a review gap wakes only the implementer in the thread', async () => {
    await idleThread(A, CHAT);
    await refreshCornerAttention(db, THREAD);
    const corner = (await loadCorner(db, THREAD))!;
    await noteReviewBlocked(db, THREAD, corner, 'head', 'no reviewer is configured');
    expect((await notices()).map(row => [row.agent_id, row.room_id])).toEqual([[A, CHAT]]);
    expect((await db.query("SELECT agent_id,room_id FROM agent_commands WHERE reason='corner_review_needed'")).rows)
      .toEqual([{ agent_id: B, room_id: THREAD }]);
    for (const notice of await notices()) await daemon.execute('reply', { id: notice.id, text: 'Resume widget work' }, A);
    expect(await outsideThread()).toEqual([]);
  });

  it('a commander that becomes the implementer gets no idle or review-gap turn in the chat', async () => {
    await idleThread(A, CHAT);
    // revise_thread and claim_thread can make the commander the implementer.
    await becomeThreadImplementer(db, THREAD, A);
    await refreshCornerAttention(db, THREAD);
    const corner = (await loadCorner(db, THREAD))!;
    await noteReviewBlocked(db, THREAD, corner, 'head', 'no reviewer is configured');
    expect(await outsideThread()).toEqual([]);
  });

  it('a reviewer that messages the implementer and replies to its review request stays in the thread', async () => {
    await idleThread(A, CHAT);
    const review = (await queueMessage(db, { roomId: THREAD, agentId: C, sourceMessageId: null, reason: 'corner_review_dispatch',
      privatePayload: { kind: 'lifecycle', authorId: B, fromRoomId: THREAD, text: modelText('Review head') } }))!;
    await sendMessage(db, { route: { from: { agent: C, place: THREAD }, to: { agent: 'implementer', place: THREAD } },
      text: 'FAIL: add the missing test', parent: (await db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1', [review.id])).rows[0] });
    await daemon.execute('reply', { id: review.id, text: 'Findings sent' }, C);
    expect(await outsideThread()).toEqual([]);
  });
});

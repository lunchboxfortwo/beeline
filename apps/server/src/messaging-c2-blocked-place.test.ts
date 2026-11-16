import { describe, it, expect } from 'vitest';
import { queueMessage } from './agent-command.js';
import { modelText } from './message-origin.js';
import { A, B, C, THREAD, daemon, db, PLACES, SYSTEM_WAKES, inbox, settle, personSays, systemWake, type Place } from './messaging-conditions.test-support.js';

const ask = { question: 'Which output?', options: ['Web', 'Phone'] };
const places = Object.keys(PLACES) as Place[];
const wakes = SYSTEM_WAKES.map(reason => [reason, reason === 'corner_review_dispatch' ? C : B] as const);
const cases = places.flatMap(place => wakes.map(([reason, worker]) => [place, reason, worker] as const));

/** The first task reaches the implementer either as a message or as the recorded thread opening. */
async function firstTask(place: string, opening: boolean) {
  if (!opening) return daemon.execute('message', { roomId: place, to: { agent: 'implementer', place: THREAD }, text: 'Build widget' }, A);
  return (await queueMessage(db, { roomId: THREAD, agentId: B, sourceMessageId: null, reason: 'corner_objective',
    privatePayload: { kind: 'message', text: modelText('Build widget'), authorId: A, fromRoomId: place,
      route: { from: { agent: A, place }, to: { agent: B, place: THREAD } } } }))!;
}

/** Condition 2: a blocked reply from a thread worker reaches its commander where the commander sent the task. */
describe('C2: a blocked worker reaches its commander at the recorded origin place', () => {
  it.each(cases)('commander in the %s; a later thread tag; a blocked reply to the %s wake returns there', async (place, reason, worker) => {
    for (const opening of [false, true]) {
      await db.query('DELETE FROM agent_commands');
      await firstTask(PLACES[place], opening);
      await settle();
      // Another person tag later in the thread is conversation, not a new commander.
      await personSays(THREAD, '@ruby Conversation only');
      await settle();
      const wake = await systemWake(reason, worker);
      await settle();
      await daemon.execute('reply', { id: wake.id, text: 'blocked: need a decision', ask }, worker);
      expect((await inbox()).map(row => [row.agent_id, row.room_id, row.from, Boolean(row.ask)]), `opening=${opening}`)
        .toEqual([[A, PLACES[place], { agent: worker, place: THREAD }, true]]);
    }
  });

  it.each(places)('commander in the %s; a blocked reply to the task itself returns there', async place => {
    const task = await firstTask(PLACES[place], false);
    await settle();
    await daemon.execute('reply', { id: task.id, text: 'blocked: need a decision', ask }, B);
    expect((await inbox()).map(row => [row.agent_id, row.room_id, Boolean(row.ask)])).toEqual([[A, PLACES[place], true]]);
  });
});

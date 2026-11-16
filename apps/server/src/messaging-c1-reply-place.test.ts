import { describe, it, expect } from 'vitest';
import { A, THREAD, daemon, db, PLACES, ROLES, inbox, settle, personSays, personDeliveries, type Place, type Role } from './messaging-conditions.test-support.js';

const ask = { question: 'Which output?', options: ['Web', 'Phone'] };
const cases = (Object.keys(PLACES) as Place[]).flatMap(place => (Object.keys(ROLES) as Role[]).map(role => [place, role] as const));

/** Condition 1: a commander's message to a thread agent is answered in the place it was sent from. */
describe('C1: a thread agent replies at the place its commander sent from', () => {
  it.each(cases)('agent commander in the %s messages the thread %s; plain and ask replies return there', async (place, role) => {
    const worker = ROLES[role];
    const sent = await daemon.execute('message', { roomId: PLACES[place], to: { agent: role, place: THREAD }, text: 'Build widget' }, A);
    expect((await inbox()).map(row => [row.agent_id, row.room_id])).toEqual([[worker, THREAD]]);
    await settle();
    // Later conversation in the thread never moves the return place.
    await personSays(THREAD, '@ruby Conversation only');
    await settle();
    await daemon.execute('reply', { id: sent.id, text: 'Done' }, worker);
    await daemon.execute('reply', { id: sent.id, text: 'blocked: need a choice', ask }, worker);
    expect((await inbox()).map(row => [row.agent_id, row.room_id, row.from, Boolean(row.ask)])).toEqual([
      [A, PLACES[place], { agent: worker, place: THREAD }, false],
      [A, PLACES[place], { agent: worker, place: THREAD }, true],
    ]);
  });

  it.each(Object.keys(ROLES) as Role[])('a person commander in the thread tags the %s; its replies stay in the thread', async role => {
    const worker = ROLES[role];
    const handle = role === 'implementer' ? 'jellybean' : 'sol';
    await personSays(THREAD, `@${handle} Build widget`);
    const task = (await inbox())[0]!;
    expect([task.agent_id, task.room_id]).toEqual([worker, THREAD]);
    const command = (await db.query<{ id: string }>("SELECT id FROM agent_commands WHERE state='pending'")).rows[0]!;
    await daemon.execute('reply', { id: command.id, text: 'Done' }, worker);
    await daemon.execute('reply', { id: command.id, text: 'blocked: need a choice', ask }, worker);
    expect(await personDeliveries()).toEqual([
      { room_id: THREAD, author_id: worker, text: 'Done' },
      { room_id: THREAD, author_id: worker, text: 'blocked: need a choice' },
    ]);
    expect((await db.query('SELECT room_id FROM room_choices')).rows).toEqual([{ room_id: THREAD }]);
    expect(await inbox()).toEqual([]);
  });
});

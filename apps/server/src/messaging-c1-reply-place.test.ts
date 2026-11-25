import { RoomsMcpAgentTools } from './rooms-mcp-agent.js';
import { describe, it, expect } from 'vitest';
import { A, THREAD, daemon, db, PLACES, ROLES, inbox, settle, personSays, personDeliveries, type Place, type Role } from './messaging-conditions.test-support.js';

const reply = (worker:string,id:string,withAsk:boolean) => new RoomsMcpAgentTools(db,daemon).call(worker,'reply',{id,commandId:id,text:'Done',...(withAsk ? {ask} : {})}) as Promise<{id:string}>;
const ask = { question: 'Which output?', options: ['Web', 'Phone'] };
const cases = (Object.keys(PLACES) as Place[]).flatMap(place => (Object.keys(ROLES) as Role[]).flatMap(role => [false, true].map(withAsk => [place, role, withAsk] as const)));

/** Condition 1: a commander's message to a thread agent is answered in the place it was sent from. */
describe('C1: a thread agent replies at the place its commander sent from', () => {
  it.each(cases)('agent commander in the %s messages the thread %s; ask=%s replies return there', async (place, role, withAsk) => {
    const worker = ROLES[role];
    const sent = await daemon.execute('message', { roomId: PLACES[place], type:'normal', address:`${worker}@${THREAD}`, text: 'Build widget' }, A);
    expect((await inbox()).map(row => [row.agent_id, row.room_id])).toEqual([[worker, THREAD]]);
    await settle();
    // Later conversation in the thread never moves the return place.
    await personSays(THREAD, '@ruby Conversation only');
    await settle();
    const result = await reply(worker,sent.id,withAsk);
    const retry = await reply(worker,sent.id,withAsk);
    expect(retry.id).toBe(result.id);
    expect((await inbox()).map(row => [row.agent_id, row.room_id, row.from, Boolean(row.ask)])).toEqual([
      [A, PLACES[place], { agent: worker, place: THREAD }, withAsk],
    ]);
  });

  it.each((Object.keys(ROLES) as Role[]).flatMap(role => [false,true].map(withAsk => [role,withAsk] as const)))('a person commander in the thread tags the %s; ask=%s replies stay in the thread', async (role,withAsk) => {
    const worker = ROLES[role];
    const handle = role === 'implementer' ? 'jellybean' : 'sol';
    await personSays(THREAD, `@${handle} Build widget`);
    const task = (await inbox())[0]!;
    expect([task.agent_id, task.room_id]).toEqual([worker, THREAD]);
    const command = (await db.query<{ id: string }>("SELECT id FROM agent_commands WHERE state='pending'")).rows[0]!;
    await reply(worker,command.id,withAsk);
    await reply(worker,command.id,withAsk);
    expect(await personDeliveries()).toEqual([{room_id:THREAD,author_id:worker,text:'Done'}]);
    expect((await db.query('SELECT room_id FROM room_choices')).rows).toEqual(withAsk ? [{ room_id: THREAD }] : []);
    expect((await inbox()).map(row=>row.agent_id)).toEqual([]);
  });
});

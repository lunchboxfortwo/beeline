import { describe, it, expect } from 'vitest';
import { queueMessage } from './agent-command.js';
import { modelText } from './message-origin.js';
import { A, B, C, THREAD, daemon, db, PLACES, SYSTEM_WAKES, inbox, settle, personSays, systemWake, type Place } from './messaging-conditions.test-support.js';

const places = Object.keys(PLACES) as Place[];
const wakes = SYSTEM_WAKES.map(reason => [reason, reason === 'corner_review_dispatch' ? C : B] as const);
const cases = places.flatMap(place => wakes.map(([reason, worker]) => [place, reason, worker] as const));

/** The first task reaches the implementer either as a message or as the recorded thread opening. */
async function firstTask(place: string, opening: boolean) {
  if (!opening) return daemon.execute('message', { roomId: place, type:'normal',address:`${B}@${THREAD}`, text: 'Build widget' }, A);
  return (await queueMessage(db, { roomId: THREAD, agentId: B, sourceMessageId: null, reason: 'corner_objective',
    privatePayload: { kind: 'message', text: modelText('Build widget'), authorId: A, fromRoomId: place,
      route: { from: { agent: A, place }, to: { agent: B, place: THREAD } } } }))!;
}

/** System wakes answer in the thread; task replies retain their sender's place. */
describe('C2: implementer blocks default to the opening commander', () => {
  it.each(cases)('commander in the %s; a later thread tag; a blocked reply to the %s wake reaches the commander', async (place, reason, worker) => {
    for (const opening of [false, true]) {
      await db.query('DELETE FROM agent_commands');
      await db.query('DELETE FROM messages');
      await firstTask(PLACES[place], opening);
      await settle();
      // Another person tag later in the thread is conversation, not a new commander.
      await personSays(THREAD, '@ruby Conversation only');
      await settle();
      const wake = await systemWake(reason, worker);
      const answer = await daemon.execute('message', { roomId:THREAD, requestId:wake.turn_request_id,type:'blocked', text:'need a decision' }, worker);
      expect((await inbox()).filter(row=>row.agent_id===A).map(row => [row.agent_id, row.room_id, row.from, Boolean(row.ask)]), `opening=${opening}`)
        .toEqual([[A,PLACES[place],{agent:worker,place:THREAD},false]]);
      expect((await db.query('SELECT room_id,author_id FROM messages WHERE id=$1', [answer.id])).rows)
        .toEqual([{ room_id: PLACES[place], author_id: worker }]);
    }
  });

  it.each(places)('commander in the %s; a blocked reply to the task itself returns there', async place => {
    const task = await firstTask(PLACES[place], false);
    await daemon.execute('message', { roomId:THREAD, requestId:task.id,type:'blocked', text:'need a decision' }, B);
    expect((await inbox()).filter(row=>row.agent_id===A).map(row => [row.agent_id, row.room_id, Boolean(row.ask)])).toEqual([[A, PLACES[place], false]]);
  });

  it('keeps the final in the thread when a reply to the current wake went to the commander’s parent chat', async () => {
    await firstTask(PLACES.chat, true);
    await settle();
    const wake = await systemWake('corner_check');
    const invocation = {id:'thread-with-blocker',requestId:wake.turn_request_id};
    await daemon.execute('startAgentTurn',{roomId:THREAD,requestId:invocation.requestId,invocationId:invocation.id},B);
    const reply = await daemon.execute('message',{roomId:THREAD,requestId:wake.turn_request_id,type:'blocked',text:'Choose an output',invocation},B);
    const input = {roomId:THREAD,requestId:wake.id,text:'I found the issue and need a choice to continue.',harnessEnded:true,invocation};
    const final = await daemon.execute('postRoomMessage',input,B);
    expect(await daemon.execute('postRoomMessage',input,B)).toMatchObject({id:final.id});
    expect((await db.query('SELECT id,room_id,text FROM messages WHERE author_id=$1 ORDER BY room_id',[B])).rows).toEqual([
      {id:reply.id,room_id:PLACES.chat,text:'Choose an output'},
      {id:final.id,room_id:THREAD,text:input.text},
    ]);
  });
});

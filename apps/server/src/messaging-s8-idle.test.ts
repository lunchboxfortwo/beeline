import { it,expect } from 'vitest';
import { queueMessage, readAgentCommands, type CommandRow } from './agent-command.js';
import { sendMessage,replyToMessage } from './agent-messaging.js';
import { answerQueuedMessage } from './agent-command.js';
import { modelText } from './message-origin.js';
import { refreshCornerAttention } from './corner-attention.js';
import { cornerIdleSql } from './corner-idle.js';
import { updateWorkItem } from './work-board.js';
import { H,A,B,CHAT,THREAD,db,queued } from './messaging.test-support.js';
async function idleThread(withParent=true){
  const task=await sendMessage(db,{route:{from:{agent:H,place:CHAT},to:{agent:A,place:CHAT}},text:'Build widget'});
  const parent=(await db.query<import('./agent-command.js').CommandRow>('SELECT * FROM agent_commands WHERE id=$1',[task.id])).rows[0]!;
  await db.query("UPDATE agent_commands SET state='complete' WHERE id=$1",[task.id]);
  const opening=await queueMessage(db,{roomId:THREAD,agentId:B,sourceMessageId:null,reason:'corner_objective',parent:withParent?parent:undefined,
    privatePayload:{kind:'message',authorId:A,fromRoomId:CHAT,text:modelText('Build widget'),
      route:{from:{agent:A,place:CHAT},to:{agent:B,place:THREAD}}}});
  await db.query("UPDATE agent_commands SET state='complete' WHERE id=$1",[opening!.id]);
  await db.query('DELETE FROM agent_turns WHERE room_id=$1',[THREAD]);
  await db.query("UPDATE rooms SET created_at=now()-interval '1 day' WHERE id=$1",[THREAD]);
}
it('S8: an idle episode emits at most one notice at its commander tuple',async()=>{
  await idleThread();
  for(let event=0;event<3;event++) await refreshCornerAttention(db,THREAD);
  expect(await queued()).toEqual([[A,CHAT]]);
  const notices=await db.query("SELECT id FROM agent_commands WHERE private_payload->>'automatic'='true'");
  expect(notices.rowCount).toBe(1);
  await answerQueuedMessage(db,A,{roomId:CHAT,requestId:notices.rows[0]!.id,text:'',harnessEnded:true});
  for(let event=0;event<3;event++) await refreshCornerAttention(db,THREAD);
  expect(await queued()).toEqual([]);
  expect((await db.query("SELECT id FROM agent_commands WHERE private_payload->>'automatic'='true'")).rowCount).toBe(1);
});
it('S8: an outstanding ask suppresses idle notices',async()=>{
  await idleThread();
  await sendMessage(db,{route:{from:{agent:B,place:THREAD},to:{agent:A,place:CHAT}},text:'Need direction',
    ask:{question:'Which output?',options:['Web','Phone']}});
  for(let event=0;event<3;event++) await refreshCornerAttention(db,THREAD);
  expect((await db.query(cornerIdleSql('$1'),[THREAD])).rows[0]).toMatchObject({blocking:true,idle_eligible:false});
  expect(await queued()).toEqual([[A,CHAT]]);
  expect((await db.query("SELECT 1 FROM agent_commands WHERE private_payload->>'automatic'='true'")).rowCount).toBe(0);
});

it.each([true,false])('refuses a reply to a System idle notice with a parent task=%s',async withParent=>{
  await idleThread(withParent);
  await refreshCornerAttention(db,THREAD);
  const [notice]=(await readAgentCommands(db,A,CHAT)).commands;
  await expect(replyToMessage(db,A,{roomId:CHAT,id:notice!.id,text:'I will resume widget work'})).rejects.toThrow('woke this turn');
  expect(await queued()).toEqual([[A,CHAT]]);
  expect((await db.query('SELECT id FROM messages WHERE author_id=$1',[A])).rows).toEqual([]);
});

it('a brief revision under an idle notice replies to the reviser instead of the inherited requester',async()=>{
  await idleThread();
  await refreshCornerAttention(db,THREAD);
  const notice=(await db.query<CommandRow>("SELECT * FROM agent_commands WHERE private_payload->>'automatic'='true'")).rows[0]!;
  expect(notice.private_payload?.replyAddress).toEqual({agent:H,place:CHAT});
  const revision=await queueMessage(db,{roomId:THREAD,agentId:B,sourceMessageId:null,
    reason:'corner_brief_revision',parent:notice});
  const delivered=(await readAgentCommands(db,B,THREAD)).commands.find(command=>command.id===revision!.id)!;
  expect(delivered.from).toEqual({agent:A,place:CHAT});
  expect(delivered.returnRoomId).toBe(CHAT);
  await replyToMessage(db,B,{roomId:THREAD,id:revision!.id,text:'Blocked by the revised prerequisite'});
  const replies=(await readAgentCommands(db,A,CHAT)).commands.filter(command=>command.reason==='reply');
  expect(replies).toHaveLength(1);
  expect(replies[0]!.source.body).toBe('Blocked by the revised prerequisite');
  expect(replies[0]!.from).toEqual({agent:B,place:THREAD});
  expect((await db.query("SELECT id FROM messages WHERE author_id=$1 AND presentation='message'",[B])).rows).toEqual([]);
});

it.each(['queue','answer'] as const)('parking a thread retires its queued idle notice at %s',async boundary=>{
  await idleThread();
  await refreshCornerAttention(db,THREAD);
  const notice=(await db.query<CommandRow>("SELECT * FROM agent_commands WHERE private_payload->>'automatic'='true'")).rows[0]!;
  expect((await readAgentCommands(db,A,CHAT)).commands.map(command=>command.id)).toEqual([notice.id]);
  await updateWorkItem(db,{roomId:THREAD,state:'backlog'},H);
  if(boundary==='queue') expect((await readAgentCommands(db,A,CHAT)).commands).toEqual([]);
  else await replyToMessage(db,A,{roomId:CHAT,id:notice.id,text:'Resume the thread'});
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[notice.id])).rows).toEqual([{state:'complete'}]);
  expect((await db.query('SELECT id FROM messages WHERE author_id=$1',[A])).rows).toEqual([]);
  expect(await queued()).toEqual([]);
});

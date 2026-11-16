import { it,expect } from 'vitest';
import { queueMessage } from './agent-command.js';
import { sendMessage,replyToMessage } from './agent-messaging.js';
import { answerQueuedMessage } from './agent-command.js';
import { modelText } from './message-origin.js';
import { refreshCornerAttention } from './corner-attention.js';
import { cornerIdleSql } from './corner-idle.js';
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

it('S8: replying to a System idle notice reaches the receiving commander task sender, without a self-wake',async()=>{
  await idleThread();
  await refreshCornerAttention(db,THREAD);
  const notice=(await db.query<{id:string}>("SELECT id FROM agent_commands WHERE private_payload->>'automatic'='true'")).rows[0]!;
  await replyToMessage(db,A,{id:notice.id,text:'I will resume widget work'});
  expect(await queued()).toEqual([]);
  expect((await db.query('SELECT room_id,author_id,text FROM messages WHERE author_id=$1',[A])).rows)
    .toEqual([{room_id:CHAT,author_id:A,text:'I will resume widget work'}]);
});

it('S8: a notice without a parent task retains its actual System sender and never self-wakes',async()=>{
  await idleThread(false);
  await refreshCornerAttention(db,THREAD);
  const notice=(await db.query<{id:string;message:{replyAddress?:unknown}}>("SELECT id,message FROM agent_commands WHERE private_payload->>'automatic'='true'")).rows[0]!;
  expect(notice.message.replyAddress).toBeUndefined();
  await replyToMessage(db,A,{id:notice.id,text:'I will resume widget work'});
  expect(await queued()).toEqual([]);
  expect((await db.query('SELECT room_id,author_id,text FROM messages WHERE author_id=$1',[A])).rows)
    .toEqual([{room_id:THREAD,author_id:A,text:'I will resume widget work'}]);
});

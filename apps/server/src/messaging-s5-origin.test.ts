import { it,expect } from 'vitest';
import { queueMessage,readAgentCommands } from './agent-command.js';
import { replyToMessage } from './agent-messaging.js';
import { SYSTEM_AUTHOR_ID,modelText,systemText } from './message-origin.js';
import { systemLine } from './system-line.js';
import { H,A,B,C,CHAT,THREAD,db,queued } from './messaging.test-support.js';

it('S5: a failing-check wake keeps its thread origin and replies to the task sender in the original chat',async()=>{
  // https://github.com/Beeline-Work/beeline/pull/59: Ruby was woken in the thread while its return place was Milo.
  await queueMessage(db,{roomId:THREAD,agentId:B,sourceMessageId:null,reason:'corner_objective',
    privatePayload:{kind:'message',text:modelText('Build widget'),authorId:A,fromRoomId:CHAT,
      route:{from:{agent:A,place:CHAT},to:{agent:B,place:THREAD}}}});
  await db.query("UPDATE agent_commands SET state='complete' WHERE room_id=$1",[THREAD]);
  const failure=await queueMessage(db,{roomId:THREAD,agentId:B,sourceMessageId:null,reason:'corner_check',
    privatePayload:{kind:'lifecycle',authorId:SYSTEM_AUTHOR_ID,fromRoomId:THREAD,text:systemText('Checks failed')}});
  const wake=(await readAgentCommands(db,B)).commands[0]!;
  expect(wake.from).toEqual({agent:SYSTEM_AUTHOR_ID,place:THREAD});
  expect(await queued()).toEqual([[B,THREAD]]);
  await replyToMessage(db,B,{id:failure!.id,text:'Need build access'});
  expect(await queued()).toEqual([[A,CHAT]]);
  const delivered=(await readAgentCommands(db,A)).commands[0]!;
  expect(delivered.from).toEqual({agent:B,place:THREAD});
  expect(delivered.roomId).toBe(CHAT);
  expect((await readAgentCommands(db,C)).commands).toEqual([]);
});

it('S5: a System event retains its thread commander even when its source line records a person actor',async()=>{
  await queueMessage(db,{roomId:THREAD,agentId:B,sourceMessageId:null,reason:'corner_objective',
    privatePayload:{kind:'message',authorId:A,fromRoomId:CHAT,text:modelText('Build widget'),
      route:{from:{agent:A,place:CHAT},to:{agent:B,place:THREAD}}}});
  await db.query("UPDATE agent_commands SET state='complete'");
  const note=await systemLine(db,{roomId:THREAD,authorId:H,subject:{kind:'github',name:'GitHub'},verb:'checks failed',kind:'check-failed'});
  const item=await queueMessage(db,{roomId:THREAD,agentId:B,sourceMessageId:note.id,reason:'corner_check'});
  expect((await readAgentCommands(db,B)).commands[0]!.from).toEqual({agent:SYSTEM_AUTHOR_ID,place:THREAD});
  await replyToMessage(db,B,{id:item!.id,text:'Build access is missing'});
  expect(await queued()).toEqual([[A,CHAT]]);
});

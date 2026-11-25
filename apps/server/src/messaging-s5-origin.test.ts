import { it,expect } from 'vitest';
import { queueMessage,readAgentCommands } from './agent-command.js';
import { SYSTEM_AUTHOR_ID,modelText,systemText } from './message-origin.js';
import { systemLine } from './system-line.js';
import { H,A,B,C,CHAT,THREAD,db,daemon,queued } from './messaging.test-support.js';

it('S5: a failing-check wake keeps its thread origin and reports to its commander',async()=>{
  await queueMessage(db,{roomId:THREAD,agentId:B,sourceMessageId:null,reason:'corner_objective',
    privatePayload:{kind:'message',text:modelText('Build widget'),authorId:A,fromRoomId:CHAT,
      route:{from:{agent:A,place:CHAT},to:{agent:B,place:THREAD}}}});
  await db.query("UPDATE agent_commands SET state='complete' WHERE room_id=$1",[THREAD]);
  const failure=await queueMessage(db,{roomId:THREAD,agentId:B,sourceMessageId:null,reason:'corner_check',
    privatePayload:{kind:'lifecycle',authorId:SYSTEM_AUTHOR_ID,fromRoomId:THREAD,text:systemText('Checks failed')}});
  const wake=(await readAgentCommands(db,B)).commands[0]!;
  expect(wake.from).toEqual({agent:SYSTEM_AUTHOR_ID,place:THREAD});
  expect(await queued()).toEqual([[B,THREAD]]);
  const turn = {roomId:THREAD,requestId:failure!.turn_request_id};
  await daemon.execute('message',{...turn,type:'blocked',text:'Need build access'},B);
  await daemon.execute('postRoomMessage',{...turn,text:''},B);
  expect(await queued()).toEqual([[A,CHAT]]);
  expect((await db.query('SELECT room_id FROM messages WHERE text=$1', ['Need build access'])).rows).toEqual([{room_id:CHAT}]);
  expect((await readAgentCommands(db,C)).commands).toEqual([]);
});

it('S5: a System event reports to its commander even when its source line records a person actor',async()=>{
  await queueMessage(db,{roomId:THREAD,agentId:B,sourceMessageId:null,reason:'corner_objective',
    privatePayload:{kind:'message',authorId:A,fromRoomId:CHAT,text:modelText('Build widget'),
      route:{from:{agent:A,place:CHAT},to:{agent:B,place:THREAD}}}});
  await db.query("UPDATE agent_commands SET state='complete'");
  const note=await systemLine(db,{roomId:THREAD,authorId:H,subject:{kind:'github',name:'GitHub'},verb:'checks failed',kind:'check-failed'});
  const item=await queueMessage(db,{roomId:THREAD,agentId:B,sourceMessageId:note.id,reason:'corner_check'});
  expect((await readAgentCommands(db,B)).commands[0]!.from).toEqual({agent:SYSTEM_AUTHOR_ID,place:THREAD});
  const turn = {roomId:THREAD,requestId:item!.turn_request_id};
  await daemon.execute('message',{...turn,type:'blocked',text:'Build access is missing'},B);
  await daemon.execute('postRoomMessage',{...turn,text:''},B);
  expect(await queued()).toEqual([[A,CHAT]]);
});

import { it,expect } from 'vitest';
import { AGENT_COMMAND_SCHEMA,queueMessage,readAgentCommands,answerQueuedMessage } from './agent-command.js';
import { replyToMessage } from './agent-messaging.js';
import { SYSTEM_AUTHOR_ID,modelText,systemText } from './message-origin.js';
import { A,B,CHAT,THREAD,db,queued } from './messaging.test-support.js';

it('S6: queued legacy order, report and corner_land items retain ids, text, origin and completion through cutover',async()=>{
  const task=await queueMessage(db,{roomId:THREAD,agentId:B,sourceMessageId:null,reason:'order',
    privatePayload:{kind:'order',authorId:A,fromRoomId:CHAT,text:modelText('Finish queued work')}});
  const report=await queueMessage(db,{roomId:CHAT,agentId:A,sourceMessageId:null,reason:'report',
    privatePayload:{kind:'report',authorId:B,fromRoomId:THREAD,text:modelText('Queued question')}});
  const land=await queueMessage(db,{roomId:THREAD,agentId:B,sourceMessageId:null,reason:'corner_land',
    privatePayload:{kind:'lifecycle',authorId:SYSTEM_AUTHOR_ID,fromRoomId:THREAD,text:systemText('A yes is recorded and checks passed. Call merge_corner through the normal merge gate.')}});
  await db.query(AGENT_COMMAND_SCHEMA);
  const delivered=(await readAgentCommands(db,B)).commands;
  expect(delivered.map(item=>item.id)).toEqual([task!.id,land!.id]);
  expect(delivered.find(item=>item.id===land!.id)!.source.body).toContain('The server merges');
  expect(delivered.find(item=>item.id===land!.id)!.source.body).not.toMatch(/merge_corner|merge_thread/);
  await replyToMessage(db,B,{id:task!.id,text:'Finished queued work'});
  await replyToMessage(db,A,{id:report!.id,text:'Continue'});
  await answerQueuedMessage(db,B,{roomId:THREAD,requestId:land!.id,text:'',harnessEnded:true});
  expect((await db.query("SELECT state FROM agent_commands WHERE id=ANY($1::text[])",[[task!.id,report!.id,land!.id]])).rows)
    .toEqual([{state:'complete'},{state:'complete'},{state:'complete'}]);
  expect(await queued()).toEqual([[A,CHAT],[B,THREAD]]);
});

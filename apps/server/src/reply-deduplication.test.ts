import { randomUUID } from 'node:crypto';
import { beginAgentInvocation } from './agent-invocation.js';
import { it,expect } from 'vitest';
import { sendMessage,replyToMessage } from './agent-messaging.js';
import { answerQueuedMessage } from './agent-command.js';
import { H,B,CHAT,OTHER,db } from './messaging.test-support.js';

const task=()=>sendMessage(db,{route:{from:{agent:H,place:CHAT},to:{agent:B,place:CHAT}},text:'Please answer'});
const answers=async(place=CHAT)=>(await db.query('SELECT id,text FROM messages WHERE author_id=$1 AND room_id=$2 AND presentation<>\'activity\'',[B,place])).rows;
it('dup-reply-1: reply and closing text each publish once',async()=>{
 const request=await task();
 const reply=await replyToMessage(db,B,{roomId:CHAT,id:request.id,text:'Done'});
 const final=await answerQueuedMessage(db,B,{roomId:CHAT,requestId:request.id,text:'Done again'});
 expect(final.id).not.toBe(reply.id);expect(await answers()).toHaveLength(2);
});
it('dup-reply-2: reply and empty completion retain the delivered answer',async()=>{
 const request=await task();const reply=await replyToMessage(db,B,{roomId:CHAT,id:request.id,text:'Done'});
 expect(await answerQueuedMessage(db,B,{roomId:CHAT,requestId:request.id,text:'',harnessEnded:true}))
  .toMatchObject({commandId:request.id,messageId:reply.id,completed:true,published:true,delivered:true});
 expect(await answers()).toHaveLength(1);
});
it('retries with different transport ids publish once',async()=>{
 const request=await task();
 const first=await replyToMessage(db,B,{roomId:CHAT,id:request.id,text:'Done',messageId:'e'.repeat(64)});
 const retry=await replyToMessage(db,B,{roomId:CHAT,id:request.id,text:'Done',messageId:'f'.repeat(64)});
 expect(retry.id).toBe(first.id);expect(await answers()).toHaveLength(1);
});
it('an answer for another request and place leaves the original answer owed',async()=>{
 const request=await task();
 const elsewhere=await sendMessage(db,{route:{from:{agent:H,place:OTHER},to:{agent:B,place:CHAT}},text:'Other request'});
 await replyToMessage(db,B,{roomId:CHAT,id:elsewhere.id,text:'Done'});
 await answerQueuedMessage(db,B,{roomId:CHAT,requestId:request.id,text:'Original answer'});
 expect(await answers()).toHaveLength(1);expect(await answers(OTHER)).toHaveLength(1);
});
it('failed reply permits final delivery',async()=>{
 const request=await task();
 await expect(replyToMessage(db,B,{roomId:CHAT,id:'missing',text:'Done'})).rejects.toThrow('Quote a message');
 await answerQueuedMessage(db,B,{roomId:CHAT,requestId:request.id,text:'Final answer'});
 expect(await answers()).toMatchObject([{text:'Final answer'}]);
});
it('different requests with identical answers both publish',async()=>{
 for(let i=0;i<2;i++){const request=await task();await replyToMessage(db,B,{roomId:CHAT,id:request.id,text:'Done'});}
 expect(await answers()).toHaveLength(2);
});
it('only the final confirmed reply in the current batch marks the native turn complete',async()=>{
 const first=await task(),second=await task();
 const context={roomId:CHAT,queuedRequestIds:[first.id,second.id]};
 expect(await replyToMessage(db,B,{...context,id:first.id,text:'First'})).not.toHaveProperty('_meta');
 expect(await replyToMessage(db,B,{...context,id:second.id,text:'Second'})).toHaveProperty('_meta.beeline.turnComplete',true);
});
it('a reply elsewhere cannot mark the current native turn complete',async()=>{
 const current=await task();
 const other=await sendMessage(db,{route:{from:{agent:H,place:OTHER},to:{agent:B,place:OTHER}},text:'Other'});
 await expect(replyToMessage(db,B,{id:other.id,text:'Other answer',roomId:CHAT,queuedRequestIds:[current.id]})).rejects.toThrow('Quote a message');
 expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[current.id])).rows).toEqual([{state:'pending'}]);
});
it('a prior reply in a batch does not consume closing text owed to another request',async()=>{
 const first=await task(),second=await task();
 const invocation={id:randomUUID(),requestId:first.id};
 await beginAgentInvocation(db,B,CHAT,first.id,invocation.id);
 await replyToMessage(db,B,{roomId:CHAT,id:first.id,text:'First answer',invocation});
 await answerQueuedMessage(db,B,{roomId:CHAT,requestId:second.id,queuedRequestIds:[first.id,second.id],text:'Second answer',harnessEnded:true,invocation});
 expect((await answers()).map(row=>row.text).sort()).toEqual(['First answer','Second answer']);
});
it('a receipt for the same request at the wrong destination leaves a final answer at the original place',async()=>{
 const current=await task();const reply=await replyToMessage(db,B,{roomId:CHAT,id:current.id,text:'Answer'});
 await db.query('UPDATE messages SET room_id=$2 WHERE id=$1',[reply.id,OTHER]);
 await answerQueuedMessage(db,B,{roomId:CHAT,requestId:current.id,text:'Original place answer'});
 expect((await answers()).map(row=>row.text)).toEqual(['Original place answer']);
});

it('a follow-up ask reaches its recipient and retries publish once',async()=>{
 const request=await task();
 const context={roomId:CHAT,queuedRequestIds:[request.id]};
 await replyToMessage(db,B,{...context,id:request.id,text:'Inspected'});
 const input={...context,id:request.id,text:'Which output?',ask:{question:'Which output?',options:['Web','Phone']}};
 const question=await replyToMessage(db,B,input);
 expect(question).not.toHaveProperty('_meta');
 expect(await replyToMessage(db,B,input)).toMatchObject({id:question.id});
 expect(await answers()).toHaveLength(2);
 expect((await db.query('SELECT message_id FROM work_questions WHERE message_id=$1',[question.id])).rows).toHaveLength(1);
});
it('an earlier ask in the batch prevents a later reply from ending the native turn',async()=>{
 const first=await task(),second=await task();
 const context={roomId:CHAT,queuedRequestIds:[first.id,second.id]};
 expect(await replyToMessage(db,B,{...context,id:first.id,text:'Which output?',ask:{question:'Which output?',options:['Web','Phone']}})).not.toHaveProperty('_meta');
 expect(await replyToMessage(db,B,{...context,id:second.id,text:'Done'})).not.toHaveProperty('_meta');
});

const activityNotes=async()=>(await db.query(`SELECT activity FROM messages WHERE author_id=$1 AND room_id=$2 AND presentation='activity'`,[B,CHAT])).rows
 .flatMap(row=>(row.activity as {kind:string;text?:string}[]).filter(step=>step.kind==='note').map(step=>step.text));
it('grunt-dup-1127: a same-place reply keeps the reworded closing text out of the chat',async()=>{
 const request=await task();
 const invocation={id:randomUUID(),requestId:request.id};
 await beginAgentInvocation(db,B,CHAT,request.id,invocation.id);
 const reply=await replyToMessage(db,B,{roomId:CHAT,id:request.id,text:'Squire needs an upgrade.',invocation});
 // The Claude SDK "no visible output" retry produces this text after the reply.
 const input={roomId:CHAT,requestId:request.id,text:'I replied in #grunt. Squire needs an upgrade before the next run.',harnessEnded:true,invocation,
  steps:[{kind:'tool',title:'message',operation:'tool',status:'completed'}]};
 expect(await answerQueuedMessage(db,B,input)).toMatchObject({messageId:reply.id,completed:true,published:true});
 expect(await answerQueuedMessage(db,B,input)).toMatchObject({messageId:reply.id,completed:true});
 expect((await answers()).map(row=>row.text)).toEqual(['Squire needs an upgrade.']);
 expect(await activityNotes()).toEqual([input.text]);
});
it('a same-place reply suppresses closing text without an invocation too',async()=>{
 const request=await task();
 await replyToMessage(db,B,{roomId:CHAT,id:request.id,text:'Done'});
 await answerQueuedMessage(db,B,{roomId:CHAT,requestId:request.id,text:'All done, see above.',harnessEnded:true});
 expect((await answers()).map(row=>row.text)).toEqual(['Done']);
 expect(await activityNotes()).toEqual(['All done, see above.']);
});
it('a reply in another place leaves the closing text published here',async()=>{
 const request=await task();const reply=await replyToMessage(db,B,{roomId:CHAT,id:request.id,text:'Answer'});
 await db.query('UPDATE messages SET room_id=$2 WHERE id=$1',[reply.id,OTHER]);
 await answerQueuedMessage(db,B,{roomId:CHAT,requestId:request.id,text:'Final here',harnessEnded:true});
 expect((await answers()).map(row=>row.text)).toEqual(['Final here']);
 expect(await activityNotes()).toEqual([]);
});
it('a deleted same-place reply leaves the closing text published',async()=>{
 const request=await task();const reply=await replyToMessage(db,B,{roomId:CHAT,id:request.id,text:'Answer'});
 await db.query('UPDATE messages SET deleted_at=now() WHERE id=$1',[reply.id]);
 await answerQueuedMessage(db,B,{roomId:CHAT,requestId:request.id,text:'Final here',harnessEnded:true});
 expect((await db.query('SELECT text FROM messages WHERE author_id=$1 AND room_id=$2 AND presentation<>\'activity\' AND deleted_at IS NULL',[B,CHAT])).rows)
  .toEqual([{text:'Final here'}]);
});
it('a verdict that must publish still posts after a same-place reply',async()=>{
 const request=await task();
 await replyToMessage(db,B,{roomId:CHAT,id:request.id,text:'Looking'});
 await answerQueuedMessage(db,B,{roomId:CHAT,requestId:request.id,text:'Approved',harnessEnded:true,keepFinal:true});
 expect((await answers()).map(row=>row.text).sort()).toEqual(['Approved','Looking']);
});

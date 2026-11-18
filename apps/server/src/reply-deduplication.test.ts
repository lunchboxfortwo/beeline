import { it,expect } from 'vitest';
import { sendMessage,replyToMessage } from './agent-messaging.js';
import { answerQueuedMessage } from './agent-command.js';
import { H,B,CHAT,OTHER,db } from './messaging.test-support.js';

const task=()=>sendMessage(db,{route:{from:{agent:H,place:CHAT},to:{agent:B,place:CHAT}},text:'Please answer'});
const answers=async(place=CHAT)=>(await db.query('SELECT id,text FROM messages WHERE author_id=$1 AND room_id=$2 AND presentation<>\'activity\'',[B,place])).rows;
it('dup-reply-1: reply and closing text publish one answer',async()=>{
 const request=await task();
 const reply=await replyToMessage(db,B,{id:request.id,text:'Done'});
 const final=await answerQueuedMessage(db,B,{roomId:CHAT,requestId:request.id,text:'Done again'});
 expect(final.id).toBe(reply.id);expect(await answers()).toHaveLength(1);
});
it('dup-reply-2: reply and empty completion retain the delivered answer',async()=>{
 const request=await task();await replyToMessage(db,B,{id:request.id,text:'Done'});
 expect(await answerQueuedMessage(db,B,{roomId:CHAT,requestId:request.id,text:'',harnessEnded:true})).toMatchObject({delivered:true});
 expect(await answers()).toHaveLength(1);
});
it('retries with different transport ids publish once',async()=>{
 const request=await task();
 const first=await replyToMessage(db,B,{id:request.id,text:'Done',messageId:'e'.repeat(64)});
 const retry=await replyToMessage(db,B,{id:request.id,text:'Done',messageId:'f'.repeat(64)});
 expect(retry.id).toBe(first.id);expect(await answers()).toHaveLength(1);
});
it('an answer for another request and place leaves the original answer owed',async()=>{
 const request=await task();
 const elsewhere=await sendMessage(db,{route:{from:{agent:H,place:OTHER},to:{agent:B,place:CHAT}},text:'Other request'});
 await replyToMessage(db,B,{id:elsewhere.id,text:'Done'});
 await answerQueuedMessage(db,B,{roomId:CHAT,requestId:request.id,text:'Original answer'});
 expect(await answers()).toHaveLength(1);expect(await answers(OTHER)).toHaveLength(1);
});
it('failed reply permits final delivery',async()=>{
 const request=await task();
 await expect(replyToMessage(db,B,{id:'missing',text:'Done'})).rejects.toThrow();
 await answerQueuedMessage(db,B,{roomId:CHAT,requestId:request.id,text:'Final answer'});
 expect(await answers()).toHaveLength(1);
});
it('different requests with identical answers both publish',async()=>{
 for(let i=0;i<2;i++){const request=await task();await replyToMessage(db,B,{id:request.id,text:'Done'});}
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
 expect(await replyToMessage(db,B,{id:other.id,text:'Other answer',roomId:CHAT,queuedRequestIds:[current.id]})).not.toHaveProperty('_meta');
});
it('a prior reply in a batch does not consume closing text owed to another request',async()=>{
 const first=await task(),second=await task();
 await replyToMessage(db,B,{id:first.id,text:'First answer'});
 await answerQueuedMessage(db,B,{roomId:CHAT,requestId:first.id,queuedRequestIds:[first.id,second.id],text:'Second answer'});
 expect((await answers()).map(row=>row.text).sort()).toEqual(['First answer','Second answer']);
});
it('a receipt for the same request at the wrong destination leaves a final answer at the original place',async()=>{
 const current=await task();const reply=await replyToMessage(db,B,{id:current.id,text:'Answer'});
 await db.query('UPDATE messages SET room_id=$2 WHERE id=$1',[reply.id,OTHER]);
 await answerQueuedMessage(db,B,{roomId:CHAT,requestId:current.id,text:'Original place answer'});
 expect((await answers()).map(row=>row.text)).toEqual(['Original place answer']);
});

it('a follow-up ask after an informational answer stays owed and retries publish once',async()=>{
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

import { it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { beginAgentInvocation } from './agent-invocation.js';
import { sendMessage,replyToMessage } from './agent-messaging.js';
import { answerQueuedMessage } from './agent-command.js';
import { H,A,B,C,CHAT,OTHER,db } from './messaging.test-support.js';

const task=()=>sendMessage(db,{route:{from:{agent:H,place:CHAT},to:{agent:B,place:CHAT}},text:'Please answer'});
const answers=async(place=CHAT)=>(await db.query('SELECT id,text FROM messages WHERE author_id=$1 AND room_id=$2 AND presentation IN (\'message\',\'card\')',[B,place])).rows;
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
it('a reply for another request and place suppresses the invocation final and leaves its request owed',async()=>{
 const request=await task();
 const elsewhere=await sendMessage(db,{route:{from:{agent:H,place:OTHER},to:{agent:B,place:CHAT}},text:'Other request'});
 const invocation=await invocationFor(request.id);
 await replyToMessage(db,B,{id:elsewhere.id,text:'Done',roomId:CHAT,invocation});
 expect(await answerQueuedMessage(db,B,{roomId:CHAT,requestId:request.id,text:'Original answer',harnessEnded:true,invocation})).toMatchObject({suppressed:true,answered:false});
 expect(await state(request.id)).toBe('pending');
 expect(await answers()).toHaveLength(0);expect(await answers(OTHER)).toHaveLength(1);
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
it('a prior reply suppresses closing text across the batch without settling its sibling',async()=>{
 const first=await task(),second=await task();
 const invocation=await invocationFor(first.id);
 await replyToMessage(db,B,{id:first.id,text:'First answer',roomId:CHAT,invocation});
 expect(await answerQueuedMessage(db,B,{roomId:CHAT,requestId:second.id,queuedRequestIds:[first.id,second.id],text:'Second answer',harnessEnded:true,invocation})).toMatchObject({suppressed:true,answered:false});
 expect((await answers()).map(row=>row.text)).toEqual(['First answer']);
 expect(await state(first.id)).toBe('complete');expect(await state(second.id)).toBe('pending');
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
 const input={...context,id:request.id,text:'Which output?',ask:{question:'Which output?',brief: 'It decides the next step.', options:['Web','Phone']}};
 const question=await replyToMessage(db,B,input);
 expect(question).not.toHaveProperty('_meta');
 expect(await replyToMessage(db,B,input)).toMatchObject({id:question.id});
 expect(await answers()).toHaveLength(2);
 expect((await db.query('SELECT message_id FROM work_questions WHERE message_id=$1',[question.id])).rows).toHaveLength(1);
});
it('an earlier ask in the batch prevents a later reply from ending the native turn',async()=>{
 const first=await task(),second=await task();
 const context={roomId:CHAT,queuedRequestIds:[first.id,second.id]};
 expect(await replyToMessage(db,B,{...context,id:first.id,text:'Which output?',ask:{question:'Which output?',brief: 'It decides the next step.', options:['Web','Phone']}})).not.toHaveProperty('_meta');
 expect(await replyToMessage(db,B,{...context,id:second.id,text:'Done'})).not.toHaveProperty('_meta');
});

async function invocationFor(requestId:string,roomId=CHAT) {
 const invocation={id:randomUUID(),requestId};
 await beginAgentInvocation(db,B,roomId,requestId,invocation.id);return invocation;
}
async function state(id:string){return (await db.query('SELECT state FROM agent_commands WHERE id=$1',[id])).rows[0]?.state;}
it('Beebee: replying to an old visibly failed request suppresses the new tag recap, including replay',async()=>{
 const old=await task();
 const {failHostedAgentTurn}=await import('./agent-turn-end.js');
 await db.transaction(async tx=>{await failHostedAgentTurn(tx,{id:old.id,room_id:CHAT,return_room_id:CHAT,turn_request_id:old.id},B,'Provider failed');});
 const current=await task(),invocation=await invocationFor(current.id);
 const reply=await replyToMessage(db,B,{id:old.id,text:'Old answer',roomId:CHAT,invocation});
 const final={roomId:CHAT,requestId:current.id,text:'Replied to the older request',harnessEnded:true,invocation};
 for(let i=0;i<2;i++)expect(await answerQueuedMessage(db,B,final)).toMatchObject({suppressed:true,answered:false});
 expect(await answers()).toEqual([{id:reply.id,text:'Old answer'}]);expect(await state(current.id)).toBe('pending');
 expect((await db.query("SELECT 1 FROM messages WHERE presentation='activity'")).rowCount).toBe(0);
 expect((await db.query('SELECT replied,final_suppressed FROM agent_invocations WHERE invocation_id=$1',[invocation.id])).rows).toEqual([{replied:true,final_suppressed:true}]);
});
it('receipt survives deleted delivery, late start replay, and does not leak into the next attempt',async()=>{
 const current=await task(),old=await task(),invocation=await invocationFor(current.id);
 const reply=await replyToMessage(db,B,{id:old.id,text:'Old',roomId:CHAT,invocation});
 await db.query('UPDATE messages SET deleted_at=now() WHERE id=$1',[reply.id]);
 await beginAgentInvocation(db,B,CHAT,current.id,invocation.id);
 expect(await answerQueuedMessage(db,B,{roomId:CHAT,requestId:current.id,text:'Recap',harnessEnded:true,invocation})).toMatchObject({suppressed:true});
 const next=await invocationFor(current.id);
 expect(await answerQueuedMessage(db,B,{roomId:CHAT,requestId:current.id,text:'Actual result',harnessEnded:true,invocation:next})).not.toHaveProperty('suppressed');
 expect(await state(current.id)).toBe('complete');
});
it.each(['empty','invalid ask','missing target','archived'])('an undelivered %s reply does not suppress final fallback',async(kind)=>{
 const current=await task(),invocation=await invocationFor(current.id);
 const target=await sendMessage(db,{route:{from:{agent:H,place:OTHER},to:{agent:B,place:CHAT}},text:'Other'});
 if(kind==='archived')await db.query('UPDATE rooms SET archived_at=now() WHERE id=$1',[OTHER]);
 const attempt=replyToMessage(db,B,{roomId:CHAT,invocation,id:kind==='missing target'?'missing':target.id,text:kind==='empty'?'':'Answer',
  ...(kind==='invalid ask'?{ask:{question:'Invalid',brief: 'It decides the next step.', options:[]}}:{})});
 if(kind==='missing target'||kind==='invalid ask')await expect(attempt).rejects.toThrow();else await attempt;
 expect(await answerQueuedMessage(db,B,{roomId:CHAT,requestId:current.id,text:'Final',harnessEnded:true,invocation})).not.toHaveProperty('suppressed');
 expect((await answers()).map(row=>row.text)).toEqual(['Final']);
});
it('a rolled-back reply leaves no marker; a committed reply with a lost tool response does',async()=>{
 const current=await task(),target=await task(),invocation=await invocationFor(current.id);
 await expect(db.transaction(async tx=>{await replyToMessage(tx,B,{roomId:CHAT,invocation,id:target.id,text:'Answer'});throw new Error('rollback');})).rejects.toThrow('rollback');
 expect((await db.query('SELECT replied FROM agent_invocations WHERE invocation_id=$1',[invocation.id])).rows[0]).toEqual({replied:false});
 await replyToMessage(db,B,{roomId:CHAT,invocation,id:target.id,text:'Answer',messageId:'a'.repeat(64)}); // drop transport response
 await replyToMessage(db,B,{roomId:CHAT,invocation,id:target.id,text:'Answer',messageId:'b'.repeat(64)});
 expect(await answerQueuedMessage(db,B,{roomId:CHAT,requestId:current.id,text:'Recap',harnessEnded:true,invocation})).toMatchObject({suppressed:true});
 expect(await answers()).toHaveLength(1);
});
it('a delivered ask suppresses recap without declaring the turn complete',async()=>{
 const current=await task(),invocation=await invocationFor(current.id);
 const question=await replyToMessage(db,B,{roomId:CHAT,invocation,id:current.id,text:'Choose',queuedRequestIds:[current.id],ask:{question:'Which?',brief: 'It decides the next step.', options:['A','B']}});
 expect(question).not.toHaveProperty('_meta');
 expect(await answerQueuedMessage(db,B,{roomId:CHAT,requestId:current.id,text:'Asked a question',harnessEnded:true,invocation})).toMatchObject({suppressed:true});
 expect(await answers()).toHaveLength(1);
});
it('an explicit message elsewhere and an independent place invocation retain final fallback',async()=>{
 const current=await task(),invocation=await invocationFor(current.id);
 await sendMessage(db,{route:{from:{agent:B,place:CHAT},to:{agent:H,place:OTHER}},text:'Explicit post'});
 expect(await answerQueuedMessage(db,B,{roomId:CHAT,requestId:current.id,text:'Final answer',harnessEnded:true,invocation})).not.toHaveProperty('suppressed');
 const other=await sendMessage(db,{route:{from:{agent:H,place:OTHER},to:{agent:B,place:OTHER}},text:'Parallel task'});
 const parallel=await invocationFor(other.id,OTHER);
 expect(await answerQueuedMessage(db,B,{roomId:OTHER,requestId:other.id,text:'Parallel result',harnessEnded:true,invocation:parallel})).not.toHaveProperty('suppressed');
});
it('unbound invocation metadata cannot suppress a final or borrow another place',async()=>{
 const current=await task(),invocation=await invocationFor(current.id);
 await expect(answerQueuedMessage(db,B,{roomId:OTHER,requestId:current.id,text:'Final',harnessEnded:true,invocation})).rejects.toThrow('unknown invocation');
 await expect(replyToMessage(db,B,{roomId:CHAT,invocation:{...invocation,id:'invented'},id:current.id,text:'Answer'})).rejects.toThrow('unknown invocation');
});

it.each([H,A,C])('suppression before fanout preserves a sibling from recipient %s and its staged files',async sender=>{
 const first=await task();
 const sibling=await sendMessage(db,{route:{from:{agent:sender,place:OTHER},to:{agent:B,place:CHAT}},text:'Separate owed request'});
 const invocation=await invocationFor(first.id);
 await db.query(`UPDATE agent_commands SET answer_attachments=$2::jsonb WHERE id=$1`,[sibling.id,JSON.stringify([{url:'https://files.test/result',name:'result.txt',mimeType:'text/plain',size:1}])]);
 await replyToMessage(db,B,{roomId:CHAT,invocation,id:first.id,text:'First answer'});
 expect(await answerQueuedMessage(db,B,{roomId:CHAT,requestId:sibling.id,queuedRequestIds:[first.id,sibling.id],text:'Recap across people',harnessEnded:true,invocation})).toMatchObject({suppressed:true});
 expect((await db.query('SELECT 1 FROM messages WHERE text=$1',['Recap across people'])).rowCount).toBe(0);
 expect((await db.query('SELECT state,jsonb_array_length(answer_attachments) files FROM agent_commands WHERE id=$1',[sibling.id])).rows).toEqual([{state:'pending',files:1}]);
});
it('a failed invocation receipt write rolls the reply back atomically',async()=>{
 const current=await task(),target=await task(),invocation=await invocationFor(current.id);
 await db.query(`CREATE FUNCTION refuse_invocation_reply() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   IF NEW.replied THEN RAISE EXCEPTION 'receipt failed'; END IF; RETURN NEW; END $$;
   CREATE TRIGGER refuse_invocation_reply BEFORE UPDATE ON agent_invocations FOR EACH ROW EXECUTE FUNCTION refuse_invocation_reply()`);
 try{await expect(replyToMessage(db,B,{roomId:CHAT,invocation,id:target.id,text:'Must roll back'})).rejects.toThrow('receipt failed');}
 finally{await db.query('DROP TRIGGER refuse_invocation_reply ON agent_invocations;DROP FUNCTION refuse_invocation_reply()');}
 expect(await state(target.id)).toBe('pending');expect(await answers()).toHaveLength(0);
 expect(await answerQueuedMessage(db,B,{roomId:CHAT,requestId:current.id,text:'Actual answer',harnessEnded:true,invocation})).not.toHaveProperty('suppressed');
});
it('an early terminal acknowledgement intentionally suppresses the only later implicit result',async()=>{
 const current=await task(),invocation=await invocationFor(current.id);
 await replyToMessage(db,B,{roomId:CHAT,invocation,id:current.id,text:'On it'});
 expect(await answerQueuedMessage(db,B,{roomId:CHAT,requestId:current.id,text:'The actual result',harnessEnded:true,invocation})).toMatchObject({suppressed:true});
 expect((await answers()).map(row=>row.text)).toEqual(['On it']);
 await sendMessage(db,{route:{from:{agent:B,place:CHAT},to:{agent:H,place:CHAT}},text:'Explicit actual result'});
 expect((await answers()).map(row=>row.text)).toEqual(['On it','Explicit actual result']);
});

it('a confirmed reply in P leaves a simultaneous invocation in P2 eligible for its own final',async()=>{
 const current=await task(),invocation=await invocationFor(current.id);
 const parallel=await sendMessage(db,{route:{from:{agent:H,place:OTHER},to:{agent:B,place:OTHER}},text:'Parallel request'});
 const otherInvocation=await invocationFor(parallel.id,OTHER);
 await replyToMessage(db,B,{roomId:CHAT,invocation,id:current.id,text:'Explicit answer in P'});
 expect(await answerQueuedMessage(db,B,{roomId:CHAT,requestId:current.id,text:'Recap P',harnessEnded:true,invocation})).toMatchObject({suppressed:true});
 expect(await answerQueuedMessage(db,B,{roomId:OTHER,requestId:parallel.id,text:'Parallel final',harnessEnded:true,invocation:otherInvocation})).not.toHaveProperty('suppressed');
 expect((await answers(OTHER)).map(row=>row.text)).toEqual(['Parallel final']);
});
it('an agent-directed ask suppresses recap and preserves its separate response obligation',async()=>{
 const current=await sendMessage(db,{route:{from:{agent:A,place:OTHER},to:{agent:B,place:CHAT}},text:'Please inspect'});
 const invocation=await invocationFor(current.id);
 const question=await replyToMessage(db,B,{roomId:CHAT,invocation,id:current.id,text:'Which scope?',queuedRequestIds:[current.id],ask:{question:'Which scope?',brief: 'It decides the next step.', options:['Small','Full']}});
 expect(question).not.toHaveProperty('_meta');
 expect(await answerQueuedMessage(db,B,{roomId:CHAT,requestId:current.id,text:'Asked A',harnessEnded:true,invocation})).toMatchObject({suppressed:true});
 expect((await db.query("SELECT 1 FROM agent_commands WHERE id=$1 AND agent_id=$2 AND state='pending' AND private_payload->>'messageAsk' IS NOT NULL",[question.id,A])).rowCount).toBe(1);
});

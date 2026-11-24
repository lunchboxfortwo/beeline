import { afterEach, expect, it } from 'vitest';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { queueMessage } from './agent-command.js';
import { RoomsMcpAgentTools } from './rooms-mcp-agent.js';
import { sendMessage } from './agent-messaging.js';
import { expectThreadRouting } from './reply-routing-invariants.test-support.js';
import { A,B,C,H,CHAT,THREAD,OTHER,db,daemon } from './messaging.test-support.js';

afterEach(() => expectThreadRouting(db));

const task = (agent:string, place:string, source=CHAT) => sendMessage(db,{
  route:{from:{agent,place:source},to:{agent:B,place}},text:'Count the widgets',
});
const output = (roomId:string,requestId:string,text:string) =>
  daemon.execute('postRoomMessage',{roomId,requestId,text,harnessEnded:true},B);
const report = (roomId:string,id:string,text:string) => daemon.execute('reply',{roomId,id,text},B);

it('interleaves two thread sessions without mixing their output or report recipients', async () => {
  await db.query('UPDATE rooms SET parent_id=$2 WHERE id=$1',[OTHER,CHAT]);
  const first = await task(H,THREAD);
  const second = await task(C,OTHER);
  await output(THREAD,first.id,'12 widgets');
  await output(OTHER,second.id,'3 widgets');
  const wrong = await report(OTHER,first.id,'Working note');
  expect(wrong.receipt).toContain('posted');
  const one = await report(THREAD,first.id,'done: counted twelve');
  const two = await report(OTHER,second.id,'done: counted three');
  expect((await db.query("SELECT room_id,text FROM messages WHERE author_id=$1 AND card IS NULL ORDER BY text",[B])).rows)
    .toEqual([{room_id:THREAD,text:'12 widgets'},{room_id:OTHER,text:'3 widgets'},{room_id:OTHER,text:'Working note'}]);
  expect((await db.query("SELECT room_id,card->'route'->'to' recipient FROM messages WHERE id=$1",[one.id])).rows)
    .toEqual([{room_id:CHAT,recipient:{agent:H,place:CHAT}}]);
  expect((await db.query("SELECT parent_command_id,message->'route' route FROM agent_commands WHERE id=$1",[two.id])).rows)
    .toEqual([{parent_command_id:second.id,route:{from:{agent:B,place:OTHER},to:{agent:C,place:CHAT}}}]);
});

it('binds connected-app writes to the received command when two tasks are pending', async () => {
  const one=await task(H,THREAD), two=await task(C,OTHER);
  const app=new RoomsMcpAgentTools(db,daemon);
  await app.call(B,'reply',{commandId:two.id,id:one.id,text:'Local note'});
  await app.call(B,'message',{commandId:two.id,to:{agent:A,place:CHAT},text:'Inspect'});
  expect((await db.query('SELECT room_id FROM messages WHERE text=$1',['Local note'])).rows).toEqual([{room_id:OTHER}]);
  expect((await db.query("SELECT state FROM agent_commands WHERE id=$1",[one.id])).rows).toEqual([{state:'pending'}]);
  expect((await db.query("SELECT message->'route'->'from' sender,parent_command_id FROM agent_commands WHERE agent_id=$1",[A])).rows)
    .toEqual([{sender:{agent:B,place:OTHER},parent_command_id:two.id}]);
});

it.each([true,false])('keeps file-only output home with report first=%s', async reportFirst => {
  const work=await task(A,THREAD);
  const file={name:'counts.txt',mimeType:'text/plain',size:12,url:'https://files.test/counts'};
  await db.query('UPDATE agent_commands SET answer_attachments=$2 WHERE id=$1',[work.id,JSON.stringify([file])]);
  if (reportFirst) await report(THREAD,work.id,'done: counted');
  const local=await output(THREAD,work.id,'');
  if (!reportFirst) await report(THREAD,work.id,'done: counted');
  const late=await report(THREAD,work.id,'done: second report');
  expect((await db.query('SELECT room_id,attachments FROM messages WHERE id=$1',[local.id])).rows)
    .toEqual([{room_id:THREAD,attachments:[file]}]);
  expect((await db.query('SELECT room_id,attachments FROM messages WHERE text=$1',['done: counted'])).rows)
    .toEqual([{room_id:CHAT,attachments:[]}]);
  expect((await db.query('SELECT room_id FROM messages WHERE id=$1',[late.id])).rows).toEqual([{room_id:THREAD}]);
});

it('finishes a chat order silently when the worker only produces output', async () => {
  const work=await task(A,OTHER);
  const result=await output(OTHER,work.id,'Counts ready');
  expect((await db.query('SELECT state,result_message_id FROM agent_commands WHERE id=$1',[work.id])).rows)
    .toEqual([{state:'complete',result_message_id:result.id}]);
  expect((await db.query('SELECT room_id FROM messages WHERE author_id=$1',[B])).rows).toEqual([{room_id:OTHER}]);
  expect((await db.query('SELECT id FROM agent_commands WHERE agent_id=$1',[A])).rows).toEqual([]);
});

it('a watched event from an archived thread completes in the watching chat', async () => {
  const item=await queueMessage(db,{roomId:CHAT,agentId:B,sourceMessageId:null,reason:'system',
    privatePayload:{kind:'lifecycle',text:'Thread merged',authorId:SYSTEM_IDENTITY_ID,fromRoomId:THREAD,
      route:{from:{agent:SYSTEM_IDENTITY_ID,place:THREAD},to:{agent:B,place:CHAT}}}});
  await db.query('UPDATE rooms SET archived_at=now() WHERE id=$1',[THREAD]);
  const result=await report(CHAT,item!.id,'done: merge observed');
  expect((await db.query('SELECT room_id FROM messages WHERE id=$1',[result.id])).rows).toEqual([{room_id:CHAT}]);
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[item!.id])).rows).toEqual([{state:'complete'}]);
});

it('returns a reviewer continuation to the implementer in the reviewed thread', async () => {
  await db.query('UPDATE rooms SET reviewer_agent_id=$1 WHERE id=$2',[C,CHAT]);
  await task(H,THREAD);
  const review=await queueMessage(db,{roomId:THREAD,agentId:C,sourceMessageId:null,reason:'corner_review_dispatch'});
  const resumed=await queueMessage(db,{roomId:THREAD,agentId:C,sourceMessageId:null,reason:'vault_saved',parent:review!});
  const result=await daemon.execute('reply',{roomId:THREAD,id:resumed!.id,text:'done: review complete'},C);
  expect((await db.query("SELECT parent_command_id,message->'route' route FROM agent_commands WHERE id=$1",[result.id])).rows)
    .toEqual([{parent_command_id:resumed!.id,route:{from:{agent:C,place:THREAD},to:{agent:B,place:THREAD}}}]);
});

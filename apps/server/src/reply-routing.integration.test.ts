import { afterEach, expect, it } from 'vitest';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { queueMessage } from './agent-command.js';
import { RoomsMcpAgentTools } from './rooms-mcp-agent.js';
import { sendMessage,replyToMessage } from './agent-messaging.js';
import { expectThreadRouting } from './reply-routing-invariants.test-support.js';
import { A,B,C,H,CHAT,THREAD,OTHER,db,daemon } from './messaging.test-support.js';

afterEach(() => expectThreadRouting(db));

const task = (agent:string, place:string, source=CHAT) => sendMessage(db,{
  route:{from:{agent,place:source},to:{agent:B,place}},text:'Count the widgets',
});
const output = (roomId:string,requestId:string,text:string) =>
  daemon.execute('postRoomMessage',{roomId,requestId,text,harnessEnded:true},B);
const report = (roomId:string,id:string,text:string) => replyToMessage(db,B,{roomId,id,text});

it('routes a connected agent reply by the delivered tag ID with older work in another chat', async () => {
  const local = await task(H,CHAT);
  const tag = await queueMessage(db, {kind:'post', roomId:OTHER, authorId:H, text:'@jellybean Please inspect'});
  const commands = await db.query<{id:string;room_id:string}>(
    'SELECT id,room_id FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [tag.id,B]);
  expect(commands.rows).toEqual([{id:expect.any(String),room_id:OTHER}]);
  await expect(report(CHAT,tag.id,'Inspection complete')).rejects.toThrow('Quote a message that woke this turn.');
  expect((await db.query('SELECT room_id FROM messages WHERE author_id=$1', [B])).rows).toEqual([]);
  const app = new RoomsMcpAgentTools(db,daemon);
  await expect(app.call(B,'reply',{commandId:local.id,id:tag.id,text:'Wrong chat'})).rejects.toThrow('Quote a message');
  expect((await db.query('SELECT id FROM messages WHERE author_id=$1', [B])).rows).toEqual([]);
  await app.call(B,'reply',{id:tag.id,text:'Inspection complete'});
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[local.id])).rows).toEqual([{state:'pending'}]);
  expect((await db.query("SELECT room_id,reply_to_message_id,card->'route'->'to' recipient FROM messages WHERE author_id=$1", [B])).rows)
    .toEqual([{room_id:OTHER,reply_to_message_id:tag.id,recipient:{agent:H,place:OTHER}}]);
});

it('interleaves two thread sessions without mixing their output or report recipients', async () => {
  await db.query('UPDATE rooms SET parent_id=$2 WHERE id=$1',[OTHER,CHAT]);
  const first = await task(H,THREAD);
  const second = await task(C,OTHER);
  await output(THREAD,first.id,'12 widgets');
  await output(OTHER,second.id,'3 widgets');
  await expect(report(OTHER,first.id,'Working note')).rejects.toThrow('Quote a message');
  const one = await report(THREAD,first.id,'done: counted twelve');
  const two = await report(OTHER,second.id,'done: counted three');
  expect((await db.query("SELECT room_id,text FROM messages WHERE author_id=$1 AND card IS NULL ORDER BY text",[B])).rows)
    .toEqual([{room_id:THREAD,text:'12 widgets'},{room_id:OTHER,text:'3 widgets'}]);
  expect((await db.query("SELECT room_id,card->'route'->'to' recipient FROM messages WHERE id=$1",[one.id])).rows)
    .toEqual([{room_id:CHAT,recipient:{agent:H,place:CHAT}}]);
  expect((await db.query("SELECT parent_command_id,message->'route' route FROM agent_commands WHERE id=$1",[two.id])).rows)
    .toEqual([{parent_command_id:second.id,route:{from:{agent:B,place:OTHER},to:{agent:C,place:CHAT}}}]);
});

it('binds connected-app writes to the received command when two tasks are pending', async () => {
  await db.query('UPDATE rooms SET parent_id=$2 WHERE id=$1',[OTHER,CHAT]);
  const one=await task(H,THREAD), two=await task(C,OTHER);
  const app=new RoomsMcpAgentTools(db,daemon);
  await expect(app.call(B,'reply',{commandId:two.id,id:one.id,text:'Local note'})).rejects.toThrow('Quote a message');
  await expect(app.call(B,'message',{commandId:two.id,to:{agent:A,place:CHAT},text:'Wrong place'}))
    .rejects.toThrow('thread agent session');
  await expect(app.call(B,'message',{address:OTHER,to:{agent:H,place:THREAD},text:'Wrong recipient'}))
    .rejects.toThrow('thread agent session');
  await app.call(B,'message',{commandId:two.id,to:{agent:A,place:THREAD},text:'Inspect'});
  expect((await db.query('SELECT room_id FROM messages WHERE text=$1',['Local note'])).rows).toEqual([]);
  expect((await db.query("SELECT state FROM agent_commands WHERE id=$1",[one.id])).rows).toEqual([{state:'pending'}]);
  expect((await db.query("SELECT room_id,message->'route'->'from' sender,parent_command_id FROM agent_commands WHERE agent_id=$1",[A])).rows)
    .toEqual([{room_id:THREAD,sender:{agent:B,place:OTHER},parent_command_id:two.id}]);
  expect((await db.query('SELECT room_id,text FROM messages WHERE author_id=$1',[B])).rows)
    .toEqual([{room_id:THREAD,text:'Inspect'}]);
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
  expect((await db.query('SELECT room_id FROM messages WHERE id=$1',[late.id])).rows).toEqual([{room_id:CHAT}]);
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
  await expect(report(CHAT,item!.id,'Observed')).rejects.toThrow('Quote a message');
  expect((await db.query('SELECT id FROM messages WHERE author_id=$1',[B])).rows).toEqual([]);
});

it('refuses unquoted review tool messages even when the commander has a parent Room session', async () => {
  await db.query('UPDATE rooms SET reviewer_agent_id=$1 WHERE id=$2',[C,CHAT]);
  await task(A,THREAD);
  const review=await queueMessage(db,{roomId:THREAD,agentId:C,sourceMessageId:null,reason:'corner_review_dispatch'});
  await daemon.execute('startAgentTurn',{roomId:THREAD,requestId:review!.id,invocationId:'review'},C);
  const input={roomId:THREAD,text:'Review found a blocker.'};
  const refusal='Put review findings in your turn text.';
  await expect(daemon.execute('message',{...input,type:'blocked'},C)).rejects.toThrow(refusal);
  await expect(daemon.execute('message',{...input,type:'normal',address:`${B}@${THREAD}`},C)).rejects.toThrow(refusal);
  await expect(daemon.execute('message',{...input,type:'reply',quoteMsgId:'unrelated'},C)).rejects.toThrow(refusal);
  await expect(new RoomsMcpAgentTools(db,daemon).call(C,'message',{
    commandId:review!.id,to:{agent:B,place:THREAD},text:input.text,
  })).rejects.toThrow(refusal);
  expect((await db.query('SELECT id FROM messages WHERE author_id=$1',[C])).rows).toEqual([]);
  expect((await db.query('SELECT id FROM agent_commands WHERE agent_id=$1',[A])).rows).toEqual([]);
  const verdict=await daemon.execute('postRoomMessage',{...input,requestId:review!.id,harnessEnded:true},C);
  expect((await db.query('SELECT room_id,text FROM messages WHERE id=$1',[verdict.id])).rows)
    .toEqual([{room_id:THREAD,text:input.text}]);
});

it('accepts a reply to a real wake delivered alongside a review and refuses new messages', async () => {
  const request=await sendMessage(db,{route:{from:{agent:A,place:CHAT},to:{agent:C,place:THREAD}},text:'Can you confirm the test ran?'});
  const review=await queueMessage(db,{roomId:THREAD,agentId:C,sourceMessageId:null,reason:'corner_review_dispatch'});
  await daemon.execute('startAgentTurn',{roomId:THREAD,requestId:request.id,invocationId:'batch',batchedCommandIds:[review!.id]},C);
  await expect(daemon.execute('message',{roomId:THREAD,type:'normal',address:`${B}@${THREAD}`,text:'Extra review message'},C))
    .rejects.toThrow('Put review findings in your turn text.');
  const reply=await daemon.execute('message',{roomId:THREAD,type:'reply',quoteMsgId:request.id,text:'The test ran.'},C);
  expect((await db.query('SELECT room_id,reply_to_message_id FROM messages WHERE id=$1',[reply.id])).rows)
    .toEqual([{room_id:CHAT,reply_to_message_id:request.id}]);
});

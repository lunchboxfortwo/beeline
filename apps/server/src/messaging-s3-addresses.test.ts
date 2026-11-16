import { it,expect } from 'vitest';
import { sendMessage,replyToMessage } from './agent-messaging.js';
import { queueMessage,readAgentCommands } from './agent-command.js';
import { RoomsMcpAgentTools } from './rooms-mcp-agent.js';
import { H,A,B,C,CHAT,THREAD,OTHER,db,daemon,queued } from './messaging.test-support.js';

it('S3: thread and chat tuples select exactly the recorded target and place; replies reverse the recorded tuple',async()=>{
  await queueMessage(db,{kind:'post',roomId:THREAD,authorId:H,text:'@sol Please inspect'});
  expect(await queued()).toEqual([[C,THREAD]]);
  await db.query("UPDATE agent_commands SET state='complete' WHERE agent_id=$1",[C]);
  const task=await sendMessage(db,{route:{from:{agent:A,place:CHAT},to:{agent:'implementer',place:THREAD}},text:'Build widget'});
  expect(await queued()).toEqual([[B,THREAD]]);
  const delivered=(await readAgentCommands(db,B)).commands[0]!;
  expect(delivered.from).toEqual({agent:A,place:CHAT});
  expect(delivered.source.body).toBe('Build widget');
  await replyToMessage(db,B,{id:task.id,text:'Done'});
  // Production incident: the legacy report woke Ruby in the thread, despite a Milo return place.
  expect(await queued()).toEqual([[A,CHAT]]);
  await sendMessage(db,{route:{from:{agent:A,place:CHAT},to:{agent:C,place:OTHER}},text:'Conversation'});
  expect(await queued()).toEqual([[A,CHAT],[C,OTHER]]);
});

it('S3: a closed recorded destination ends the turn without rerouting to its parent',async()=>{
  const task=await sendMessage(db,{route:{from:{agent:A,place:THREAD},to:{agent:B,place:CHAT}},text:'Work'});
  await db.query('UPDATE rooms SET archived_at=now() WHERE id=$1',[THREAD]);
  await replyToMessage(db,B,{id:task.id,text:'Done'});
  expect(await queued()).toEqual([]);
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[task.id])).rows[0]).toEqual({state:'cancelled'});
});

it('S3: replying to a recorded sender can return to its private chat without joining the worker there',async()=>{
  await db.query('DELETE FROM memberships WHERE room_id=$1 AND identity_id=$2',[OTHER,B]);
  const sent=await sendMessage(db,{route:{from:{agent:A,place:OTHER},to:{agent:B,place:THREAD}},text:'Build widget'});
  await replyToMessage(db,B,{id:sent.id,text:'Finished'});
  expect(await queued()).toEqual([[A,OTHER]]);
});

it('S3: native message and reply operations deliver the same immutable tuple envelope',async()=>{
  const sent=await daemon.execute('message',{roomId:CHAT,to:{agent:'implementer',place:THREAD},text:'Build widget'},A);
  expect(await queued()).toEqual([[B,THREAD]]);
  await daemon.execute('reply',{id:sent.id,text:'Done'},B);
  expect(await queued()).toEqual([[A,CHAT]]);
});
it('S3: an MCP message keeps its explicit sending place when another place has pending work',async()=>{
  await sendMessage(db,{route:{from:{agent:B,place:THREAD},to:{agent:A,place:CHAT}},text:'A different task'});
  const mcp=new RoomsMcpAgentTools(db,daemon);
  await mcp.call(A,'message',{address:OTHER,to:{agent:'implementer',place:THREAD},text:'Build widget'});
  const received=(await readAgentCommands(db,B)).commands[0]!;
  expect(received.from).toEqual({agent:A,place:OTHER});
  expect(await queued()).toEqual([[A,CHAT],[B,THREAD]]);
});
it('S3: an MCP task tool binds to the received thread message and preserves that call site',async()=>{
  const sent=await sendMessage(db,{route:{from:{agent:B,place:CHAT},to:{agent:A,place:THREAD}},text:'Take over widget'});
  const mcp=new RoomsMcpAgentTools(db,daemon);
  await mcp.call(A,'claim_thread',{address:THREAD,commandId:sent.id});
  expect((await db.query('SELECT implementer_agent_id FROM corner_facts WHERE corner_id=$1',[THREAD])).rows)
    .toEqual([{implementer_agent_id:A}]);
  expect(await queued()).toEqual([[A,THREAD]]);
  await mcp.call(A,'reply',{id:sent.id,text:'Done'});
  expect(await queued()).toEqual([[B,CHAT]]);
});

it('S3: a stopped task cannot issue a new tuple message',async()=>{
  const task=await sendMessage(db,{route:{from:{agent:H,place:CHAT},to:{agent:A,place:CHAT}},text:'Work'});
  await db.query("UPDATE agent_commands SET state='cancelled' WHERE id=$1",[task.id]);
  await expect(daemon.execute('message',{roomId:CHAT,requestId:task.id,to:{agent:B,place:THREAD},text:'Continue'},A)).rejects.toThrow('command turn cancelled');
  expect(await queued()).toEqual([]);
});

it('S3: thread role addresses resolve the recorded role even when a peer has that handle',async()=>{
  await db.query("UPDATE identities SET handle='implementer' WHERE id=$1",[C]);
  try {
    const sent=await sendMessage(db,{route:{from:{agent:A,place:CHAT},to:{agent:'implementer',place:THREAD}},text:'For the recorded worker'});
    expect((await db.query('SELECT agent_id,room_id FROM agent_commands WHERE id=$1',[sent.id])).rows)
      .toEqual([{agent_id:B,room_id:THREAD}]);
  } finally {await db.query("UPDATE identities SET handle='sol' WHERE id=$1",[C]);}
});

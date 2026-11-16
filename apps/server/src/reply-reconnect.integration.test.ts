import { expect, it, A, H, R, claim, commands, send, result, disconnectHelper, helperOwner, rootFixture } from './test-support-agent-command.integration.test-support.js';

it.each(['reconnect','stale-server','closed-connection'])('a queued answer survives %s and duplicate posts return its receipt',async path=>{
  await send('@hoots answer this');const [command]=await commands();await claim(command!);
  if(path!=='stale-server')await disconnectHelper();
  if(path==='reconnect')await helperOwner(A);
  if(path==='stale-server')await rootFixture.db.query("UPDATE live_server_instances SET renewed_at=now()-interval '2 minutes'");
  const text=`Answer after ${path}`,posted=await result(command!,text);
  expect((await result(command!,'A duplicate answer')).id).toBe(posted.id);
  expect((await rootFixture.phone.readRoom(R,H))!.messages.filter(message=>message.text===text)).toHaveLength(1);
  expect(await commands()).toEqual([]);
});

it('two connections acknowledge the same committed answer',async()=>{
  await send('@hoots answer once');const [command]=await commands();await claim(command!);
  await disconnectHelper();await helperOwner(A);await claim(command!);
  const posted=await Promise.all([result(command!,'Answer A'),result(command!,'Answer B')]);
  expect(posted[0]!.id).toBe(posted[1]!.id);
  expect((await rootFixture.phone.readRoom(R,H))!.messages.filter(message=>/^Answer [AB]$/.test(message.text))).toHaveLength(1);
});

it('a final reply ignores an invalid optional link and keeps its recorded source message',async()=>{
  await send('@hoots answer');const [command]=await commands();await claim(command!);
  await result(command!,'Reply without the missing link','unused',{replyToMessageId:'f'.repeat(64)});
  expect((await rootFixture.db.query('SELECT text,reply_to_message_id FROM messages WHERE request_id=$1',[command!.turnRequestId])).rows)
    .toEqual([{text:'Reply without the missing link',reply_to_message_id:command!.sourceMessageId}]);
  expect(await commands()).toEqual([]);
});

it('membership removal keeps the answer owed and restoring access permits the stored reply',async()=>{
  await send('@hoots answer');const [command]=await commands();await claim(command!);
  await rootFixture.db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2',[R,A]);
  await expect(result(command!,'Stored answer')).rejects.toThrow();
  expect((await rootFixture.db.query('SELECT state FROM agent_commands WHERE id=$1',[command!.id])).rows).toEqual([{state:'pending'}]);
  await rootFixture.db.query('UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2',[R,A]);
  await result(command!,'Stored answer');
  expect(await commands()).toEqual([]);
});

it('Stop refuses a late answer without rerouting it',async()=>{
  await send('@hoots answer');const [command]=await commands();await claim(command!);
  await rootFixture.phone.cancelAgentTurn({roomId:R,agentId:A,requestId:command!.turnRequestId},H);
  await expect(result(command!,'Must never arrive')).rejects.toThrow('command turn cancelled');
  expect((await rootFixture.db.query("SELECT 1 FROM messages WHERE text='Must never arrive'")).rowCount).toBe(0);
});

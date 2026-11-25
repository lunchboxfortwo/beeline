import { randomUUID } from 'node:crypto';
import { afterEach,expect,it,vi } from 'vitest';
import { queueMessage } from './agent-command.js';
import { callAgentTool } from '../../body/src/read-only-mcp-open-poll.js';
import { sendMessage } from './agent-messaging.js';
import { H,B,CHAT,OTHER,db,daemon } from './messaging.test-support.js';

afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
it.each(['native','HTTP'] as const)('%s reply uses the human tag that woke the current turn',async transport=>{
 const old=await queueMessage(db,{roomId:CHAT,agentId:B,sourceMessageId:null,reason:'system'});
 const stale={id:randomUUID(),requestId:old!.id};
 await daemon.execute('startAgentTurn',{roomId:CHAT,requestId:old!.id,invocationId:stale.id},B);
 await daemon.execute('postRoomMessage',{roomId:CHAT,requestId:old!.id,text:'',harnessEnded:true,invocation:stale},B);
 const wake=await queueMessage(db,{kind:'post',roomId:CHAT,authorId:H,text:'@jellybean Please inspect'});
 const current=(await db.query<{id:string}>('SELECT id FROM agent_commands WHERE agent_id=$1 AND source_message_id=$2',[B,wake.id])).rows[0]!;
 const unrelated=await queueMessage(db,{kind:'post',roomId:CHAT,authorId:H,text:'@jellybean Another pending request'});
 const invocation={id:randomUUID(),requestId:current.id};
 await daemon.execute('startAgentTurn',{roomId:CHAT,requestId:current.id,invocationId:invocation.id},B);
 for(const [key,value] of Object.entries({BEELINE_DAEMON_ROOM_ID:CHAT,BEELINE_DAEMON_BASE_URL:'http://adapter.test',BEELINE_DAEMON_TOKEN:'fixture',
  BEELINE_DAEMON_CORNER_ID:'',BEELINE_GRANT_RUNNER_FILE:'',BEELINE_GRANT_RUNNER_URL:transport==='native'?'http://native.test':'',BEELINE_GRANT_RUNNER_TOKEN:'fixture'}))vi.stubEnv(key,value);
 const requests:Record<string,unknown>[]=[];
 vi.stubGlobal('fetch',async(url:URL,init:RequestInit)=>{
   const body=JSON.parse(String(init.body));const native=new URL(url).hostname==='native.test';
   const operation=native?body.operation:new URL(url).pathname.split('/').at(-1);
   const input=native?body.input:body;requests.push(input);
   return Response.json(await daemon.execute(operation,input,B));
 });
 await expect(callAgentTool('message',{type:'reply',quoteMsgId:unrelated.id,text:'Unrelated answer'},'unrelated')).rejects.toThrow('woke this turn');
 await callAgentTool('message',{type:'reply',quoteMsgId:wake.id,text:'Explicit answer'},'current');
 expect(requests.at(-1)).toEqual({roomId:CHAT,type:'reply',quoteMsgId:wake.id,text:'Explicit answer'});
 expect((await db.query("SELECT room_id,reply_to_message_id,card->'route'->'to' recipient FROM messages WHERE author_id=$1",[B])).rows)
   .toEqual([{room_id:CHAT,reply_to_message_id:wake.id,recipient:{agent:H,place:CHAT}}]);
 // An installed helper may still send its previous turn's IDs. A matching quote wins.
 await expect(daemon.execute('message',{roomId:CHAT,type:'reply',quoteMsgId:wake.id,text:'Legacy answer',
   requestId:stale.requestId,taskId:old!.id,invocation:stale} as Parameters<typeof daemon.execute<'message'>>[1],B)).resolves.toHaveProperty('id');

});

it('limits reply authority to the registered delivery, including batched messages',async()=>{
  const task = () => sendMessage(db,{route:{from:{agent:H,place:OTHER},to:{agent:B,place:CHAT}},text:'Task'});
  const first = await task(), second = await task();
  const start = async (batchedCommandIds:string[]) => {
    const invocation = {id:randomUUID(),requestId:first.id};
    await daemon.execute('startAgentTurn',{roomId:CHAT,requestId:first.id,invocationId:invocation.id,batchedCommandIds},B);
    return invocation;
  };
  const current = await start([]);
  const reply = (id:string,invocation:typeof current) => daemon.execute('message',{
    roomId:CHAT, requestId:id, type:'reply', quoteMsgId:id, text:'Answer', invocation,
  },B);
  await expect(reply(second.id,current)).rejects.toThrow('woke this turn');
  await expect(reply(first.id,current)).resolves.toHaveProperty('id');
  const replacement={id:randomUUID(),requestId:second.id};
  await daemon.execute('startAgentTurn',{roomId:CHAT,requestId:second.id,invocationId:replacement.id,batchedCommandIds:[first.id]},B);
  await expect(reply(first.id,current)).resolves.toHaveProperty('id');
  await expect(reply(second.id,replacement)).resolves.toHaveProperty('id');
  await daemon.execute('postRoomMessage',{roomId:CHAT,requestId:second.id,text:'',harnessEnded:true,invocation:replacement},B);
  await expect(reply(first.id,current)).rejects.toThrow('woke this turn');
});

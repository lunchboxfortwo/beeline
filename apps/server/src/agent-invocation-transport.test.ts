import { randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,expect,it,vi } from 'vitest';
import { writeTurnContext } from '../../body/src/place-session.js';
import { executeConversationOperation } from '../../body/src/read-only-mcp-execute-agent-operation.js';
import { sendMessage } from './agent-messaging.js';
import { H,B,CHAT,OTHER,db,daemon } from './messaging.test-support.js';

const roots:string[]=[];
afterEach(async()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it.each(['native','HTTP'] as const)('%s tool delivery binds an old-target reply to the executing invocation, not the target',async transport=>{
 const task=()=>sendMessage(db,{route:{from:{agent:H,place:CHAT},to:{agent:B,place:CHAT}},text:'Task'});
 const current=await task(),old=await sendMessage(db,{route:{from:{agent:H,place:OTHER},to:{agent:B,place:CHAT}},text:'Old task'});
 const invocation={id:randomUUID(),requestId:current.id};
 await daemon.execute('startAgentTurn',{roomId:CHAT,requestId:current.id,invocationId:invocation.id},B);
 const root=await mkdtemp(join(tmpdir(),'invocation-wire-'));roots.push(root);const context=join(root,'turn.json');
 await writeTurnContext(context,{id:current.id,roomId:CHAT,turnRequestId:current.id,rootCommandId:current.id,reason:'human_tag'},[],undefined,invocation);
 for(const [key,value] of Object.entries({BEELINE_TURN_CONTEXT_FILE:context,BEELINE_DAEMON_BASE_URL:'http://adapter.test',BEELINE_DAEMON_TOKEN:'fixture',
  BEELINE_GRANT_RUNNER_FILE:'',BEELINE_GRANT_RUNNER_URL:transport==='native'?'http://native.test':'',BEELINE_GRANT_RUNNER_TOKEN:'fixture'}))vi.stubEnv(key,value);
 const requests:Record<string,unknown>[]=[];
 vi.stubGlobal('fetch',async(url:URL,init:RequestInit)=>{
   const body=JSON.parse(String(init.body));const native=new URL(url).hostname==='native.test';
   const operation=native?body.operation:new URL(url).pathname.split('/').at(-1);
   const input=native?body.input:body;requests.push(input);
   return Response.json(await daemon.execute(operation,input,B));
 });
 // Caller-supplied metadata cannot replace the private execution context.
 await executeConversationOperation('reply',{id:old.id,text:'Explicit old answer',invocation:{id:'forged',requestId:old.id}});
 expect(requests[0]).toMatchObject({roomId:CHAT,requestId:current.id,invocation});
 const final=await daemon.execute('postRoomMessage',{roomId:CHAT,requestId:current.id,text:'Replied to the old request',harnessEnded:true,invocation},B);
 expect(final).toMatchObject({suppressed:true,answered:false});
 expect((await db.query("SELECT text FROM messages WHERE author_id=$1 AND presentation='message'",[B])).rows).toEqual([{text:'Explicit old answer'}]);
 expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[current.id])).rows).toEqual([{state:'pending'}]);
});

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mock} from 'node:test';
import {PgliteDatabase} from '../apps/server/src/test-support.ts';
import {migrate} from '../apps/server/dist/database.js';
import {DaemonService} from '../apps/server/dist/daemon-service.js';
import {PhoneService} from '../apps/server/dist/phone-service.js';
import {LiveHub} from '../apps/server/dist/live.js';
import {claimAgentConnection,releaseAgentConnection} from '../apps/server/dist/connection-presence.js';
import {CommandExecutionContext,runServerCommandIntake} from '../apps/body/dist/server-command-intake.js';
import {AgentTurnStream} from '../apps/body/dist/turn-stream.js';
import {DaemonApiError} from '../apps/body/dist/daemon-api-client.js';
import {requestErrorStatus} from '../apps/server/dist/server-request-error-status.js';
import {AGENT_TURN_DEADLINE_MS} from '../apps/body/dist/agent-turn-deadline.js';

// Isolated stand-in: dropping a real user's connection mid-job on demand
// would disrupt their work. All operations below use built service entrypoints.
const db=new PgliteDatabase(), scratch=await mkdtemp(join(tmpdir(),'beeline-reply-proof-'));
const human='a'.repeat(64),agent='b'.repeat(64),workspace=randomUUID(),room=randomUUID();
try {
  await migrate(db);
  const live=new LiveHub(),daemon=new DaemonService(db,live),phone=new PhoneService(db,live);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Worker','worker')`,[human,agent]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[agent,human]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Reply proof')",[workspace]);
  await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Reply Room')",[room,workspace]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,[workspace,human,agent,room]);
  await db.query("INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('proof',clock_timestamp())");
  const register=async connectionId=>({connectionId,epoch:await claimAgentConnection(db,live,agent,{}, {connectionId,instanceId:'proof'})});
  let owner=await register('connection-a');
  const source=await phone.execute('sendRoomMessage',{roomId:room,text:'@worker answer after reconnect'},human);
  const command=(await daemon.execute('getAgentCommands',{roomId:room},agent)).commands.find(c=>c.sourceMessageId===source.messageId);
  assert(command);
  await daemon.execute('claimAgentCommand',{roomId:room,commandId:command.id,generationId:'generation-a'},agent,owner);
  await releaseAgentConnection(db,live,agent,owner.connectionId);
  owner=await register('connection-b');
  await daemon.execute('claimAgentCommand',{roomId:room,commandId:command.id,generationId:'generation-b'},agent,owner);
  const replies=await Promise.allSettled(['a','b'].map(generation=>daemon.execute('postRoomMessage',{
    roomId:room,requestId:command.turnRequestId,generationId:'generation-'+generation,text:'Answer '+generation},agent)));
  assert.equal(replies.filter(result=>result.status==='fulfilled').length,1);
  const view=await phone.readRoom(room,human);
  assert.equal(view.messages.filter(message=>/^Answer [ab]$/.test(message.text)).length,1);
  console.log('Reproduction reply-reconnect PASS: claim A → disconnect → reconnect B → two executions answer → phone reads exactly one reply.');

  const queued=await phone.execute('sendRoomMessage',{roomId:room,text:'@worker model deadline proof'},human);
  const abort=new AbortController(),context=new CommandExecutionContext(scratch);
  let entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const api={turnOwnershipScope:()=>owner,execute:async(name,input)=>{
    const value=await daemon.execute(name,input,agent,['claimAgentTurn','releaseAgentTurn','postAgentTurnReceipt'].includes(name)?owner:undefined);
    if(name==='releaseAgentTurn')abort.abort();
    return value;
  }};
  mock.timers.enable({apis:['setTimeout']});
  const intake=runServerCommandIntake({api,roomId:room,agentId:agent,context,signal:abort.signal,stop:()=>{},onError:()=>{},run:async()=>{
    entered();return new Promise(()=>{});
  }});
  await started;
  mock.timers.tick(AGENT_TURN_DEADLINE_MS);
  await intake;
  mock.timers.reset();
  const failed=await phone.readRoom(room,human);
  assert.equal(failed.latestAgentTurns.find(turn=>turn.requestId===queued.messageId)?.status,'failed');
  assert(failed.messages.some(message=>message.text.includes('timed out')));
  assert.equal((await db.query('SELECT state FROM agent_commands WHERE source_message_id=$1',[queued.messageId])).rows[0].state,'complete');
  console.log('Model deadline PASS: non-returning model → six-hour deadline → phone reads failure reason → command no longer blocks intake.');
  const workflowSource=await phone.execute('sendRoomMessage',{roomId:room,text:'@worker reclaimed workflow proof'},human);
  const workflow=(await daemon.execute('getAgentCommands',{roomId:room},agent)).commands.find(c=>c.sourceMessageId===workflowSource.messageId);
  assert(workflow);
  await daemon.execute('claimAgentCommand',{roomId:room,commandId:workflow.id,generationId:'workflow-old'},agent,owner);
  await releaseAgentConnection(db,live,agent,owner.connectionId);
  owner=await register('connection-c');
  await daemon.execute('claimAgentCommand',{roomId:room,commandId:workflow.id,generationId:'workflow-new'},agent,owner);
  await db.query(`UPDATE messages SET card='{"runId":"reclaimed-workflow"}' WHERE id=$1`,[workflowSource.messageId]);
  const statuses=[];
  const stream=new AgentTurnStream({agentId:agent,roomId:room,requestId:workflow.turnRequestId,label:'workflow proof',api:{execute:async(name,input)=>{
    try{return await daemon.execute(name,{...input,generationId:'workflow-old'},agent);}
    catch(error){const status=requestErrorStatus(error);statuses.push(status);throw new DaemonApiError(error.message,status,false);}
  }}});
  await assert.rejects(stream.settle('Stale workflow answer'),/workflow generation ended/);
  assert.deepEqual(statuses,[409,409]);
  assert.equal((await phone.readRoom(room,human)).messages.some(m=>m.text==='Stale workflow answer'),false);
  assert.equal((await db.query('SELECT generation_id FROM agent_commands WHERE id=$1',[workflow.id])).rows[0].generation_id,'workflow-new');
  console.log('Reproduction reclaimed-reply PASS: actual service refusal → visible failure → one retry → workflow fence and successor preserved.');
} finally {mock.timers.reset();await db.close();await rm(scratch,{recursive:true,force:true});}

import { startQueuedTurn } from './test-fixtures/queued-turn.test-support.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
import { createAgentCommand, readAgentCommands } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { cancelCornerAgentCommands } from './corner-close.js';
import { claimAgentConnection, releaseAgentConnection } from './connection-presence.js';
import type { HelperTurnOwnershipSource } from '@beeline/api-contract/helper-turn-ownership';

const W='11111111-1111-4111-8111-111111111111',R='22222222-2222-4222-8222-222222222222';
const H='a'.repeat(64),A='b'.repeat(64);
let db:PgliteDatabase,daemon:DaemonService,phone:PhoneService,live:LiveHub,owner:HelperTurnOwnershipSource;
beforeEach(async()=>{
  db=await migratedDatabase();live=new LiveHub();daemon=new DaemonService(db,live);phone=new PhoneService(db,live);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Candy','candy')`,[H,A]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[A,H]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Workspace')",[W]);
  await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')",[R,W]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,[W,H,A,R]);
  await db.query("INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('test-server',clock_timestamp())");
  owner={connectionId:'first-connection',epoch:await claimAgentConnection(db,live,A,{lifecycleId:'first-boot'}, {connectionId:'first-connection',instanceId:'test-server'})};
});
afterEach(()=>db.close());
async function ask(){
  const sent=await phone.execute('sendRoomMessage',{roomId:R,text:'@candy Please answer'},H);
  const command=(await readAgentCommands(db, A, R)).commands.find(c=>c.sourceMessageId===sent.messageId)!;
  await startQueuedTurn(db, R, A, command.id);return command;
}
const receipt=(requestId:string,status:'complete'|'failed')=>daemon.execute('postAgentTurnReceipt',
  { roomId:R, requestId, status, ...(status==='failed'?{reason:'provider unavailable',reasonKind:'hiccup'}:{}) },A,owner);
const notices=()=>db.query("SELECT id FROM messages WHERE room_id=$1 AND card_type='turn-failed'",[R]);
it('projects a working turn at claim before any agent activity or model output exists',async()=>{
  const command=await ask();
  const room=await phone.readRoom(R,H);
  expect(room?.latestAgentTurns).toEqual([expect.objectContaining({ agentPubkey:A, requestId:command.turnRequestId, status:'working', startedAt:expect.any(Number) })]);
  expect((await db.query('SELECT id FROM messages WHERE room_id=$1 AND author_id=$2',[R,A])).rows).toEqual([]);
});
it('an answered tag stays complete through elapsed time, duplicate receipts and queue reads',async()=>{
  const c=await ask();
  await daemon.execute('postRoomMessage',{ roomId:R, requestId:c.turnRequestId, text:'Here is the answer.' },A);
  await receipt(c.turnRequestId,'complete');await receipt(c.turnRequestId,'complete');
  await db.query("UPDATE agent_turns SET created_at=now()-interval '8 hours' WHERE request_id=$1",[c.turnRequestId]);
  expect((await readAgentCommands(db, A, R)).commands).toEqual([]);
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[c.id])).rows).toEqual([{state:'complete'}]);
  expect((await notices()).rowCount).toBe(0);
});
it('a connected claimed turn never becomes reclaimable merely because time passes',async()=>{
  const c=await ask();
  await db.query("UPDATE agent_commands SET created_at=now()-interval '8 hours' WHERE id=$1",[c.id]);
  // Listed only for its own helper to resume in the same generation.
  expect((await readAgentCommands(db, A, R)).commands.map(item=>item.id)).toEqual([c.id]);
  await startQueuedTurn(db,R,A,c.id);
  expect((await notices()).rowCount).toBe(0);
});
it('a failed diagnostic keeps the item pending until its answer is posted',async()=>{
  const c=await ask();await receipt(c.turnRequestId,'failed');
  await receipt(c.turnRequestId,'failed');
  expect((await notices()).rowCount).toBe(0);
  expect((await readAgentCommands(db,A,R)).commands.map(item=>item.id)).toEqual([c.id]);
  await daemon.execute('postRoomMessage',{roomId:R,requestId:c.turnRequestId,text:'The provider is unavailable.'},A);
  expect((await readAgentCommands(db,A,R)).commands).toEqual([]);
});
it('stores and delivers a complete child-process failure beyond the manual report limit, including stderr',async()=>{
  const commander='c'.repeat(64);
  await db.query("INSERT INTO identities(id,kind,name) VALUES($1,'agent','Commander')",[commander]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[commander,H]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`,[W,R,commander]);
  const c=(await createAgentCommand(db,{roomId:R,agentId:A,sourceMessageId:null,reason:'order',
    privatePayload:{kind:'order',text:'Do this task',authorId:commander,fromRoomId:R}}))!;
  await startQueuedTurn(db, R, A, c.id);
  const reason='Command failed: /usr/bin/bwrap '+ '--bind /long/corner/path /long/corner/path '.repeat(500)+
    "\nbwrap: Can't find source path /deleted/.corner-artifacts/threads-refresh: No such file or directory";
  await daemon.execute('postAgentTurnReceipt',{ roomId:R, requestId:c.turn_request_id, status:'failed', reason },A,owner);
  expect((await db.query('SELECT failure_reason FROM agent_turns WHERE request_id=$1',[c.turn_request_id])).rows)
    .toEqual([{failure_reason:null}]);
  await daemon.execute('postRoomMessage',{roomId:R,requestId:c.turn_request_id,text:'Candy stopped while answering this: '+reason},A);
  const reports=(await db.query<{text:string}>(`SELECT private_payload->>'text' text FROM agent_commands
    WHERE agent_id=$1 AND reason='report'`,[commander])).rows;
  expect(reports).toHaveLength(1);
  expect(reports[0]!.text).toContain(reason);
});
it('a failed diagnostic and revoked return membership leave the answer owed',async()=>{
  const commander='c'.repeat(64);
  await db.query("INSERT INTO identities(id,kind,name) VALUES($1,'agent','Commander')",[commander]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[commander,H]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`,[W,R,commander]);
  const c=(await createAgentCommand(db,{roomId:R,agentId:A,sourceMessageId:null,reason:'order',
    privatePayload:{kind:'order',text:'Do this task',authorId:commander,fromRoomId:R}}))!;
  await startQueuedTurn(db, R, A, c.id);
  await db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2',[R,commander]);
  await receipt(c.turn_request_id,'failed');
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[c.id])).rows).toEqual([{state:'pending'}]);
  expect((await notices()).rowCount).toBe(0);
  expect((await readAgentCommands(db,A,R)).commands.map(item=>item.id)).toContain(c.id);
});
it('Stop wins over a late result and uses the same terminal owner',async()=>{
  const c=await ask();
  await phone.execute('cancelAgentTurn',{roomId:R,agentId:A,requestId:c.turnRequestId},H);
  await receipt(c.turnRequestId,'complete');
  expect((await db.query('SELECT status FROM agent_turns WHERE request_id=$1',[c.turnRequestId])).rows).toEqual([{status:'cancelled'}]);
});
it('corner cancellation ends queued and claimed work without a silence notice',async()=>{
  const c=await ask();await createAgentCommand(db,{roomId:R,agentId:A,sourceMessageId:null,reason:'system'});
  await db.transaction(tx=>cancelCornerAgentCommands(tx,R));
  expect((await db.query("SELECT id FROM agent_commands WHERE room_id=$1 AND action IN ('input','resume') AND state IN ('pending','claimed')",[R])).rows).toEqual([]);
  expect((await notices()).rowCount).toBe(0);
  expect((await db.query('SELECT status FROM agent_turns WHERE request_id=$1',[c.turnRequestId])).rows).toEqual([{status:'cancelled'}]);
});
it('a long claimed invocation ends on its actual answer through the terminal owner',async()=>{
  const c=await ask();
  await db.query("UPDATE agent_turns SET started_at=now()-interval '20 minutes' WHERE request_id=$1",[c.turnRequestId]);
  await daemon.execute('postRoomMessage',{ roomId:R, requestId:c.turnRequestId, text:'The long work finished.' },A);
  await receipt(c.turnRequestId,'complete');
  expect((await notices()).rowCount).toBe(0);
  expect((await readAgentCommands(db, A, R)).commands).toEqual([]);
});

it('disconnect keeps the running turn; the same helper continues it, and a new helper process resumes it in its generation',async()=>{
  const c=await ask();
  await releaseAgentConnection(db,live,A,owner.connectionId);
  expect((await readAgentCommands(db, A, R)).commands.map(item=>item.id)).toEqual([c.id]);
  expect((await phone.readRoom(R,H))?.latestAgentTurns?.some(turn=>turn.status==='working')).toBe(true);
  await claimAgentConnection(db,live,A,{lifecycleId:'first-boot'},{connectionId:'second-connection',instanceId:'test-server'});
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[c.id])).rows)
    .toEqual([{state:'pending'}]);
  const next={connectionId:'third-connection',epoch:await claimAgentConnection(db,live,A,{lifecycleId:'second-boot'},
    {connectionId:'third-connection',instanceId:'test-server'})};
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[c.id])).rows)
    .toEqual([{state:'pending'}]);
  expect((await readAgentCommands(db, A, R)).commands.map(item=>item.id)).toEqual([c.id]);
  await startQueuedTurn(db, R, A, c.id);
  await daemon.execute('postRoomMessage',{ roomId:R, requestId:c.turnRequestId, text:'Recovered answer.' },A);
  expect((await readAgentCommands(db, A, R)).commands).toEqual([]);
  expect((await notices()).rowCount).toBe(0);
});

it('an initially offline mention waits for connection with only its offline notice',async()=>{
  await releaseAgentConnection(db,live,A,owner.connectionId);
  const sent=await phone.execute('sendRoomMessage',{roomId:R,text:'@candy A request while offline'},H);
  const queued=(await readAgentCommands(db, A, R)).commands.find(c=>c.sourceMessageId===sent.messageId)!;
  expect(queued).toBeDefined();
  expect((await db.query("SELECT text FROM messages WHERE room_id=$1 AND presentation='system'",[R])).rows).toEqual([{text:'@candy is offline · connect again'}]);
  const next={connectionId:'returning',epoch:await claimAgentConnection(db,live,A,{},
    {connectionId:'returning',instanceId:'test-server'})};
  await startQueuedTurn(db, R, A, queued.id);
  await daemon.execute('postRoomMessage',{ roomId:R, requestId:queued.turnRequestId, text:'I can answer now.' },A);
  expect((await notices()).rowCount).toBe(0);
});

it('a claimed restart kept across close completes on its new lifecycle instead of restarting again',async()=>{
  await phone.execute('sendRoomMessage',{roomId:R,text:'@candy restart'},H);
  const restart=(await readAgentCommands(db, A, R)).commands.find(c=>c.action==='restart')!;
  await startQueuedTurn(db, R, A, restart.id);
  await releaseAgentConnection(db,live,A,owner.connectionId);
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[restart.id])).rows).toEqual([{state:'pending'}]);
  await claimAgentConnection(db,live,A,{lifecycleId:'second-boot'},
    {connectionId:'after-restart',instanceId:'test-server'});
  await daemon.execute('markAgentTurnSilent',{roomId:R,requestId:restart.turnRequestId},A);
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[restart.id])).rows).toEqual([{state:'complete'}]);
  expect((await readAgentCommands(db, A, R)).commands).toEqual([]);
  expect((await notices()).rowCount).toBe(0);
});

it('a delivered terminal report keeps its order resumable in the same generation until the turn ends',async()=>{
  const command=(await createAgentCommand(db,{roomId:R,agentId:A,sourceMessageId:null,reason:'order',
    privatePayload:{kind:'order',authorId:H,fromRoomId:R,text:'Finish this assignment'}}))!;
  await startQueuedTurn(db, R, A, command.id);
  await daemon.execute('report',{ roomId:R, requestId:command.turn_request_id, status:'done', text:'The assignment is finished.' },A);
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[command.id])).rows).toEqual([{state:'complete'}]);
  await releaseAgentConnection(db,live,A,owner.connectionId);
  expect((await readAgentCommands(db, A, R)).commands).toEqual([]);
  expect((await notices()).rowCount).toBe(0);
});

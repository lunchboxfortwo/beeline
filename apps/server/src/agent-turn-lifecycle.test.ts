import { startQueuedTurn } from './test-fixtures/queued-turn.test-support.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
import { createAgentCommand, readAgentCommands } from './agent-command.js';
import { DaemonService } from './daemon-service.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { cancelCornerAgentCommands } from './corner-close.js';
import { claimAgentConnection, releaseAgentConnection } from './connection-presence.js';
import { stoppedAnsweredCommandIds } from './agent-turn-end.js';
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
it('does not let tool activity authorize no_reply_needed for an unanswered human request',async()=>{
  const c=await ask();
  await daemon.execute('postAgentActivity',{roomId:R,requestId:c.turnRequestId,activity:[{kind:'tool',title:'curl',status:'exit 7',operation:'execute'}]},A);
  expect(await daemon.execute('markAgentTurnSilent',{roomId:R,requestId:c.turnRequestId},A)).toMatchObject({answered:false});
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[c.id])).rows).toEqual([{state:'pending'}]);
  expect((await db.query('SELECT status FROM agent_turns WHERE request_id=$1',[c.turnRequestId])).rows).toEqual([{status:'working'}]);
});

it.each(['human_tag','schedule'])('quietly ends an unanswered %s harness execution, including replays',async reason=>{
  const c=await ask();
  await db.query('UPDATE agent_commands SET reason=$2 WHERE id=$1',[c.id,reason]);
  const closing={roomId:R,requestId:c.turnRequestId,text:'',harnessEnded:true};
  await daemon.execute('postRoomMessage',closing,A);
  await daemon.execute('postRoomMessage',closing,A);
  expect((await db.query("SELECT id FROM messages WHERE room_id=$1 AND presentation='system' AND text LIKE '%failed%'",[R])).rows).toEqual([]);
  expect((await readAgentCommands(db,A,R)).commands.map(item=>item.id)).toEqual([c.id]);
  expect((await phone.readRoom(R,H))?.latestAgentTurns?.some(turn=>turn.status==='working')).toBe(false);
  if (reason === 'schedule') {
    expect(await daemon.execute('markAgentTurnSilent',{roomId:R,requestId:c.turnRequestId},A)).toMatchObject({answered:true});
    expect((await readAgentCommands(db,A,R)).commands).toEqual([]);
    expect((await db.query('SELECT id FROM messages WHERE room_id=$1 AND author_id<>$2',[R,H])).rows).toEqual([]);
  }
});

it('quietly acknowledges background no_reply_needed without inventing a reply',async()=>{
  const c=await ask();
  await db.query("UPDATE agent_commands SET reason='schedule' WHERE id=$1",[c.id]);
  expect(await daemon.execute('markAgentTurnSilent',{roomId:R,requestId:c.turnRequestId},A)).toMatchObject({answered:true});
  expect((await db.query('SELECT report_outcome,result_message_id FROM agent_commands WHERE id=$1',[c.id])).rows)
    .toEqual([{report_outcome:'complete',result_message_id:null}]);
  expect((await db.query('SELECT id FROM messages WHERE room_id=$1 AND author_id<>$2',[R,H])).rows).toEqual([]);
});

it('keeps empty batch requests owed until the schedule is explicitly acknowledged',async()=>{
  const first=await ask(),second=await ask();
  await db.query("UPDATE agent_commands SET reason='schedule' WHERE id=$1",[first.id]);
  await daemon.execute('postRoomMessage',{roomId:R,requestId:first.id,queuedRequestIds:[second.id],text:'',harnessEnded:true},A);
  expect((await readAgentCommands(db,A,R)).commands.map(item=>item.id)).toEqual([first.id,second.id]);
  expect(await daemon.execute('markAgentTurnSilent',{roomId:R,requestId:first.id},A)).toMatchObject({answered:true});
  expect((await readAgentCommands(db,A,R)).commands.map(item=>item.id)).toEqual([second.id]);
  expect((await db.query('SELECT id FROM messages WHERE room_id=$1 AND author_id<>$2',[R,H])).rows).toEqual([]);
});

it('settles only the schedule after a successful empty scheduled batch', async () => {
  const schedule = await ask(), human = await ask();
  await db.query("UPDATE agent_commands SET reason='schedule' WHERE id=$1", [schedule.id]);
  const invocation = { id: 'scheduled-batch', requestId: schedule.turnRequestId };
  await daemon.execute('startAgentTurn', { roomId: R, requestId: invocation.requestId, invocationId: invocation.id,
    batchedCommandIds: [human.id] }, A);
  await daemon.execute('postRoomMessage', { roomId: R, requestId: schedule.id, invocation, text: '',
    harnessEnded: true, silentCompletion: true, queuedRequestIds: [human.id] }, A);
  expect((await readAgentCommands(db, A, R)).commands.map(item => item.id)).toEqual([human.id]);
  expect((await db.query('SELECT id FROM messages WHERE room_id=$1 AND author_id<>$2', [R, H])).rows).toEqual([]);
});

it('projects a working turn at claim before any agent activity or model output exists',async()=>{
  const command=await ask();
  const room=await phone.readRoom(R,H);
  expect(room?.latestAgentTurns).toEqual([expect.objectContaining({ agentPubkey:A, requestId:command.turnRequestId, status:'working', startedAt:expect.any(Number) })]);
  expect((await db.query('SELECT id FROM messages WHERE room_id=$1 AND author_id=$2',[R,A])).rows).toEqual([]);
});
it('orders an interrupted and restarted execution of an unanswered item by committed revision',async()=>{
  const command=await ask();
  const read=async()=> (await phone.readRoom(R,H))!.latestAgentTurns[0]!;
  const working=await read();
  expect(working.version).toBeGreaterThan(0);
  await daemon.execute('postRoomMessage',{roomId:R,requestId:command.turnRequestId,text:'',harnessEnded:true},A);
  const ended=await read();
  expect(ended.status).toBe('cancelled');
  expect(ended.version).toBeGreaterThan(working.version!);
  await daemon.execute('startAgentTurn',{roomId:R,requestId:command.turnRequestId},A,undefined,owner);
  const resumed=await read();
  expect(resumed.status).toBe('working');
  expect(resumed.requestId).toBe(ended.requestId);
  expect(resumed.version).toBeGreaterThan(ended.version!);
  const liveTurn=(await phone.readLiveDeltas(R,[H],{type:'turn',agentId:A,requestId:command.turnRequestId})).get(H);
  expect(liveTurn).toMatchObject({type:'turn-delta',turn:{version:resumed.version,status:'working'}});
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
it('a recorded empty harness exit ends execution while preserving the unanswered human request',async()=>{
  const c=await ask();
  await daemon.execute('postRoomMessage',{roomId:R,requestId:c.turnRequestId,text:'',harnessEnded:true},A);
  expect((await db.query('SELECT status,ended_at FROM agent_turns WHERE request_id=$1',[c.turnRequestId])).rows)
    .toEqual([{status:'cancelled',ended_at:expect.any(Date)}]);
  expect((await readAgentCommands(db,A,R)).commands.map(item=>item.id)).toContain(c.id);
  expect((await phone.readRoom(R,H))?.latestAgentTurns?.some(turn=>turn.status==='working')).toBe(false);
  expect((await notices()).rowCount).toBe(0);
  expect((await db.query("SELECT id FROM messages WHERE room_id=$1 AND presentation='system' AND text LIKE '%failed%'",[R])).rows).toEqual([]);
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
  const reports=(await db.query<{text:string}>(`SELECT text FROM messages WHERE author_id=$1 AND room_id=$2 AND request_id=$3`,[A,R,c.turn_request_id])).rows;
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
  await daemon.execute('startAgentTurn',{roomId:R,requestId:c.turnRequestId},A,undefined,owner);
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

it('replacement closes the phone running indicator and redelivers the unanswered item',async()=>{
  const c=await ask();
  await releaseAgentConnection(db,live,A,owner.connectionId);
  expect((await readAgentCommands(db, A, R)).commands.map(item=>item.id)).toEqual([c.id]);
  expect((await phone.readRoom(R,H))?.latestAgentTurns?.some(turn=>turn.status==='working')).toBe(false);
  await claimAgentConnection(db,live,A,{lifecycleId:'first-boot'},{connectionId:'second-connection',instanceId:'test-server'});
  expect((await phone.readRoom(R,H))?.latestAgentTurns?.some(turn=>turn.status==='working')).toBe(false);
  expect((await db.query('SELECT status,ended_at FROM agent_turns WHERE request_id=$1',[c.turnRequestId])).rows)
    .toEqual([{status:'cancelled',ended_at:expect.any(Date)}]);
  expect((await db.query("SELECT id FROM messages WHERE room_id=$1 AND presentation='system' AND text LIKE '%failed%'",[R])).rows).toEqual([]);
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[c.id])).rows)
    .toEqual([{state:'pending'}]);
  const next={connectionId:'third-connection',epoch:await claimAgentConnection(db,live,A,{lifecycleId:'second-boot'},
    {connectionId:'third-connection',instanceId:'test-server'})};
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[c.id])).rows)
    .toEqual([{state:'pending'}]);
  expect((await readAgentCommands(db, A, R)).commands.map(item=>item.id)).toEqual([c.id]);
  await daemon.execute('startAgentTurn',{roomId:R,requestId:c.turnRequestId},A,undefined,next);
  expect((await phone.readRoom(R,H))?.latestAgentTurns).toContainEqual(expect.objectContaining({status:'working',requestId:c.turnRequestId}));
  await daemon.execute('postRoomMessage',{ roomId:R, requestId:c.turnRequestId, text:'Recovered answer.' },A);
  expect((await readAgentCommands(db, A, R)).commands).toEqual([]);
  expect((await notices()).rowCount).toBe(0);
});

it('a host disconnect ends a working line without posting a system line', async () => {
  const c = await ask();
  await daemon.execute('startAgentTurn', { roomId: R, requestId: c.turnRequestId, invocationId: 'offline-run' }, A);
  expect((await phone.readRoom(R, H))?.latestAgentTurns?.some(turn => turn.status === 'working')).toBe(true);
  const before = await db.query("SELECT id FROM messages WHERE room_id=$1 AND presentation='system'", [R]);
  await releaseAgentConnection(db, live, A, owner.connectionId);
  await db.backgroundWork.drain();
  expect((await phone.readRoom(R, H))?.latestAgentTurns?.some(turn => turn.status === 'working')).toBe(false);
  expect((await db.query("SELECT id FROM messages WHERE room_id=$1 AND presentation='system'", [R])).rows).toEqual(before.rows);
});

it('an initially offline mention waits for connection without an offline notice',async()=>{
  await releaseAgentConnection(db,live,A,owner.connectionId);
  const sent=await phone.execute('sendRoomMessage',{roomId:R,text:'@candy A request while offline'},H);
  const queued=(await readAgentCommands(db, A, R)).commands.find(c=>c.sourceMessageId===sent.messageId)!;
  expect(queued).toBeDefined();
  await db.backgroundWork.drain();
  expect((await db.query("SELECT text FROM messages WHERE room_id=$1 AND presentation='system'",[R])).rows).toEqual([]);
  const next={connectionId:'returning',epoch:await claimAgentConnection(db,live,A,{},
    {connectionId:'returning',instanceId:'test-server'})};
  await startQueuedTurn(db, R, A, queued.id);
  await daemon.execute('postRoomMessage',{ roomId:R, requestId:queued.turnRequestId, text:'I can answer now.' },A);
  expect((await notices()).rowCount).toBe(0);
});

it('a delivered terminal report keeps its order resumable in the same generation until the turn ends',async()=>{
  const command=(await createAgentCommand(db,{roomId:R,agentId:A,sourceMessageId:null,reason:'order',
    privatePayload:{kind:'order',authorId:H,fromRoomId:R,text:'Finish this assignment'}}))!;
  await startQueuedTurn(db, R, A, command.id);
  await daemon.execute('postRoomMessage',{ roomId:R, requestId:command.turn_request_id, harnessEnded: true, text:'The assignment is finished.' },A);
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[command.id])).rows).toEqual([{state:'complete'}]);
  await releaseAgentConnection(db,live,A,owner.connectionId);
  expect((await readAgentCommands(db, A, R)).commands).toEqual([]);
  expect((await notices()).rowCount).toBe(0);
});

const working=async()=>(await phone.readRoom(R,H))?.latestAgentTurns?.some(turn=>turn.status==='working');
async function answeredWhileRunning(invocationId:string){
  const c=await ask();
  const invocation={id:invocationId,requestId:c.turnRequestId};
  await daemon.execute('startAgentTurn',{roomId:R,requestId:c.turnRequestId,invocationId},A);
  await daemon.execute('postRoomMessage',{roomId:R,requestId:c.turnRequestId,text:'An answer during work.'},A);
  await db.backgroundWork.drain();
  return {c,invocation};
}

it('ends the working line at the reply while the run stays open, and later work cannot bring it back', async () => {
  const {c,invocation}=await answeredWhileRunning('running-session');
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[c.id])).rows).toEqual([{state:'complete'}]);
  expect((await db.query(`SELECT ended FROM agent_invocations WHERE invocation_id=$1`,[invocation.id])).rows).toEqual([{ended:false}]);
  expect(await working()).toBe(false);
  await daemon.execute('postAgentActivity',{roomId:R,requestId:c.turnRequestId,
    activity:[{kind:'tool',title:'Completed live step',status:'completed'}]},A);
  expect(await working()).toBe(false);
  await releaseAgentConnection(db,live,A,owner.connectionId);
  await claimAgentConnection(db,live,A,{},{connectionId:'resumed',instanceId:'test-server'});
  await daemon.execute('startAgentTurn',{roomId:R,requestId:c.turnRequestId},A);
  expect(await working()).toBe(false);
  await daemon.execute('postRoomMessage',{roomId:R,requestId:c.turnRequestId,text:'',harnessEnded:true,invocation},A);
  expect(await working()).toBe(false);
});

it('Stop on a line still working after the reply ends it and asks the helper to cancel that run', async () => {
  const {c,invocation}=await answeredWhileRunning('stale-line');
  // A line left working by a run that outlived its reply (the state before this fix).
  await db.query(`UPDATE agent_turns SET status='working' WHERE request_id=$1`,[c.turnRequestId]);
  expect(await working()).toBe(true);
  expect(await stoppedAnsweredCommandIds(db,A)).toEqual([]);
  await phone.execute('cancelAgentTurn',{roomId:R,agentId:A,requestId:c.turnRequestId},H);
  expect(await working()).toBe(false);
  expect((await db.query('SELECT status FROM agent_turns WHERE request_id=$1',[c.turnRequestId])).rows).toEqual([{status:'cancelled'}]);
  expect(await stoppedAnsweredCommandIds(db,A)).toEqual([c.id]);
  expect((await db.query("SELECT text FROM messages WHERE room_id=$1 AND presentation='system'",[R])).rows)
    .toContainEqual({text:expect.stringContaining('stopped')});
  // The cancelled run's closing receipt ends the invocation and the request.
  await daemon.execute('postRoomMessage',{roomId:R,requestId:c.turnRequestId,text:'',harnessEnded:true,invocation},A);
  expect(await stoppedAnsweredCommandIds(db,A)).toEqual([]);
  expect(await working()).toBe(false);
});

it('Stop on an answered request leaves a newer pending request for the same agent alone', async () => {
  const {c}=await answeredWhileRunning('older-run');
  await db.query(`UPDATE agent_turns SET status='working' WHERE request_id=$1`,[c.turnRequestId]);
  const newer=await ask();
  await phone.execute('cancelAgentTurn',{roomId:R,agentId:A,requestId:c.turnRequestId},H);
  expect((await db.query('SELECT state FROM agent_commands WHERE id=$1',[newer.id])).rows).toEqual([{state:'pending'}]);
  expect((await readAgentCommands(db,A,R)).commands.map(item=>item.id)).toEqual([newer.id]);
  expect((await phone.readRoom(R,H))?.latestAgentTurns).toContainEqual(expect.objectContaining({status:'working',requestId:newer.turnRequestId}));
});

it('Stop with no working line still reports that nothing was running', async () => {
  const {c}=await answeredWhileRunning('finished-line');
  await expect(phone.execute('cancelAgentTurn',{roomId:R,agentId:A,requestId:c.turnRequestId},H)).rejects.toThrow('running turn not found');
  expect(await stoppedAnsweredCommandIds(db,A)).toEqual([]);
});

it('a late old session final cannot clear a newer invocation of the same unanswered request', async () => {
  const c = await ask();
  const old = { id: 'old-run', requestId: c.turnRequestId };
  await daemon.execute('startAgentTurn', { roomId: R, requestId: c.turnRequestId, invocationId: old.id }, A);
  await daemon.execute('startAgentTurn', { roomId: R, requestId: c.turnRequestId, invocationId: 'new-run' }, A);
  await daemon.execute('postRoomMessage', { roomId: R, requestId: c.turnRequestId, text: 'Obsolete session answer', harnessEnded: true, invocation: old }, A);
  expect((await db.query('SELECT id FROM messages WHERE room_id=$1 AND text=$2', [R, 'Obsolete session answer'])).rows).toEqual([]);
  expect((await phone.readRoom(R, H))?.latestAgentTurns).toContainEqual(expect.objectContaining({ status: 'working' }));
});


it('ends a registered invocation when an older sender omitted its turn invocation id', async () => {
  const c = await ask();
  const invocation = { id: 'unprojected-run', requestId: c.turnRequestId };
  await daemon.execute('startAgentTurn', { roomId: R, requestId: c.turnRequestId, invocationId: invocation.id }, A);
  await db.query('UPDATE agent_turns SET invocation_id=NULL WHERE request_id=$1', [c.turnRequestId]);
  await daemon.execute('postRoomMessage', { roomId: R, requestId: c.turnRequestId, text: 'Answer', harnessEnded: true, invocation }, A);
  expect((await phone.readRoom(R, H))?.latestAgentTurns?.some(turn => turn.status === 'working')).toBe(false);
});

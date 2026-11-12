import {DaemonService} from './daemon-service.js';
import {PhoneService} from './phone-service.js';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {migratedDatabase,type PgliteDatabase} from './test-support.js';
import {ConnectionPresence,recordAgentEvidence} from './connection-presence.js';
import {authorizeCommandOutput,createAgentCommand,claimAgentCommand} from './agent-command.js';
import {LiveHub} from './live.js';

const ROOM='22222222-2222-4222-8222-222222222222',WORKSPACE='11111111-1111-4111-8111-111111111111';
const AGENT='b'.repeat(64),HUMAN='a'.repeat(64);
let database:PgliteDatabase,live:LiveHub,presence:ConnectionPresence;
beforeEach(async()=>{
  database=await migratedDatabase();live=new LiveHub();
  await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner',NULL),($2,'agent','Bee','bee')`,[HUMAN,AGENT]);
  await database.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[AGENT,HUMAN]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`,[WORKSPACE]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`,[ROOM,WORKSPACE]);
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member'),($1,NULL,$3,'member'),($1,$2,$4,'owner')`,[WORKSPACE,ROOM,AGENT,HUMAN]);
  presence=new ConnectionPresence(database,live);
});
afterEach(async()=>{await presence.stop();vi.restoreAllMocks();await database.close();});
const body=async()=>(await database.query<{body:Record<string,unknown>}>(`SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence' LIMIT 1`,[AGENT])).rows[0]?.body;
async function claimed(connectionId='connection'){
  const source={connectionId,epoch:await presence.claimConnection(AGENT,{connectionId})};
  const command=(await createAgentCommand(database,{roomId:ROOM,agentId:AGENT,sourceMessageId:null,reason:'system'}))!;
  await database.transaction(db=>claimAgentCommand(db,ROOM,AGENT,command.id,'generation',source));
  return {source,command};
}
it('keeps a closed connection’s running turn claimed for the same helper to continue',async()=>{
  const {source,command}=await claimed();await presence.releaseConnection(AGENT,source.connectionId);
  expect((await database.query('SELECT state,generation_id FROM agent_commands WHERE id=$1',[command.id])).rows)
    .toEqual([{state:'claimed',generation_id:'generation'}]);
  expect((await database.query('SELECT status FROM agent_turns WHERE request_id=$1',[command.turn_request_id])).rows).toEqual([{status:'working'}]);
  expect(await body()).toMatchObject({status:'offline'});
});
it('a late close of an older socket cannot release the current owner',async()=>{
  await presence.claimConnection(AGENT,{connectionId:'old'});const {source,command}=await claimed('new');
  await presence.releaseConnection(AGENT,'old');
  expect((await database.query('SELECT state,turn_owner_connection_id FROM agent_commands WHERE id=$1',[command.id])).rows)
    .toEqual([{state:'claimed',turn_owner_connection_id:source.connectionId}]);
  expect(await body()).toMatchObject({status:'online',held:true,connectionId:'new'});
});
it('a new authenticated connection, from the same or a new helper process, leaves the running turn claimed',async()=>{
  const {command}=await claimed('old');
  await presence.claimConnection(AGENT,{connectionId:'new',lifecycleId:'same-process'});
  await presence.claimConnection(AGENT,{connectionId:'restarted',lifecycleId:'new-process'});
  expect((await database.query('SELECT state,generation_id FROM agent_commands WHERE id=$1',[command.id])).rows)
    .toEqual([{state:'claimed',generation_id:'generation'}]);
  expect((await database.query('SELECT status FROM agent_turns WHERE request_id=$1',[command.turn_request_id])).rows).toEqual([{status:'working'}]);
});
it('turn age and incoming messages never arm a presence or stalled-turn watchdog',async()=>{
  const {command}=await claimed();const schedule=vi.spyOn(globalThis,'setTimeout');
  await database.query(`UPDATE agent_turns SET created_at=now()-interval '1 day' WHERE request_id=$1`,[command.turn_request_id]);
  live.publish({type:'invalidate',roomId:ROOM,reason:'postgres:agent_turns',requestId:command.turn_request_id,agentId:AGENT});
  live.publish({type:'invalidate',roomId:ROOM,reason:'message'});await Promise.resolve();
  expect(schedule).not.toHaveBeenCalled();
  expect((await database.query('SELECT state FROM agent_commands WHERE id=$1',[command.id])).rows).toEqual([{state:'claimed'}]);
});
it('retains one aggregate server lease while actual connections are held',async()=>{
  const release=presence.holdServerConnection();await presence.renewLease();
  expect((await database.query('SELECT 1 FROM live_server_instances WHERE instance_id=$1',[presence.instanceId])).rowCount).toBe(1);
  release();release();await presence.stop();
});
it('actual authenticated evidence advances the current lifecycle without a timer',async()=>{
  await presence.announce(ROOM,AGENT,{lifecycleId:'boot',releaseVersion:'v1.0.0'});const before=await body();
  await presence.evidence(ROOM,AGENT);await presence.evidence(ROOM,AGENT);
  expect(await body()).toMatchObject({lifecycleId:'boot',releaseVersion:'v1.0.0',status:'online'});
  expect(Number((await body())?.observedAt)).toBeGreaterThan(Number(before?.observedAt));
});
it('a shortened room id still advances online status',async()=>{
  await presence.announce(ROOM,AGENT,{lifecycleId:'boot'});
  await presence.evidence(ROOM.slice(0,8),AGENT);
  expect(await body()).toMatchObject({status:'online',lifecycleId:'boot'});
});
it('evidence merges with a concurrent lifecycle announcement',async()=>{
  await presence.announce(ROOM,AGENT,{lifecycleId:'boot-1'});
  await Promise.all([presence.announce(ROOM,AGENT,{lifecycleId:'boot-2',releaseVersion:'v2.0.0'}),recordAgentEvidence(database,live,ROOM,AGENT)]);
  expect(await body()).toMatchObject({lifecycleId:'boot-2',releaseVersion:'v2.0.0',status:'online'});
});

// Reproduction turn-write-reject: a stale server lease no longer refuses a claimed turn's output.
it('accepts a claimed turn’s output while its server instance lease is stale',async()=>{
  const {command}=await claimed();
  const daemon=new DaemonService(database,live);
  await database.query(`UPDATE live_server_instances SET renewed_at=clock_timestamp()-interval '161 seconds' WHERE instance_id=$1`,[presence.instanceId]);
  await daemon.execute('postCornerMessage',{roomId:ROOM,cornerId:ROOM,requestId:command.turn_request_id,generationId:'generation',text:'Live turn write'},AGENT);
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner')`,[WORKSPACE,HUMAN]);
  const room=await new PhoneService(database,'http://test').readRoom(ROOM,HUMAN);
  expect(room?.messages.filter(message=>message.text==='Live turn write')).toHaveLength(1);
});
it.each([
  ["DELETE FROM agent_commands",'no command row'],
  ["UPDATE agent_commands SET state='complete'",'state not claimed: complete'],
  ["UPDATE agent_commands SET generation_id=NULL",'generation ended'],
])('explains output refusal after %s',async(sql,reason)=>{
  const {command}=await claimed();vi.spyOn(console,'error').mockImplementation(()=>{});
  await database.query(sql);
  await expect(database.transaction(db=>authorizeCommandOutput(db,ROOM,AGENT,command.turn_request_id,'generation')))
    .rejects.toThrow('command output authority rejected: '+reason);
});

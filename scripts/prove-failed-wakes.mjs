import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PgliteDatabase} from '../apps/server/src/test-support.ts';
import {migrate} from '../apps/server/dist/database.js';
import {DaemonService} from '../apps/server/dist/daemon-service.js';
import {PhoneService} from '../apps/server/dist/phone-service.js';
import {LiveHub} from '../apps/server/dist/live.js';
import {claimAgentConnection} from '../apps/server/dist/connection-presence.js';
import {createAgentCommand} from '../apps/server/dist/agent-command.js';
import {CommandExecutionContext,runServerCommandIntake} from '../apps/body/dist/server-command-intake.js';

// Reproduction F1 uses an isolated database and scratch context. Never pair,
// start, stop or modify the installed helper to demonstrate a failed wake.
const db=new PgliteDatabase(), scratch=await mkdtemp(join(tmpdir(),'beeline-f1-'));
const H='a'.repeat(64),A='b'.repeat(64),W=randomUUID(),R=randomUUID();
try {
  await migrate(db);
  const live=new LiveHub(),daemon=new DaemonService(db,live),phone=new PhoneService(db,live);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Worker','worker')`,[H,A]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[A,H]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Failure proof')",[W]);
  await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Review place')",[R,W]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,[W,H,A,R]);
  await db.query("INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('proof',clock_timestamp())");
  const owner={connectionId:'proof-helper',epoch:await claimAgentConnection(db,live,A,{}, {connectionId:'proof-helper',instanceId:'proof'})};
  let releases=0;
  async function turn(reason, orders=[{authorId:H,fromRoomId:R}]) {
    const commands=[];
    for(const route of orders) commands.push(await createAgentCommand(db,{roomId:R,agentId:A,sourceMessageId:null,reason:'order',
      privatePayload:{kind:'order',...route,text:'Review this change'}}));
    const command=commands[0];
    const abort=new AbortController(),context=new CommandExecutionContext(scratch);
    const api={turnOwnershipScope:()=>owner,execute:async(name,input)=>{
      const result=await daemon.execute(name,input,A,
        ['claimAgentTurn','releaseAgentTurn','postAgentTurnReceipt'].includes(name)?owner:undefined);
      if(name==='releaseAgentTurn'){releases++;abort.abort();}
      return result;
    }};
    await runServerCommandIntake({api,roomId:R,agentId:A,context,signal:abort.signal,stop:()=>{},run:async()=>{
      if(reason)throw new Error(reason);
      // The harness ran and chose no reply. This must stay successful.
    }});
    const room=await phone.readRoom(R,H);
    assert.equal(room.latestAgentTurns.find(turn=>turn.requestId===command.turn_request_id)?.status,reason?'failed':'complete');
    if(reason)assert(room.messages.some(message=>message.systemEvent?.verb==='could not finish this request' && message.text.includes(reason)));
    return room.messages.filter(message=>message.text.startsWith('failed:'));
  }
  let reports=await turn('review checkout has uncommitted work');
  assert.equal(reports.length,1);assert(reports[0].text.includes('@worker'));assert(reports[0].text.includes(R));
  console.log('Reproduction F1 PASS: injected pre-turn failure shows failed with its reason and reaches the sender');
  reports=await turn('agent process exited before output');assert.equal(reports.length,2);
  console.log('Generic early crash PASS: failed state and one repeated-failure update reach the sender');
  reports=await turn('spawn failed');assert.equal(reports.length,2);
  reports=await turn('checkout preparation failed');assert.equal(reports.length,2);
  console.log('Repeated failures PASS: further failures create no additional sender reports');
  await turn();
  reports=await turn('new failure after successful quiet turn');assert.equal(reports.length,3);
  console.log('Recovery PASS: a successful quiet turn clears the failed state and resets report suppression');
  assert.equal(releases,6);
  const other='c'.repeat(64),returnPlace=randomUUID();
  await db.query("INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Other issuer','otherissuer')",[other]);
  await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Other return place')",[returnPlace,W]);
  for(const member of [H,other,A]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'member'),($1,$3,$2,'member') ON CONFLICT DO NOTHING`,[W,member,returnPlace]);
  const orders=[{authorId:H,fromRoomId:R},{authorId:other,fromRoomId:returnPlace},{authorId:H,fromRoomId:R}];
  const returned=async()=> (await phone.readRoom(returnPlace,other)).messages.filter(message=>message.text.startsWith('failed:'));
  await turn();
  for(let attempt=1;attempt<=4;attempt++) {
    reports=await turn('checkout preparation failed',orders);
    assert.equal(reports.length,3+Math.min(attempt,2));
    const otherReports=await returned();
    assert.equal(otherReports.length,Math.min(attempt,2));
    assert(otherReports.every(message=>message.text.includes('@worker') && message.text.includes(R)
      && message.text.includes('checkout preparation failed')));
  }
  await turn();
  reports=await turn('checkout preparation failed',orders);
  assert.equal(reports.length,6);assert.equal((await returned()).length,3);
  console.log('Reproduction F1 multiple issuers PASS: each return place receives its report, same-route siblings deduplicate, repeats stay bounded, and success resets both routes');
  assert.equal(releases,13);
} finally {await db.close();await rm(scratch,{recursive:true,force:true});}

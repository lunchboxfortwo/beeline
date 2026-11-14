import {afterEach,beforeEach,expect,it} from 'vitest';
import {migratedDatabase,type PgliteDatabase} from '../test-support.js';
import {ORPHANED_TURNS,repairOrphanedTurns} from './orphaned-turns.js';
import {createAgentCommand} from '../agent-command.js';

let db:PgliteDatabase;
const workspace='11111111-1111-4111-8111-111111111111',human='a'.repeat(64);
beforeEach(async()=>{
  db=await migratedDatabase();
  await db.query("INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')",[human]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Workspace')",[workspace]);
  await db.query("INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')",[workspace,human]);
  for(const agent of new Set(ORPHANED_TURNS.map(row=>row[2]))){
    await db.query("INSERT INTO identities(id,kind,name) VALUES($1,'agent','Agent')",[agent]);
    await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[agent,human]);
    await db.query("INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')",[workspace,agent]);
  }
  for(const [room,request,agent,start] of ORPHANED_TURNS){
    await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')",[room,workspace]);
    await db.query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')",[workspace,room,agent]);
    await db.query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')",[workspace,room,human]);
    await db.query("INSERT INTO agent_turns(room_id,request_id,agent_id,status,started_at) VALUES($1,$2,$3,'working',$4)",[room,request,agent,start]);
  }
});
afterEach(()=>db.close());

it('repairs exactly the eight inventoried executions without changing unanswered queue items',async()=>{
  for(const [room,request,agent] of ORPHANED_TURNS.slice(6))
    await createAgentCommand(db,{id:request,roomId:room,agentId:agent,sourceMessageId:null,reason:'order',
      privatePayload:{kind:'order',authorId:human,fromRoomId:room,text:'Answer this'}});
  const queued=(await db.query('SELECT * FROM agent_commands ORDER BY id')).rows;
  const [room,,agent]=ORPHANED_TURNS[0];
  await db.query("INSERT INTO agent_turns(room_id,request_id,agent_id,status) VALUES($1,'fresh',$2,'working')",[room,agent]);
  await repairOrphanedTurns(db);await repairOrphanedTurns(db);
  expect((await db.query("SELECT status,ended_at FROM agent_turns WHERE request_id<>'fresh'")).rows)
    .toEqual(Array.from({length:8},()=>({status:'cancelled',ended_at:expect.any(Date)})));
  expect((await db.query("SELECT status FROM agent_turns WHERE request_id='fresh'")).rows).toEqual([{status:'working'}]);
  expect((await db.query('SELECT * FROM agent_commands ORDER BY id')).rows).toEqual(queued);
});

it('preserves an execution redelivered under the same key after the inventory',async()=>{
  const [room,request]=ORPHANED_TURNS[6];
  await db.query('UPDATE agent_turns SET started_at=clock_timestamp() WHERE room_id=$1 AND request_id=$2',[room,request]);
  await repairOrphanedTurns(db);
  expect((await db.query('SELECT status,ended_at FROM agent_turns WHERE room_id=$1 AND request_id=$2',[room,request])).rows)
    .toEqual([{status:'working',ended_at:null}]);
});

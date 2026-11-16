// Run with node --import tsx after building apps/server.
// Isolated PGlite and built services; never connects to the production helper.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migratedDatabase } from '../../apps/server/src/test-support.ts';
import { DaemonService } from '../../apps/server/dist/daemon-service.js';
import { PhoneService } from '../../apps/server/dist/phone-service.js';
import { LiveHub } from '../../apps/server/dist/live.js';
import { claimAgentConnection } from '../../apps/server/dist/connection-presence.js';

const db = await migratedDatabase();
const human='a'.repeat(64), agent='b'.repeat(64), workspace=randomUUID(), room=randomUUID();
try {
  await db.query(`INSERT INTO identities(id,kind,name,handle)
    VALUES($1,'human','Owner','owner'),($2,'agent','Worker','worker')`,[human,agent]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)',[agent,human]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Stop proof')",[workspace]);
  await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Stop proof')",[room,workspace]);
  for (const id of [human,agent]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner')`,[workspace,room,id]);
  const live=new LiveHub(), daemon=new DaemonService(db,live), phone=new PhoneService(db,'http://proof');
  await db.query("INSERT INTO live_server_instances(instance_id,renewed_at) VALUES('proof',clock_timestamp())");
  const owner={connectionId:'proof-helper',epoch:await claimAgentConnection(db,live,agent,{},
    {connectionId:'proof-helper',instanceId:'proof'})};
  for(let i=0;i<5;i++) await phone.execute('sendRoomMessage',{roomId:room,text:`@worker R1 wake ${i}`},human);
  const [first]=(await daemon.execute('getAgentCommands',{roomId:room},agent)).commands;
  const batch=await daemon.execute('claimAgentTurn',{roomId:room,commandId:first.id,generationId:'r1-proof'},agent,owner);
  assert.equal(batch.commands.length,5);
  const before=await phone.readRoom(room,human);
  assert(before.latestAgentTurns.some(turn=>turn.status==='working'));
  await phone.execute('sendRoomMessage',{roomId:room,text:'@worker Later work'},human);
  await phone.execute('cancelAgentTurn',{roomId:room,agentId:agent,requestId:batch.commands[1].turnRequestId},human);
  const after=await phone.readRoom(room,human);
  assert.equal(after.latestAgentTurns.some(turn=>turn.status==='working'),false);
  assert(after.messages.some(message=>message.text==='@owner stopped @worker · turn cancelled'));
  const pending=(await daemon.execute('getAgentCommands',{roomId:room},agent)).commands.filter(c=>c.action==='input');
  assert.equal(pending.length,1);
  assert.equal(pending[0].source.body,'@worker Later work');
  console.log('PASS Reproduction R1: built phone send → five-request helper claim → non-primary Stop → receipt visible and no thinking turn in phone Room read before helper cleanup; later work remains queued.');
} finally { await db.close(); }

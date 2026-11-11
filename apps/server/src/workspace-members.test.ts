import { afterEach, beforeEach, expect, it } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { consolidateWorkspaceMembers } from './membership-join.js';
import { migrate } from './database.js';
import { PhoneService } from './phone-service.js';
import { ensureSystemDirectMessageRoomResult } from './system-line.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';

const W = '11111111-1111-4111-8111-111111111111';
const PUBLIC = '22222222-2222-4222-8222-222222222222';
const PRIVATE = '33333333-3333-4333-8333-333333333333';
const OWNER = 'a'.repeat(64), HUMAN = 'b'.repeat(64), FREE = 'c'.repeat(64), MCP = 'd'.repeat(64);
let db: PgliteDatabase, phone: PhoneService;

beforeEach(async () => {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name) VALUES
    ($1,'human','Owner'),($2,'human','Person'),($3,'agent','Free'),($4,'agent','MCP')`, [OWNER,HUMAN,FREE,MCP]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [FREE,MCP,OWNER]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,visibility) VALUES
    ($1,$3,'public','public'),($2,$3,'private','invite-only')`, [PUBLIC,PRIVATE,W]);
  await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner'),($1,$3,'member')`, [W,OWNER,HUMAN]);
  phone = new PhoneService(db,'https://server.example');
});
afterEach(async () => { await db.close(); });

it('lets Workspace members join and post in public chats; private chats need an invitation', async () => {
  expect(await phone.readRoom(PUBLIC,HUMAN)).toBeNull();
  await expect(phone.execute('sendRoomMessage',{roomId:PUBLIC,text:'before join'},HUMAN)).rejects.toThrow();
  await expect(phone.execute('addRoomMember',{roomId:PUBLIC,memberId:HUMAN},HUMAN)).resolves.toEqual({joined:true});
  expect(await phone.readRoom(PUBLIC,HUMAN)).not.toBeNull();
  await expect(phone.execute('sendRoomMessage',{roomId:PUBLIC,text:'after join'},HUMAN)).resolves.toBeDefined();
  expect(await phone.readRoom(PRIVATE,HUMAN)).toBeNull();
  await expect(phone.execute('addRoomMember',{roomId:PRIVATE,memberId:HUMAN},HUMAN)).rejects.toThrow();
  await expect(phone.execute('sendRoomMessage',{roomId:PRIVATE,text:'before invitation'},HUMAN)).rejects.toThrow();
  await phone.execute('addRoomMember',{roomId:PRIVATE,memberId:HUMAN},OWNER);
  expect(await phone.readRoom(PRIVATE,HUMAN)).not.toBeNull();
  await expect(phone.execute('sendRoomMessage',{roomId:PRIVATE,text:'invited'},HUMAN)).resolves.toBeDefined();
  const outsider = 'e'.repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Outsider')`,[outsider]);
  await expect(phone.execute('addRoomMember',{roomId:PUBLIC,memberId:outsider},outsider)).rejects.toThrow();
  expect(await phone.readRoom(PUBLIC,outsider)).toBeNull();
  await expect(phone.execute('addRoomMember',{roomId:PRIVATE,memberId:outsider},OWNER)).rejects.toThrow();
});

it('backfills agent-specific memberships once, retaining existing departures and every chat row', async () => {
  await db.query(`ALTER TABLE free_agents ADD COLUMN IF NOT EXISTS workspace_id uuid;
    ALTER TABLE rooms_mcp_members ADD COLUMN IF NOT EXISTS workspace_ids uuid[]`);
  await db.query(`INSERT INTO free_agents(agent_id,owner_id,workspace_id,sealed_keys) VALUES($1,$2,$3,'fixture')`,[FREE,OWNER,W]);
  await db.query(`INSERT INTO rooms_mcp_clients(id,name,redirects) VALUES('client','App','[]')`);
  await db.query(`INSERT INTO rooms_mcp_members(client_id,owner_id,member_id,model_label,workspace_ids)
    VALUES('client',$1,$2,'App',ARRAY[$3::uuid])`,[OWNER,MCP,W]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role,push_muted)
    VALUES($1,$2,$3,'member',true),($1,$2,$4,'member',false),($1,$2,$5,'member',false)`,[W,PRIVATE,FREE,MCP,HUMAN]);
  await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id IS NULL`,[HUMAN]);
  const before = (await db.query(`SELECT id,room_id,identity_id,joined_at,push_muted FROM memberships WHERE room_id IS NOT NULL ORDER BY id`)).rows;
  expect(await consolidateWorkspaceMembers(db)).toEqual({removedChatJoins:3,people:1,agents:2,free:1,mcp:1});
  expect((await db.query(`SELECT id,room_id,identity_id,joined_at,push_muted FROM memberships WHERE room_id IS NOT NULL ORDER BY id`)).rows).toEqual(before);
  expect((await db.query(`SELECT 1 FROM memberships WHERE room_id IS NOT NULL AND removed_at IS NULL`)).rowCount).toBe(0);
  expect((await db.query(`SELECT 1 FROM memberships`)).rowCount).toBe(7);
  expect((await phone.readWorkspaceMembers(W,OWNER))?.agents.map(member => member.identity.pubkey).sort()).toEqual([FREE,MCP]);
  expect(await phone.readRoom(PRIVATE,FREE)).toBeNull();
  expect(await phone.readRoom(PRIVATE,MCP)).toBeNull();
  expect(await consolidateWorkspaceMembers(db)).toEqual({removedChatJoins:0,people:0,agents:0,free:0,mcp:0});
  expect((await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
    AND ((table_name='free_agents' AND column_name='workspace_id') OR (table_name='rooms_mcp_members' AND column_name='workspace_ids'))`)).rowCount).toBe(2);
});

it('uses the same public/private join rule for helper agents', async () => {
  await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`,[W,FREE]);
  const daemon = new DaemonService(db,new LiveHub());
  await expect(daemon.execute('ensureAgentMembership',{roomId:PRIVATE},FREE)).rejects.toThrow();
  await expect(daemon.execute('ensureAgentMembership',{roomId:PUBLIC},FREE)).resolves.toBeDefined();
  expect(await phone.readRoom(PUBLIC,FREE)).not.toBeNull();
  await phone.execute('addRoomMember',{roomId:PRIVATE,memberId:FREE},OWNER);
  await expect(daemon.execute('ensureAgentMembership',{roomId:PRIVATE},FREE)).resolves.toBeDefined();
  await db.query(`UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND identity_id=$2 AND room_id IS NULL`,[W,FREE]);
  await expect(daemon.access(PUBLIC,FREE)).rejects.toThrow();
  expect(await phone.readRoom(PUBLIC,FREE)).toBeNull();
});

it('keeps System an author rather than an orphan member of private chats', async () => {
  const room = await ensureSystemDirectMessageRoomResult(db,W,HUMAN);
  expect((await db.query(`SELECT identity_id FROM memberships WHERE room_id=$1 AND removed_at IS NULL`,[room.id])).rows).toEqual([{identity_id:HUMAN}]);
  expect((await db.query(`SELECT direct_participants FROM rooms WHERE id=$1`,[room.id])).rows[0]!.direct_participants).toContain(SYSTEM_IDENTITY_ID);
  expect((await consolidateWorkspaceMembers(db)).removedChatJoins).toBe(0);
  expect(await phone.readRoom(room.id,HUMAN)).not.toBeNull();
});

it('never revives an agent departure from machine or MCP metadata, or changes its answer policy', async () => {
  await db.query(`ALTER TABLE free_agents ADD COLUMN IF NOT EXISTS workspace_id uuid;
    ALTER TABLE rooms_mcp_members ADD COLUMN IF NOT EXISTS workspace_ids uuid[]`);
  await db.query(`INSERT INTO memberships(workspace_id,identity_id,role,removed_at)
    VALUES($1,$2,'member',now()),($1,$3,'member',now())`,[W,FREE,MCP]);
  await db.query(`INSERT INTO free_agents(agent_id,owner_id,workspace_id,sealed_keys) VALUES($1,$2,$3,'fixture')`,[FREE,OWNER,W]);
  await db.query(`INSERT INTO rooms_mcp_clients(id,name,redirects) VALUES('client','App','[]')`);
  await db.query(`INSERT INTO rooms_mcp_members(client_id,owner_id,member_id,model_label,workspace_ids)
    VALUES('client',$1,$2,'App',ARRAY[$3::uuid])`,[OWNER,MCP,W]);
  await db.query(`UPDATE agents SET access_policy='{"type":"creator"}'`);
  expect(await consolidateWorkspaceMembers(db)).toEqual({removedChatJoins:0,people:0,agents:0,free:0,mcp:0});
  expect((await db.query(`SELECT 1 FROM memberships WHERE identity_id=ANY($1::text[]) AND removed_at IS NULL`,[[FREE,MCP]])).rowCount).toBe(0);
  expect((await db.query(`SELECT access_policy FROM agents`)).rows).toEqual([
    {access_policy:{type:'creator'}},{access_policy:{type:'creator'}},
  ]);
});

it('retains free-machine cleanup metadata when its final Workspace is deleted', async () => {
  await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`,[W,FREE]);
  await db.query(`INSERT INTO free_agents(agent_id,owner_id,sealed_keys,fly_machine_id,bootstrap_hash,model_token_hash)
    VALUES($1,$2,'fixture','machine','bootstrap','model')`,[FREE,OWNER]);
  expect((await consolidateWorkspaceMembers(db)).free).toBe(0);
  await phone.execute('deleteWorkspace',{workspaceId:W},OWNER);
  expect((await db.query(`SELECT fly_machine_id,removed_at IS NOT NULL removed,bootstrap_hash,model_token_hash
    FROM free_agents WHERE agent_id=$1`,[FREE])).rows).toEqual([
    {fly_machine_id:'machine',removed:true,bootstrap_hash:null,model_token_hash:null},
  ]);
  expect((await db.query(`SELECT 1 FROM memberships WHERE workspace_id=$1`,[W])).rowCount).toBe(0);
});

it('contracts the preceding release without deleting canonical members, joins or agent metadata', async () => {
  // Simulate an expand image, including an orphan join recreated during overlap.
  await db.query(`DELETE FROM workflow_backfills WHERE name='workspace-members-contract-v1';
    ALTER TABLE free_agents ADD COLUMN workspace_id uuid;
    ALTER TABLE rooms_mcp_members ADD COLUMN workspace_ids uuid[];
    CREATE VIEW effective_memberships AS SELECT * FROM room_access;`);
  await db.query(`INSERT INTO free_agents(agent_id,owner_id,workspace_id,sealed_keys) VALUES($1,$2,$3,'fixture')`,[FREE,OWNER,W]);
  await db.query(`INSERT INTO rooms_mcp_clients(id,name,redirects) VALUES('client','App','[]')`);
  await db.query(`INSERT INTO rooms_mcp_members(client_id,owner_id,member_id,model_label,workspace_ids)
    VALUES('client',$1,$2,'App',ARRAY[$3::uuid])`,[OWNER,MCP,W]);
  const orphan = 'e'.repeat(64);
  await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Former member')`,[orphan]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
    ($1,NULL,$2,'member'),($1,NULL,$3,'member'),($1,$4,$2,'member'),
    ($1,$5,$3,'member'),($1,$4,$6,'member'),($1,$4,$7,'member')`,[W,FREE,MCP,PRIVATE,PUBLIC,HUMAN,orphan]);
  const records = async () => (await db.query(`SELECT id,workspace_id,room_id,identity_id,role,joined_at,push_muted
    FROM memberships ORDER BY id`)).rows;
  const before = await records();
  await migrate(db);
  expect(await records()).toEqual(before);
  expect((await db.query(`SELECT 1 FROM memberships WHERE identity_id=$1 AND removed_at IS NULL`,[orphan])).rowCount).toBe(0);
  expect((await db.query(`SELECT 1 FROM free_agents WHERE agent_id=$1`,[FREE])).rowCount).toBe(1);
  expect((await db.query(`SELECT 1 FROM rooms_mcp_members WHERE member_id=$1`,[MCP])).rowCount).toBe(1);
  expect((await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
    AND ((table_name='free_agents' AND column_name='workspace_id') OR (table_name='rooms_mcp_members' AND column_name='workspace_ids'))`)).rowCount).toBe(0);
  expect((await db.query(`SELECT 1 FROM pg_views WHERE schemaname=current_schema() AND viewname='effective_memberships'`)).rowCount).toBe(0);
  expect(await phone.readRoom(PRIVATE,HUMAN)).not.toBeNull();
  expect(await phone.readRoom(PUBLIC,MCP)).not.toBeNull();
  await migrate(db);
  expect(await records()).toEqual(before);
});

import { afterEach, beforeEach, expect, it } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { cleanupConnectHandles } from './migrations/connect-handle-cleanup.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

const owner = '34cf4160723acd12d205dfbe292614bfec9489b78812d1cd9846c00346903334';
const milo = '0e0aa42e01c5972bc5953e13f880aedf2229de917dc0f5bf00ee9a943ec44fdb';
const ghost = '1461b5d603d04e86ba7b1c843cd25e0e406c79c4c60395e67ff916edad10e3d1';
const old = 'c'.repeat(64), greeter = 'd'.repeat(64), message = 'e'.repeat(64);
const workspace = '18e555f7-e191-452b-9b0f-b825f58ee4ba', room = '22222222-2222-4222-8222-222222222222';
let db: PgliteDatabase;
beforeEach(async () => {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner')`, [owner]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Test')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'general')`, [room,workspace]);
  for (const [id,handle] of [[old,'milo'],[milo,'bruin'],[ghost,'echo_5'],[greeter,'greeter']]) {
    await db.query(`INSERT INTO identities(id,kind,name,handle,workspace_handle_base) VALUES($1,'agent','Milo',$2,$2)`, [id,handle]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [id,owner]);
    await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`, [workspace,id]);
  }
  await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [old]);
  // Recreate a reservation left by the previous image.
  await db.query(`INSERT INTO workspace_handles(workspace_id,identity_id,handle) VALUES($1,$2,'milo')`, [workspace,old]);
  await db.query(`INSERT INTO agent_pairing_codes(code_hash,workspace_id,created_by,expires_at,claimed_by)
    VALUES('fixture',$1,$2,now()+interval '1 hour',$3)`, [workspace,owner,ghost]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
    VALUES($1,$2,$3,'joined','system','member-joined','{}')`, [message,room,ghost]);
  await db.query(`INSERT INTO push_message_context(message_id,room_id,author_id,turn_ids,burst_ids,expires_at)
    VALUES($1,$2,$3,ARRAY[$1],ARRAY[$1],now()+interval '1 hour')`, [message,room,ghost]);
  for (const id of ['1'.repeat(64),'2'.repeat(64)]) await db.query(`INSERT INTO agent_commands(
    id,room_id,agent_id,source_message_id,turn_request_id,action,reason,root_command_id,root_source_message_id,agent_depth,state)
    VALUES($1,$2,$3,$4,$1,'input','joined',$1,$4,0,'complete')`, [id,room,id.startsWith('1') ? greeter : milo,message]);
});
afterEach(async () => db.close());

it('releases stale handles, repairs only the named agent and deletes failed setup while retaining shared command history, twice', async () => {
  const result = await cleanupConnectHandles(db);
  expect(result.released).toEqual([{workspace_id:workspace,identity_id:old,handle:'milo'}]);
  expect((await db.query(`SELECT beeline_workspace_handle($1,$2) handle`, [milo,workspace])).rows).toEqual([{handle:'milo'}]);
  expect((await db.query(`SELECT handle FROM identities WHERE id=$1`, [old])).rows).toEqual([{handle:'milo'}]);
  for (const [table,column] of [['identities','id'],['agents','agent_id'],['memberships','identity_id'],['workspace_handles','identity_id'],['agent_pairing_codes','claimed_by'],['push_message_context','author_id']])
    expect((await db.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`,[ghost])).rows,table).toEqual([]);
  expect((await db.query(`SELECT author_id,deleted_at IS NOT NULL deleted FROM messages WHERE id=$1`,[message])).rows)
    .toEqual([{author_id:SYSTEM_IDENTITY_ID,deleted:true}]);
  expect((await db.query(`SELECT id FROM agent_commands WHERE source_message_id=$1`,[message])).rowCount).toBe(2);
  expect((await cleanupConnectHandles(db)).released).toEqual([]);
});

it('refuses changed targets and rolls back all cleanup when the failed agent has since run', async () => {
  await db.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{}')`,[room,ghost]);
  await expect(cleanupConnectHandles(db)).rejects.toThrow('already ran');
  expect((await db.query(`SELECT handle FROM workspace_handles WHERE identity_id=$1`,[old])).rows).toEqual([{handle:'milo'}]);
  expect((await db.query(`SELECT author_id,deleted_at FROM messages WHERE id=$1`,[message])).rows).toEqual([{author_id:ghost,deleted_at:null}]);
});

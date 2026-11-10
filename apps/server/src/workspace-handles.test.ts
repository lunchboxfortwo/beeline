import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { WORKSPACE_HANDLE_SCHEMA } from './workspace-handles.js';
import { resolveCurrentMemberMentions, taggedIdentityIdsSql, tagsKnownIdentitySql } from './message-mentions.js';

let db: PgliteDatabase;
const owner = 'a'.repeat(64);
beforeEach(async () => {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner')`, [owner]);
});
afterEach(async () => { await db.close(); });
async function workspace() {
  const id = randomUUID(), room = randomUUID();
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Test')`, [id]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'general',$3)`, [room,id,owner]);
  return { id,room };
}
async function agent(id: string, handle: string, fresh = true) {
  await db.query(`INSERT INTO identities(id,kind,name,handle,workspace_handle_base)
    VALUES($1,'agent','X',$2,$3)`, [id,handle,fresh ? 'x' : null]);
}
async function join(w: {id:string;room:string}, id: string) {
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`, [w.id,w.room,id]);
}
async function handle(w: {id:string}, id: string) {
  return (await db.query<{handle:string}>(`SELECT beeline_workspace_handle($1,$2) handle`, [id,w.id])).rows[0]!.handle;
}
async function tags(room: string, text: string, expected: string[]) {
  expect((await resolveCurrentMemberMentions(db,room,text,owner)).map(row => row.id).sort()).toEqual(expected.sort());
  const message = 'f'.repeat(64);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)
    ON CONFLICT(id) DO UPDATE SET room_id=$2,text=$4`, [message,room,owner,text]);
  expect((await db.query<{ids:string[]}>(`SELECT ${taggedIdentityIdsSql('m')} ids FROM messages m WHERE id=$1`, [message])).rows[0]!.ids.sort()).toEqual(expected.sort());
  for (const id of expected) expect((await db.query<{tagged:boolean}>(`SELECT ${tagsKnownIdentitySql('m','$2','NULL',"'agent'")} tagged FROM messages m WHERE id=$1`, [message,id])).rows[0]!.tagged).toBe(true);
}

it('numbers same-workspace clashes, keeps other workspaces plain and retains reservations after rename and departure', async () => {
  const one = await workspace(), two = await workspace();
  const x = 'b'.repeat(64), y = 'c'.repeat(64), z = 'd'.repeat(64);
  await agent(x,'x'); await agent(y,'x_2'); await agent(z,'x_3');
  await join(one,x); await join(one,y); await join(two,z);
  expect(await handle(one,x)).toBe('x'); expect(await handle(one,y)).toBe('x_2'); expect(await handle(two,z)).toBe('x');
  await tags(one.room,'@x @x_2',[x,y]); await tags(two.room,'@x',[z]);
  await db.query(`UPDATE identities SET name='Renamed' WHERE id=$1`, [y]);
  await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [x]);
  expect(await handle(one,y)).toBe('x_2');
  await db.query(WORKSPACE_HANDLE_SCHEMA);
  expect(await handle(one,y)).toBe('x_2');
});

it('reserves a local collision address for an arriving agent without changing its other workspace', async () => {
  const one = await workspace(), two = await workspace();
  const x = 'b'.repeat(64), y = 'c'.repeat(64);
  await agent(x,'x'); await agent(y,'x_2'); await join(one,x); await join(two,y);
  await join(two,x);
  expect(await handle(one,x)).toBe('x'); expect(await handle(two,x)).toBe('x_2'); expect(await handle(two,y)).toBe('x');
  await tags(one.room,'@x',[x]); await tags(two.room,'@x @x_2',[x,y]);
});

it('migrates legacy numbered handles unchanged, twice, and continues resolving old tags', async () => {
  const w = await workspace(), x = 'b'.repeat(64);
  await agent(x,'luna_10',false);
  await db.query(`DROP TRIGGER beeline_workspace_handle ON memberships`);
  await join(w,x);
  await db.query(WORKSPACE_HANDLE_SCHEMA); await db.query(WORKSPACE_HANDLE_SCHEMA);
  expect(await handle(w,x)).toBe('luna_10');
  await tags(w.room,'@luna_10',[x]);
});

it('reserves DM arrivals in the destination workspace and prevents later global person claims', async () => {
  const one = await workspace(), two = await workspace();
  const x = 'b'.repeat(64), y = 'c'.repeat(64);
  await agent(x,'x'); await agent(y,'x_2');
  await join(one,x); await join(two,y);
  const dm = randomUUID();
  await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES($1,$2,'DM',$3::jsonb)`,
    [dm,two.id,JSON.stringify([owner,x])]);
  await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [two.id,dm,x]);
  expect((await db.query<{handle:string}>(`SELECT beeline_room_handle($1,$2) handle`,[x,dm])).rows[0]!.handle).toBe('x_2');
  expect(await handle(one,x)).toBe('x');
  await tags(dm,'@x_2',[x]);
  expect((await db.query<{handle:string|null}>(`SELECT beeline_identity_handle($1,'x',true) handle`,[owner])).rows[0]!.handle).toBeNull();
});

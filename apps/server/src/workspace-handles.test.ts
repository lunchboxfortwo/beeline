import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { removeWorkspaceMemberships } from './membership-join.js';
import { WORKSPACE_HANDLE_SCHEMA } from './workspace-handles.js';
import { resolveCurrentMemberMentions, taggedIdentityIdsSql, tagsKnownIdentitySql } from './message-mentions.js';
import { PhoneService } from './phone-service.js';

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

it('numbers same-workspace clashes, keeps other workspaces plain and retains reservations after rename and releases them after departure', async () => {
  const one = await workspace(), two = await workspace();
  const x = 'b'.repeat(64), y = 'c'.repeat(64), z = 'd'.repeat(64);
  await agent(x,'x'); await agent(y,'x_2'); await agent(z,'x_3');
  await join(one,x); await join(one,y); await join(two,z);
  expect(await handle(one,x)).toBe('x'); expect(await handle(one,y)).toBe('x_2'); expect(await handle(two,z)).toBe('x');
  await tags(one.room,'@x @x_2',[x,y]); await tags(two.room,'@x',[z]);
  await db.query(`UPDATE identities SET name='Renamed' WHERE id=$1`, [y]);
  await db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [x]);
  expect(await handle(one,y)).toBe('x_2');
  expect((await db.query(`SELECT 1 FROM workspace_handles WHERE workspace_id=$1 AND identity_id=$2`,[one.id,x])).rows).toEqual([]);
  await agent('e'.repeat(64),'x_4'); await join(one,'e'.repeat(64));
  expect(await handle(one,'e'.repeat(64))).toBe('x');
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

it('releases a removed member address atomically and lets the next same-name agent take it', async () => {
  const w = await workspace(), departed = 'b'.repeat(64), next = 'c'.repeat(64);
  await agent(departed,'x'); await join(w,departed);
  await expect(db.transaction(async tx => {
    await removeWorkspaceMemberships(tx,[w.id,departed]);
    expect((await tx.query(`SELECT 1 FROM workspace_handles WHERE identity_id=$1`,[departed])).rows).toEqual([]);
    throw new Error('abort departure');
  })).rejects.toThrow('abort departure');
  expect(await handle(w,departed)).toBe('x');
  await db.transaction(tx => removeWorkspaceMemberships(tx,[w.id,departed]));
  await agent(next,'x_2'); await join(w,next);
  expect(await handle(w,next)).toBe('x');
});

it('keeps chat-list author, peer and reaction handles scoped while human handles stay live', async () => {
  const w = await workspace(), x = 'b'.repeat(64);
  await agent(x, 'x_9'); await join(w, owner); await join(w, x);
  await db.query(`UPDATE rooms SET direct_participants=$2::jsonb WHERE id=$1`,
    [w.room, JSON.stringify([owner, x])]);
  // A human's global handle wins even if an old reservation remains.
  await db.query(`INSERT INTO workspace_handles(workspace_id,identity_id,handle) VALUES($1,$2,'old-owner')`, [w.id, owner]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,reactions)
    VALUES('chat-handle-proof',$1,$2,'@owner',$3::jsonb)`,
    [w.room, x, JSON.stringify({ '👍': [x] })]);
  const phone = new PhoneService(db, 'http://local.test');
  const read = async () => (await phone.readChats(w.id, owner))!.chats[0]!;
  const chat = await read();
  expect(chat.memberCount).toBe(2);
  expect(chat.latestMessage?.author.handle).toBe('x');
  expect(chat.directMessage?.peer.handle).toBe('x');
  expect(chat.latestMessage?.reactions?.[0]?.members[0]?.handle).toBe('x');
  expect(chat.latestMessage?.mentionsViewer).toBe(true);

  await db.query(`DELETE FROM workspace_handles WHERE workspace_id=$1 AND identity_id=$2`, [w.id, x]);
  const fallback = await read();
  expect(fallback.latestMessage?.author.handle).toBe('x_9');
  expect(fallback.directMessage?.peer.handle).toBe('x_9');

  await db.query(`UPDATE identities SET handle='renamed-owner' WHERE id=$1`, [owner]);
  await db.query(`UPDATE messages SET author_id=$1,text='hello',reactions='{}'::jsonb WHERE id='chat-handle-proof'`, [owner]);
  const human = await read();
  expect(human.latestMessage?.author.handle).toBe('renamed-owner');
  expect(human.latestMessage?.reactions).toBeUndefined();
  expect(human.latestMessage?.mentionsViewer).toBeUndefined();
  await db.query(`UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND identity_id=$2 AND room_id IS NULL`, [w.id, owner]);
  expect(await phone.readChats(w.id, owner)).toBeNull();
});

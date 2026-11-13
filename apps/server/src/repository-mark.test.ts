import { afterEach, expect, it } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { repositoryMarkColumnsSql } from './repository-mark.js';
import { PhoneService } from './phone-service.js';
let db: PgliteDatabase;
afterEach(async () => db?.close());
it('projects the stored repo-owner avatar and native-compatible favicon on chats and their threads', async () => {
  db=await migratedDatabase();
  const owner='a'.repeat(64),workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222',thread='33333333-3333-4333-8333-333333333333';
  await db.query("INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')",[owner]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Workspace')",[workspace]);
  await db.query("INSERT INTO github_installations(installation_id,owner_id,account_login,account_type,account_avatar_url) VALUES(77,$1,'owner','User','https://avatars.githubusercontent.com/u/42')",[owner]);
  await db.query("INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES(99,77,'owner/repo','main')");
  await db.query(`INSERT INTO rooms(id,workspace_id,name,repository_key,repository_name,repository_remote,repository_resolution,github_installation_id)
    VALUES($1,$2,'Repo chat','github:99','owner/repo','git://github.com/owner/repo','repository',77)`,[room,workspace]);
  await db.query("INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Thread')",[thread,workspace,room]);
  await db.query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'member')",[workspace,room,owner]);
  const mark={avatar:'https://avatars.githubusercontent.com/u/42',favicon:'https://github.githubassets.com/favicons/favicon.png'};
  const service=new PhoneService(db,'https://beeline.example');
  expect((await service.readRoom(room,owner))?.room).toMatchObject(mark);
  expect((await service.readRoom(thread,owner))?.room).toMatchObject(mark);
  expect((await service.readChats(workspace,owner))?.chats.find(item=>item.room.id===room)?.room).toMatchObject(mark);
  expect((await service.readCorners(room,owner))?.corners.find(item=>item.corner.id===thread)?.corner).toMatchObject(mark);
  await db.query('UPDATE github_installations SET account_avatar_url=NULL');
  const fallback=(await db.query(`SELECT ${repositoryMarkColumnsSql('room')} FROM rooms room WHERE id=$1`,[thread])).rows[0];
  expect(fallback).toEqual({repository_avatar:null,repository_favicon:mark.favicon});
});

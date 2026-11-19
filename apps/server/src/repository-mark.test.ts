import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { repositoryMarkColumnsSql } from './repository-mark.js';
import { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { LiveHub } from './live.js';
import { DaemonService } from './daemon-service.js';
import type { TokenAuth } from './auth.js';
let db: PgliteDatabase;
afterEach(async () => db?.close());
it('projects the repository icon endpoint, an organization avatar and the GitHub favicon on chats and their threads', async () => {
  db=await migratedDatabase();
  const owner='a'.repeat(64),workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222',thread='33333333-3333-4333-8333-333333333333';
  await db.query("INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')",[owner]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Workspace')",[workspace]);
  await db.query("INSERT INTO github_installations(installation_id,owner_id,account_login,account_type,account_avatar_url) VALUES(77,$1,'owner','Organization','https://avatars.githubusercontent.com/u/42')",[owner]);
  await db.query("INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES(99,77,'owner/repo','main')");
  await db.query(`INSERT INTO rooms(id,workspace_id,name,repository_key,repository_name,repository_remote,repository_resolution,github_installation_id)
    VALUES($1,$2,'Repo chat','github:99','owner/repo','git://github.com/owner/repo','repository',77)`,[room,workspace]);
  await db.query("INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Thread')",[thread,workspace,room]);
  await db.query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'member')",[workspace,room,owner]);
  const mark={homepageIcon:`https://beeline.example/v1/repository-icons/${room}`,avatar:'https://avatars.githubusercontent.com/u/42',favicon:'https://github.githubassets.com/favicons/favicon.png'};
  const service=new PhoneService(db,'https://beeline.example');
  const reads=async()=>[(await service.readRoom(room,owner))?.room,(await service.readRoom(thread,owner))?.room,
    (await service.readChats(workspace,owner))?.chats.find(item=>item.room.id===room)?.room,
    (await service.readCorners(room,owner))?.corners.find(item=>item.corner.id===thread)?.corner];
  for (const read of await reads()) expect(read).toMatchObject(mark);
  // A personal account's face never stands in for its repositories.
  await db.query("UPDATE github_installations SET account_type='User'");
  for (const read of await reads()) { expect(read).toMatchObject({homepageIcon:mark.homepageIcon,favicon:mark.favicon}); expect(read?.avatar).toBeUndefined(); }
  // The endpoint reads the parent chat's repository with its installation token.
  const png=await sharp({create:{width:180,height:180,channels:4,background:'#123456'}}).png().toBuffer();
  const readRepository=vi.fn(async (_room:string,_name:string,path:string)=>path.startsWith('git/trees/')
    ?{tree:[{path:'public/apple-touch-icon.png',type:'blob',sha:'abc'}]}:{content:png.toString('base64')});
  const live=new LiveHub();
  const server=createBeelineServer({database:db,phone:service,live,auth:{} as TokenAuth,daemon:new DaemonService(db,live),mediaMaximumBytes:1,github:{readRepository}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const icon=await fetch(`${origin}/v1/repository-icons/${room}?size=108`);
    expect(icon.status).toBe(200);
    expect((await sharp(Buffer.from(await icon.arrayBuffer())).metadata()).width).toBe(108);
    expect(readRepository.mock.calls.map(call=>call.slice(0,3))).toEqual([[room,'owner/repo','git/trees/main?recursive=1'],[room,'owner/repo','git/blobs/abc']]);
    expect((await fetch(`${origin}/v1/repository-icons/${thread}`)).status).toBe(404);
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
  await db.query('DELETE FROM github_repositories');
  const fallback=(await db.query(`SELECT ${repositoryMarkColumnsSql('room')} FROM rooms room WHERE id=$1`,[thread])).rows[0];
  expect(fallback).toEqual({repository_icon_room:null,repository_avatar:null,repository_favicon:mark.favicon});
});

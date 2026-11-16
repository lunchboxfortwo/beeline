import { beforeAll,afterAll,beforeEach } from 'vitest';
import { migratedDatabase,type PgliteDatabase,insertCornerFacts } from './test-support.js';
import { HelperDaemonService } from './test-fixtures/helper-daemon.js';
import { LiveHub } from './live.js';
import { becomeThreadImplementer } from './corner-lifecycle.js';
export const H='a'.repeat(64),A='b'.repeat(64),B='c'.repeat(64),C='d'.repeat(64);
export const W='11111111-1111-4111-8111-111111111111';
export const CHAT='22222222-2222-4222-8222-222222222222';
export const THREAD='33333333-3333-4333-8333-333333333333';
export const OTHER='44444444-4444-4444-8444-444444444444';
export let db:PgliteDatabase,daemon:HelperDaemonService;
beforeAll(async()=>{
  db=await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Ruby','ruby'),($3,'agent','Jellybean','jellybean'),($4,'agent','Sol','sol')`,[H,A,B,C]);
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$4),($2,$4),($3,$4)',[A,B,C,H]);
  daemon=new HelperDaemonService(db,new LiveHub());
},30000);
beforeEach(async()=>{
  await db.query('DELETE FROM agent_commands');
  await db.query('DELETE FROM workspaces');
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Messaging')",[W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by)
    VALUES($1,$4,NULL,'Milo',$5),($2,$4,$1,'Widget',$5),($3,$4,NULL,'Elsewhere',$5)`,[CHAT,THREAD,OTHER,W,H]);
  for (const member of [H,A,B,C]) for (const place of [null,CHAT,OTHER])
    await db.query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')",[W,place,member]);
  await insertCornerFacts(db,{cornerId:THREAD});
  await becomeThreadImplementer(db,THREAD,B);
});
afterAll(async()=>db.close());
export async function queued() {
  return (await db.query<{agent_id:string;room_id:string}>(
    "SELECT agent_id,room_id FROM agent_commands WHERE state='pending' ORDER BY created_at,id")).rows.map(row=>[row.agent_id,row.room_id]);
}

import { afterEach, expect, it } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from '../test-support.js';
import { PhoneService } from '../phone-service.js';
let db: PgliteDatabase;
afterEach(async () => db?.close());
it('returns the full finished-thread count independently of the archived page size', async () => {
  db = await migratedDatabase();
  const viewer='a'.repeat(64),workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222';
  await db.query("INSERT INTO identities(id,kind,name) VALUES($1,'human','Viewer')", [viewer]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Workspace')", [workspace]);
  await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')", [room,workspace]);
  await db.query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'member')", [workspace,room,viewer]);
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,archived_at)
    SELECT gen_random_uuid(),$1,$2,'Finished ' || n,now() FROM generate_series(1,27) n`, [workspace,room]);
  const service = new PhoneService(db,'https://beeline.example');
  const first = await service.readCorners(room,viewer,false,true);
  expect(first?.corners).toHaveLength(10);
  expect(first?.archivedCount).toBe(27);
  expect(first?.nextArchived).toBeTruthy();
  expect(await service.readCorners(room,'b'.repeat(64),false,true)).toBeNull();
});

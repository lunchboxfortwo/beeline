import { expect, it } from 'vitest';
import { migrate } from './database.js';
import { migratedDatabase } from './test-support.js';

it('backfills every retired membership role and rejects it on fresh and upgraded databases', async () => {
  const db = await migratedDatabase();
  const workspace = '11111111-1111-4111-8111-111111111111';
  const room = '22222222-2222-4222-8222-222222222222';
  const person = '1'.repeat(64);
  try {
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Person')`, [person]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [workspace]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [room,workspace]);
    const constraint = async () => (await db.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) definition FROM pg_constraint
       WHERE conrelid='memberships'::regclass AND conname='memberships_role_check'`,
    )).rows[0]!.definition;
    expect(await constraint()).not.toContain('spectator');
    await db.query(`ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
      ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK(role IN ('owner','admin','member','spectator'))`);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role,removed_at)
      VALUES($1,NULL,$3,'spectator',NULL),($1,$2,$3,'spectator',now())`, [workspace,room,person]);
    await migrate(db);
    await migrate(db);
    expect((await db.query(`SELECT role,removed_at IS NOT NULL removed FROM memberships WHERE identity_id=$1 ORDER BY removed_at NULLS FIRST`, [person])).rows)
      .toEqual([{ role:'member',removed:false },{ role:'member',removed:true }]);
    expect(await constraint()).not.toContain('spectator');
    await expect(db.query(`UPDATE memberships SET role='spectator' WHERE identity_id=$1`, [person])).rejects.toThrow('memberships_role_check');
  } finally { await db.close(); }
});

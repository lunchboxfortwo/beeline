import { retireDatedCardWorkflows } from './migrations/dated-card-workflows.js';
import { applySkillRevision } from './institutional-skills.js';
import {
  it, expect, rootFixture, migrateData, WORKSPACE, ROOM, MESSAGE,
} from './test-support-institutional-memory-shadow.test-support.js';

it('archives the dated cards once, retaining versions and leaving recurring and other-workspace skills alone', async () => {
  const db = rootFixture.database;
  const workspace = '18e555f7-e191-452b-9b0f-b825f58ee4ba';
  const room = '90000000-0000-4000-8000-000000000001';
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Owner workspace')", [workspace]);
  await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Cards')", [room, workspace]);
  const save = (workspaceId: string, sourceRoomId: string, slug: string, kind: 'procedure' | 'workflow' = 'workflow') =>
    applySkillRevision(db, { workspaceId, sourceRoomId, slug, kind,
      description: 'Fixture', markdown: '{}', sourceMessageIds: [MESSAGE] });
  await save(workspace, room, 'morning-card-2026-11-06-r2');
  await save(workspace, room, 'insight-card-2026-11-09');
  await save(workspace, room, 'morning-card');
  await save(workspace, room, 'morning-card-2026-12-01');
  await save(WORKSPACE, ROOM, 'insight-card-2026-11-09');
  const before = (await db.query<{ id: string; revision: number }>(
    "SELECT id,revision FROM workspace_skills WHERE workspace_id=$1 AND slug='insight-card-2026-11-09'", [workspace],
  )).rows[0]!;
  await retireDatedCardWorkflows(db);
  await retireDatedCardWorkflows(db);
  const retired = (await db.query(
    'SELECT state,deleted_at,revision,current_version FROM workspace_skills WHERE id=$1', [before.id],
  )).rows[0]!;
  expect(retired).toMatchObject({ state: 'archived', deleted_at: expect.any(Date),
    revision: before.revision + 1, current_version: 1 });
  expect((await db.query('SELECT markdown FROM workspace_skill_versions WHERE skill_id=$1', [before.id])).rows)
    .toEqual([{ markdown: '{}' }]);
  expect((await db.query("SELECT slug FROM workspace_skills WHERE workspace_id=$1 AND state='active' ORDER BY slug", [workspace])).rows)
    .toEqual([{ slug: 'morning-card' }, { slug: 'morning-card-2026-12-01' }]);
  expect((await db.query("SELECT state FROM workspace_skills WHERE workspace_id=$1", [WORKSPACE])).rows)
    .toEqual([{ state: 'active' }]);
  // Repeated boot must not normalize a deliberate soft deletion back to stale.
  await migrateData(db);
  expect((await db.query('SELECT state FROM workspace_skills WHERE id=$1', [before.id])).rows)
    .toEqual([{ state: 'archived' }]);
});

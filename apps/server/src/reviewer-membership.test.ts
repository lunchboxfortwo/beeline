import {
  describe, expect, it, rootFixture, H, A, B, W, R, SHA, open, greenHead, commands,
} from './test-support-corner-lifecycle.test-support.js';
import { removeRoomMembership, removeWorkspaceMemberships, removeIdentityMemberships } from './membership-join.js';
import { migrateData, type SqlDatabase } from './database.js';
import { randomUUID } from 'node:crypto';

const removals = [
  ['Room removal', (db: SqlDatabase, agent: string) => removeRoomMembership(db, [R, agent])],
  ['Workspace removal', (db: SqlDatabase, agent: string) => removeWorkspaceMemberships(db, [W, agent])],
  ['identity retirement', (db: SqlDatabase, agent: string) => removeIdentityMemberships(db, [agent])],
] as const;

async function configureReviewer() {
  const corner = await open('owner/widgets');
  await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: B }, H);
  await rootFixture.db.query('UPDATE corner_facts SET reviewer_agent_id=$2 WHERE corner_id=$1', [corner, B]);
  return corner;
}

async function reviewers(corner: string) {
  return (await rootFixture.db.query(`SELECT room.reviewer_agent_id room_reviewer,
    fact.reviewer_agent_id corner_reviewer FROM rooms room CROSS JOIN corner_facts fact
    WHERE room.id=$1 AND fact.corner_id=$2`, [R, corner])).rows[0];
}

async function anotherRoom(workspace = W, reviewer = B, archived = false) {
  const room = randomUUID(), corner = randomUUID();
  await rootFixture.db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Other') ON CONFLICT DO NOTHING`, [workspace]);
  await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,name,reviewer_agent_id,archived_at)
    VALUES($1,$2,'Other',$3,CASE WHEN $4 THEN now() END)`, [room, workspace, reviewer, archived]);
  await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,$2,$3,'member')`, [workspace, room, reviewer]);
  await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name)
    VALUES($1,$2,$3,'other-corner')`, [corner, workspace, room]);
  await rootFixture.db.query(`INSERT INTO corner_facts(corner_id,reviewer_agent_id) VALUES($1,$2)`, [corner, reviewer]);
  return { room, corner };
}

describe.each(removals)('%s clears departed reviewers atomically', (_name, remove) => {
  it('clears the Room and corner override; a green head needs no review handback', async () => {
    const corner = await configureReviewer();
    await remove(rootFixture.db, B);
    expect(await reviewers(corner)).toEqual({ room_reviewer: null, corner_reviewer: null });
    await greenHead(corner, 7, SHA);
    const notices = (await commands(A, corner)).filter(command => command.reason === 'corner_review_needed');
    expect(notices).toHaveLength(0);
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_commands WHERE room_id=$1 AND agent_id=$2
      AND reason IN ('corner_review_dispatch','subscribed_event')`, [corner, B])).rowCount).toBe(0);
  });

  it('leaves the configured reviewer alone when a different agent leaves', async () => {
    const corner = await configureReviewer();
    await remove(rootFixture.db, A);
    expect(await reviewers(corner)).toEqual({ room_reviewer: B, corner_reviewer: B });
  });

  it('clears only assignments within the departing membership scope', async () => {
    await configureReviewer();
    const sameWorkspace = await anotherRoom();
    const otherWorkspace = await anotherRoom(randomUUID());
    // Exercise the production access adapter as well as physical membership reads.
    await remove(rootFixture.phone.database, B);
    for (const target of [sameWorkspace, otherWorkspace]) {
      const cleared = _name === 'identity retirement' ||
        (_name === 'Workspace removal' && target === sameWorkspace);
      expect((await rootFixture.db.query('SELECT reviewer_agent_id FROM rooms WHERE id=$1', [target.room])).rows[0])
        .toEqual({ reviewer_agent_id: cleared ? null : B });
      expect((await rootFixture.db.query('SELECT reviewer_agent_id FROM corner_facts WHERE corner_id=$1', [target.corner])).rows[0])
        .toEqual({ reviewer_agent_id: cleared ? null : B });
    }
  });

  it('rolls back the membership and both reviewer settings together', async () => {
    const corner = await configureReviewer();
    await expect(rootFixture.db.transaction(async db => {
      await remove(db, B);
      expect((await db.query('SELECT reviewer_agent_id FROM rooms WHERE id=$1', [R])).rows[0])
        .toEqual({ reviewer_agent_id: null });
      throw new Error('abort removal');
    })).rejects.toThrow('abort removal');
    expect(await reviewers(corner)).toEqual({ room_reviewer: B, corner_reviewer: B });
    expect((await rootFixture.db.query(`SELECT 1 FROM memberships
      WHERE room_id=$1 AND identity_id=$2 AND removed_at IS NULL`, [R, B])).rowCount).toBe(1);
  });
});

it('backfills stale reviewers once, preserving active assignments and never substituting a same-handle agent', async () => {
  const corner = await configureReviewer();
  const activeCorner = await open('owner/widgets');
  await rootFixture.db.query('UPDATE corner_facts SET reviewer_agent_id=$2 WHERE corner_id=$1', [activeCorner, A]);
  // Milo: an old BBC identity left; the same handle now belongs to another current member.
  await rootFixture.db.query('UPDATE identities SET handle=$2 WHERE id=$1', [A, 'goosy']);
  await rootFixture.db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [R, B]);
  const active = await anotherRoom();
  const missing = await anotherRoom(W, B, true);
  await rootFixture.db.query('DELETE FROM memberships WHERE room_id=$1', [missing.room]);
  await rootFixture.db.query("DELETE FROM workflow_backfills WHERE name='departed-reviewers-v1'");
  await migrateData(rootFixture.db);
  expect(await reviewers(corner)).toEqual({ room_reviewer: null, corner_reviewer: null });
  expect(await reviewers(activeCorner)).toEqual({ room_reviewer: null, corner_reviewer: A });
  expect((await rootFixture.db.query('SELECT reviewer_agent_id FROM rooms WHERE id=$1', [active.room])).rows[0])
    .toEqual({ reviewer_agent_id: B });
  expect((await rootFixture.db.query('SELECT reviewer_agent_id FROM corner_facts WHERE corner_id=$1', [active.corner])).rows[0])
    .toEqual({ reviewer_agent_id: B });
  expect((await rootFixture.db.query('SELECT reviewer_agent_id FROM rooms WHERE id=$1', [missing.room])).rows[0])
    .toEqual({ reviewer_agent_id: null });
  expect((await rootFixture.db.query('SELECT reviewer_agent_id FROM corner_facts WHERE corner_id=$1', [missing.corner])).rows[0])
    .toEqual({ reviewer_agent_id: null });
  expect((await rootFixture.db.query("SELECT 1 FROM workflow_backfills WHERE name='departed-reviewers-v1'")).rowCount).toBe(1);
  // A later release must not rerun this historical data repair.
  await rootFixture.db.query('UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1', [R, B]);
  await migrateData(rootFixture.db);
  expect((await rootFixture.db.query('SELECT reviewer_agent_id FROM rooms WHERE id=$1', [R])).rows[0])
    .toEqual({ reviewer_agent_id: B });
});

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeInactiveCorners, nextCornerCloseDelay } from './corner-auto-close.js';
import { migratedDatabase, insertCornerFacts, type PgliteDatabase } from './test-support.js';
import { ensureSystemIdentity } from './system-line.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

const human = '1'.repeat(64),
  agent = '2'.repeat(64),
  bot = '3'.repeat(64);
const workspace = randomUUID(),
  parent = randomUUID(),
  dm = randomUUID();
let db: PgliteDatabase;
const cleanup = {
  closePullRequest: vi.fn(async () => ({ status: 'closed' })),
  deleteCornerBranch: vi.fn(async () => {}),
};
async function thread(options: { locked?: boolean; parent?: string; days?: number } = {}) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,name,created_at)
    VALUES($1,$2,$3,'Old thread',now()-$4::int*interval '1 day')`,
    [id, workspace, options.parent ?? parent, options.days ?? 8],
  );
  await insertCornerFacts(db, { cornerId: id, locked: options.locked });
  return id;
}
async function message(
  room: string,
  author: string,
  days: number,
  presentation = 'message',
  event: unknown = null,
) {
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text,presentation,system_event,created_at)
    VALUES($1,$2,$3,'Activity',$4,$5::jsonb,now()-$6::int*interval '1 day')`,
    [randomUUID(), room, author, presentation, event ? JSON.stringify(event) : null, days],
  );
}
async function archived(id: string) {
  return (
    await db.query<{ archived: boolean }>(
      'SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1',
      [id],
    )
  ).rows[0]!.archived;
}

describe('seven days without a human message', () => {
  beforeAll(async () => {
    db = await migratedDatabase();
    await ensureSystemIdentity(db);
    await db.query(
      `INSERT INTO identities(id,kind,name,hidden_from_roster)
      VALUES($1,'human','Person',false),($2,'agent','Worker',false),($3,'human','Bot',true)`,
      [human, agent, bot],
    );
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, human]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Test')`, [workspace]);
    await db.query(
      `INSERT INTO rooms(id,workspace_id,name,direct_participants)
      VALUES($1,$3,'Room',NULL),($2,$3,'DM',$4::jsonb)`,
      [parent, dm, workspace, JSON.stringify([human, agent])],
    );
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner'),($1,$4,$2,'owner'),($1,$3,$5,'member')`,
      [workspace, human, parent, dm, agent],
    );
    await db.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment,registered_at) VALUES('idle-close-test',$1,'android','physical',now()-interval '1 day')`,
      [human],
    );
    await db.query(
      `INSERT INTO push_delivery_floors(id,started_at) VALUES('message-delivery',now()-interval '1 day') ON CONFLICT(id) DO UPDATE SET started_at=EXCLUDED.started_at`,
    );
  });
  afterAll(async () => {
    await db.close();
  });

  it('skips only locked threads: a merge hold is released by normal close', async () => {
    const locked = await thread({ locked: true }),
      held = await thread();
    await db.query(
      `INSERT INTO corner_merge_holds(id,corner_id,actor_id,standing) VALUES($1,$2,$3,'owner')`,
      [randomUUID(), held, human],
    );
    expect(await closeInactiveCorners(db, cleanup)).toBe(1);
    expect(await archived(locked)).toBe(false);
    expect(await archived(held)).toBe(true);
    expect(
      (
        await db.query(
          'SELECT released_at IS NOT NULL released FROM corner_merge_holds WHERE corner_id=$1',
          [held],
        )
      ).rows,
    ).toEqual([{ released: true }]);
    await db.query('UPDATE corner_facts SET locked=false WHERE corner_id=$1', [locked]);
    expect(await closeInactiveCorners(db, cleanup)).toBe(1);
  });

  it('ignores fresh agent, System, bot, card and structured system messages and fresh push facts', async () => {
    const id = await thread();
    for (const author of [agent, SYSTEM_IDENTITY_ID, bot]) await message(id, author, 0);
    await message(id, human, 0, 'system');
    await message(id, human, 0, 'card');
    await message(id, human, 0, 'message', {
      subject: { kind: 'system', name: 'System' },
      verb: 'ran',
    });
    await db.query(
      `UPDATE corner_github_cache SET lifecycle='{"lifecycle":"working","checks":"pending","pr":{"number":12,"headSha":"new"}}' WHERE corner_id=$1`,
      [id],
    );
    expect(await closeInactiveCorners(db, cleanup)).toBe(1);
    expect(await archived(id)).toBe(true);
  });

  it('a day-six human message moves the deadline seven days after that message', async () => {
    const id = await thread({ days: 7 });
    await message(id, human, 1);
    expect(await closeInactiveCorners(db, cleanup)).toBe(0);
    expect(await nextCornerCloseDelay(db)).toBeGreaterThan(5 * 86_400_000);
    await db.query(`UPDATE messages SET created_at=now()-interval '7 days' WHERE room_id=$1`, [id]);
    expect(await closeInactiveCorners(db, cleanup)).toBe(1);
    expect(await archived(id)).toBe(true);
  });

  it('closes needs-you threads and open PRs at the same deadline, cancelling pending work', async () => {
    const id = await thread();
    await db.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
      VALUES('idle-needs-you',$1,$2,'Please decide','card','choice','{"status":"open"}')`,
      [id, SYSTEM_IDENTITY_ID],
    );
    await db.query(
      `INSERT INTO needs_you_marks(identity_id,message_id,workspace_id,first_seen_at)
      VALUES($1,'idle-needs-you',$2,NULL)`,
      [human, workspace],
    );
    await db.query(
      `UPDATE corner_github_cache SET lifecycle='{"lifecycle":"working","checks":"pending","pr":{"number":15}}' WHERE corner_id=$1`,
      [id],
    );
    await db.query(
      `INSERT INTO agent_commands(id,room_id,agent_id,reason,state,action,turn_request_id,root_command_id,root_source_message_id,agent_depth) VALUES('idle-pending',$1,$2,'human_tag','pending','input','idle-request','idle-pending','idle-needs-you',0)`,
      [id, agent],
    );
    await db.query(
      `INSERT INTO agent_turns(room_id,request_id,agent_id,status)
      VALUES($1,'idle-request',$2,'working')`,
      [id, agent],
    );
    expect(await closeInactiveCorners(db, cleanup)).toBe(1);
    expect(await archived(id)).toBe(true);
    expect(
      (await db.query(`SELECT status FROM agent_turns WHERE request_id='idle-request'`)).rows,
    ).toEqual([{ status: 'cancelled' }]);
    expect(
      (await db.query(`SELECT state FROM agent_commands WHERE id='idle-pending'`)).rows,
    ).toEqual([{ state: 'cancelled' }]);
    expect(cleanup.closePullRequest).toHaveBeenCalledWith(id);
  });

  it.each([parent, dm])(
    'commits exactly one quiet parent System line across repeated/restarted sweeps (%s)',
    async (parentId) => {
      const id = await thread({ parent: parentId });
      const before = (await db.query('SELECT id FROM agent_commands')).rowCount;
      expect(await closeInactiveCorners(db, cleanup)).toBe(1);
      expect(await closeInactiveCorners(db, cleanup)).toBe(0);
      const line = (
        await db.query(
          `SELECT room_id,author_id,presentation,text,system_event FROM messages WHERE id=$1`,
          [createHash('sha256').update(`thread-idle-close:${id}`).digest('hex')],
        )
      ).rows;
      expect(line).toEqual([
        expect.objectContaining({
          room_id: parentId,
          author_id: SYSTEM_IDENTITY_ID,
          presentation: 'system',
          text: 'Old thread closed after 7 days without a human message',
          system_event: expect.not.objectContaining({ kind: expect.anything() }),
        }),
      ]);
      expect(
        (
          await db.query('SELECT message_id FROM push_outbox WHERE message_id=$1', [
            createHash('sha256').update(`thread-idle-close:${id}`).digest('hex'),
          ])
        ).rowCount,
      ).toBe(0);
      expect((await db.query('SELECT id FROM agent_commands')).rowCount).toBe(before);
    },
  );

  it('uses creation when there are no human messages and excludes parent chats and young threads', async () => {
    const id = await thread({ days: 6 });
    expect(await closeInactiveCorners(db, cleanup)).toBe(0);
    expect(await archived(id)).toBe(false);
    expect(await archived(parent)).toBe(false);
    await db.query(`UPDATE rooms SET created_at=now()-interval '7 days' WHERE id=$1`, [id]);
    expect(await closeInactiveCorners(db, cleanup)).toBe(1);
    expect(await nextCornerCloseDelay(db)).toBeUndefined();
  });
  it('re-arms the existing deadline clock for creation, people and locks, never agent or bot chatter', async () => {
    await db.query(`CREATE TEMP TABLE idle_clock_hints(payload text);
      CREATE OR REPLACE FUNCTION beeline_notify_committed_command(payload text) RETURNS void
      LANGUAGE sql AS $$ INSERT INTO idle_clock_hints VALUES(payload) $$;`);
    const hints = async () =>
      (
        await db.query(`SELECT 1 FROM idle_clock_hints
      WHERE payload::jsonb->>'principal'='schedule'`)
      ).rowCount;
    const id = await thread({ days: 6 });
    expect(await hints()).toBeGreaterThan(0);
    await db.query('TRUNCATE idle_clock_hints');
    for (const author of [agent, SYSTEM_IDENTITY_ID, bot]) await message(id, author, 0);
    await message(id, human, 0, 'system');
    expect(await hints()).toBe(0);
    await message(id, human, 0);
    expect(await hints()).toBe(1);
    await db.query('TRUNCATE idle_clock_hints');
    await db.query('UPDATE corner_facts SET locked=true WHERE corner_id=$1', [id]);
    expect(await hints()).toBe(1);
    await db.query('UPDATE corner_facts SET locked=false WHERE corner_id=$1', [id]);
    expect(await hints()).toBe(2);
    await db.query(`UPDATE corner_facts SET machine='{"state":"working"}' WHERE corner_id=$1`, [
      id,
    ]);
    expect(await hints()).toBe(2);
  });
});

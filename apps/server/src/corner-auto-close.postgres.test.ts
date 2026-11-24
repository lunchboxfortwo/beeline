import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate, PostgresDatabase } from './database.js';
import { closeInactiveCorners } from './corner-auto-close.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Idle close concurrency proof requires isolated loopback PostgreSQL');

describe.skipIf(!url)('idle close across server machines', () => {
  const name = `idle_close_${randomUUID().replaceAll('-', '')}`;
  const isolated = new URL(url ?? 'postgresql://localhost/postgres');
  isolated.pathname = `/${name}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  const config = {
    connectionString: isolated.toString(),
    options: '-c statement_timeout=8000',
    max: 1,
  };
  const first = new PostgresDatabase('', 1, { pool: new Pool(config) });
  const second = new PostgresDatabase('', 1, { pool: new Pool(config) });
  const human = 'a'.repeat(64),
    workspace = randomUUID(),
    parent = randomUUID();
  const cleanup = {
    closePullRequest: vi.fn(async () => ({ status: 'closed' })),
    deleteCornerBranch: vi.fn(async () => {}),
  };
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${name}`);
    await migrate(first);
    await first.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Person')`, [human]);
    await first.query(`INSERT INTO workspaces(id,name) VALUES($1,'Idle close concurrency')`, [
      workspace,
    ]);
    await first.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Parent')`, [
      parent,
      workspace,
    ]);
  }, 60_000);
  afterAll(async () => {
    await Promise.all([first.close(), second.close()]);
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  });
  async function thread() {
    const id = randomUUID();
    await first.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name,created_at)
      VALUES($1,$2,$3,'Quiet thread',now()-interval '8 days')`,
      [id, workspace, parent],
    );
    await first.query('INSERT INTO corner_facts(corner_id) VALUES($1)', [id]);
    return id;
  }
  it('competing replicas commit one archive, one notice and one provider cleanup', async () => {
    const id = await thread();
    const results = await Promise.all([
      closeInactiveCorners(first, cleanup),
      closeInactiveCorners(second, cleanup),
    ]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(
      (await first.query('SELECT id FROM messages WHERE id=$1', [createHash('sha256').update(`thread-idle-close:${id}`).digest('hex')]))
        .rowCount,
    ).toBe(1);
    expect(cleanup.deleteCornerBranch).toHaveBeenCalledTimes(1);
    expect(await closeInactiveCorners(second, cleanup)).toBe(0);
  });
  it('defers to a human message holding the admission lock, then respects its committed deadline', async () => {
    const id = await thread();
    let admitted!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const posting = first.transaction(async (db) => {
      await db.query('SELECT id FROM rooms WHERE id=$1 FOR SHARE', [id]);
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Still working')`,
        [randomUUID(), id, human],
      );
      admitted();
      await gate;
    });
    await ready;
    try {
      expect(await closeInactiveCorners(second, cleanup)).toBe(0);
    } finally {
      release();
      await posting;
    }
    expect(await closeInactiveCorners(second, cleanup)).toBe(0);
    expect((await first.query('SELECT archived_at FROM rooms WHERE id=$1', [id])).rows).toEqual([
      { archived_at: null },
    ]);
    await first.query(`UPDATE rooms SET created_at=now() WHERE id=$1`, [id]);
  });
  it('rechecks a lock committed after the sweep selected its candidates', async () => {
    const id = await thread();
    let locked!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locking = first.transaction(async (db) => {
      await db.query('UPDATE corner_facts SET locked=true WHERE corner_id=$1', [id]);
      locked();
      await gate;
    });
    await ready;
    const sweeping = closeInactiveCorners(second, cleanup);
    // Keep the lock uncommitted until the competing sweep has selected this
    // candidate and reached its lifecycle lock, making the stale read certain.
    let waiting = false;
    try {
      for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
        waiting = (
          await admin.query<{ waiting: boolean }>(
            `SELECT EXISTS(
          SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'
            AND query LIKE 'SELECT corner_id FROM corner_facts%') waiting`,
            [name],
          )
        ).rows[0]!.waiting;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waiting).toBe(true);
    } finally {
      release();
    }

    await locking;
    expect(await sweeping).toBe(0);
    expect((await first.query('SELECT archived_at FROM rooms WHERE id=$1', [id])).rows).toEqual([
      { archived_at: null },
    ]);
  });
  it('rolls back archival when the quiet notice cannot commit and retries exactly once', async () => {
    const id = await thread();
    await first.query(`CREATE FUNCTION reject_idle_notice() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.card_type='thread-idle-close' THEN RAISE EXCEPTION 'notice unavailable'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_idle_notice BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION reject_idle_notice();`);
    try {
      await expect(closeInactiveCorners(first, cleanup)).rejects.toThrow('notice unavailable');
      expect((await first.query('SELECT archived_at FROM rooms WHERE id=$1', [id])).rows).toEqual([
        { archived_at: null },
      ]);
      expect(
        (await first.query('SELECT id FROM messages WHERE id=$1', [createHash('sha256').update(`thread-idle-close:${id}`).digest('hex')]))
          .rowCount,
      ).toBe(0);
    } finally {
      await first.query(
        'DROP TRIGGER reject_idle_notice ON messages; DROP FUNCTION reject_idle_notice()',
      );
    }
    expect(await closeInactiveCorners(second, cleanup)).toBe(1);
    expect(await closeInactiveCorners(first, cleanup)).toBe(0);
  });
});

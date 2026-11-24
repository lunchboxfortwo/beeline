import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { AgentScheduleLoop } from './agent-schedules.js';
import { migrate, PostgresDatabase } from './database.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
  throw new Error('Schedule claim proof requires isolated loopback PostgreSQL');
}

describe.skipIf(!url)('competing schedule claims', () => {
  const test = it.extend<{ schedules: { db: PostgresDatabase; holder: Pool; locked: string; available: string } }>({
    schedules: async ({}, use) => {
      const name = `schedule_claim_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString: url, max: 1 });
      const isolated = new URL(url!);
      isolated.pathname = `/${name}`;
      const config = { connectionString: isolated.toString(), options: '-c jit=off -c lock_timeout=100ms -c statement_timeout=8000', max: 1 };
      const holder = new Pool(config);
      const db = new PostgresDatabase('', 1, { pool: new Pool(config) });

      const workspace = randomUUID(), room = randomUUID();
      const human = 'a'.repeat(64), agent = 'b'.repeat(64);
      const locked = '00000000-0000-4000-8000-000000000001';
      const available = '00000000-0000-4000-8000-000000000002';
      try {
        await admin.query(`CREATE DATABASE ${name}`);
        await migrate(db);
        await db.query("INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Worker')", [human, agent]);
        await db.query('INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,\'claim-proof\')', [agent, human]);
        await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Claim proof')", [workspace]);
        await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Schedules')", [room, workspace]);
        await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
          ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`, [workspace, human, agent, room]);
        await db.query(`INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
          SELECT id,$3,$4,$5,$6,'{"kind":"interval","everyMinutes":5}','Check saved task',now()-interval '1 second'
          FROM unnest(ARRAY[$1::uuid,$2::uuid]) id`, [locked, available, workspace, room, agent, human]);
        await use({ db, holder, locked, available });
      } finally {
        await holder.query('ROLLBACK').catch(() => {});
        await holder.end();
        await db.close();
        await admin.query(`DROP DATABASE IF EXISTS ${name}`);
        await admin.end();
      }
    },
  });

  test('skips another Machine’s locked occurrence without parking it and serves unlocked work', async ({ schedules }) => {
    const { db, holder, locked, available } = schedules;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM agent_schedules WHERE id=$1 FOR UPDATE', [locked]);
      const loop = new AgentScheduleLoop(db);
      await expect(loop.runOnce()).resolves.toBe(1);
      expect(error).not.toHaveBeenCalled();
      expect((await db.query('SELECT schedule_id FROM agent_schedule_occurrences')).rows).toEqual([{ schedule_id: available }]);
      expect((await db.query('SELECT failed_due_at,failed_revision,run_count FROM agent_schedules WHERE id=$1', [locked])).rows)
        .toEqual([{ failed_due_at: null, failed_revision: null, run_count: 0 }]);
      await holder.query('ROLLBACK');
      await expect(loop.runOnce()).resolves.toBe(1);
      expect((await db.query('SELECT schedule_id FROM agent_schedule_occurrences ORDER BY schedule_id')).rows)
        .toEqual([{ schedule_id: locked }, { schedule_id: available }]);
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  }, 60_000);

  test('dispatches both simultaneous self-created schedules while one delivery is in progress', async ({ schedules }) => {
    const { db, holder, locked } = schedules;
    await db.query('UPDATE agent_schedules SET creator_id=agent_id,message=id::text');
    // Hold the first delivery open after it has chosen its scheduler author.
    await db.query(`CREATE FUNCTION delay_first_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.text LIKE '%${locked}%' THEN
          SET LOCAL lock_timeout='8s';
          PERFORM pg_advisory_xact_lock(17);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER delay_delivery BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION delay_first_delivery()`);
    const peer = new PostgresDatabase('', 1, { pool: holder });
    await holder.query('SELECT pg_advisory_lock(17)');
    const first = new AgentScheduleLoop(db).runOnce();
    try {
      await vi.waitFor(async () => {
        const waiting = await holder.query(`SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event='advisory'`);
        expect(waiting.rowCount).toBe(1);
      }, { timeout: 5000 });
      const second = await new AgentScheduleLoop(peer).runOnce();
      expect(second).toBe(1);
    } finally {
      await holder.query('SELECT pg_advisory_unlock(17)');
      await first;
    }
    expect(await first).toBe(1);
    expect((await db.query("SELECT 1 FROM agent_commands WHERE reason='schedule'")).rowCount).toBe(2);
    expect((await db.query('SELECT DISTINCT scheduled_for FROM agent_schedule_occurrences')).rowCount).toBe(1);
  }, 60_000);
});

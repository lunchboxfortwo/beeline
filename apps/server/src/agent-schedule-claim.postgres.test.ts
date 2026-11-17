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
  it('skips another Machine’s locked occurrence without parking it and serves unlocked work', async () => {
    const name = `schedule_claim_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: url, max: 1 });
    const isolated = new URL(url!);
    isolated.pathname = `/${name}`;
    const config = { connectionString: isolated.toString(), options: '-c jit=off -c lock_timeout=100ms -c statement_timeout=8000', max: 1 };
    const holder = new Pool(config);
    const db = new PostgresDatabase('', 1, { pool: new Pool(config) });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
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
      await holder.query('ROLLBACK').catch(() => {});
      await holder.end();
      await db.close();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
      error.mockRestore();
    }
  }, 60_000);
});

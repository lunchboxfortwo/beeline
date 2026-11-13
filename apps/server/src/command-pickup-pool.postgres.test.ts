import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { migrate, PostgresDatabase, type SqlDatabase } from './database.js';
import { lockAgentCommandQueue } from './agent-command-queue.js';
import { readAgentCommands } from './agent-command-read-agent-commands.js';
import { currentIdleReportSql } from './corner-idle.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Command-pickup proofs require isolated loopback PostgreSQL');

const corner = '22222222-2222-4222-8222-000000000001';
const human = '1'.repeat(64);
const agent = '2'.repeat(64);
// A jobs pool of 2 and a 2s connection timeout. Production's worst minute had 15
// overlapping attempts against multi-second pickups. On this copy the unfixed
// pickup is shorter, so 24 overlapping attempts is what crosses that timeout.
const BURST = 24;

function pool(max: number, statementTimeout: number, lockTimeout?: number): Pool {
  return new Pool({
    connectionString: url,
    max,
    connectionTimeoutMillis: 2000,
    statement_timeout: statementTimeout,
    options: `-c jit=off${lockTimeout ? ` -c lock_timeout=${lockTimeout}ms` : ''} -c statement_timeout=${statementTimeout}ms -c search_path=${schema},public`,
  });
}

let schema = '';

async function burst(database: SqlDatabase): Promise<string[]> {
  return (await Promise.all(Array.from({ length: BURST }, async () => {
    try {
      await database.transaction(async (db) => {
        await lockAgentCommandQueue(db, corner, agent);
        await readAgentCommands(db, corner, agent);
      });
      return '';
    } catch (error) {
      return error instanceof Error ? error.message.split('\n')[0] : String(error);
    }
  }))).filter(Boolean);
}

describe.skipIf(!url)('command pickup and membership reads at the production burst', () => {
  it('does not time out waiting for a jobs or app connection, and plans the idle check once', async () => {
    schema = `pickup_pool_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const migratePool = new Pool({
      connectionString: url, max: 1,
      options: `-c jit=off -c search_path=${schema},public`,
    });
    const database = new PostgresDatabase('', 1, { pool: migratePool, mode: 'migration' });
    const jobs = new PostgresDatabase('', 2, { pool: pool(2, 2000, 500), mode: 'long-running' });
    const app = new PostgresDatabase('', 25, { pool: pool(25, 5000), mode: 'app' });
    try {
      await migrate(database);
      await migratePool.query(await readFile(new URL('../proofs/slow-query-fixture.sql', import.meta.url), 'utf8'));
      await migratePool.query(`
        INSERT INTO messages(id,room_id,author_id,text,created_at,presentation)
        SELECT md5('pickup-src-'||n)||md5('pickup-src-b-'||n), $1, $2, 'please look', now(), 'message'
        FROM generate_series(1,8) n`, [corner, human]);
      await migratePool.query(`
        INSERT INTO agent_commands(
          id,room_id,agent_id,turn_request_id,action,reason,root_command_id,root_source_message_id,agent_depth,state,source_message_id)
        SELECT 'pickup-'||n, $1, $2, 'pickup-turn-'||n, 'input', 'human_tag', 'pickup-'||n, 'pickup-'||n, 0, 'pending',
          md5('pickup-src-'||n)||md5('pickup-src-b-'||n)
        FROM generate_series(1,8) n`, [corner, agent]);
      const offered = await jobs.transaction(async (db) => {
        await lockAgentCommandQueue(db, corner, agent);
        return readAgentCommands(db, corner, agent);
      });
      expect(offered.commands.filter(command => command.reason === 'human_tag').length).toBe(8);

      expect(await burst(jobs)).toEqual([]);
      expect(await burst(app)).toEqual([]);

      expect(currentIdleReportSql('command')).toBe('beeline_current_idle_report(command.private_payload)');
      const defined = (await migratePool.query<{ def: string }>(
        `SELECT pg_get_functiondef('beeline_current_idle_report'::regproc) def`)).rows[0]!.def;
      const predicate = defined.slice(defined.indexOf('SELECT EXISTS'), defined.indexOf('FROM (SELECT payload'));
      const before = (await migratePool.query({
        text: `EXPLAIN (ANALYZE, FORMAT JSON) ${predicate} FROM (SELECT $1::jsonb AS private_payload) command`,
        values: [JSON.stringify({ originCornerId: corner, idleSince: '1' })],
      })).rows[0]['QUERY PLAN'][0]['Planning Time'] as number;
      const after = (await migratePool.query({
        text: 'EXPLAIN (ANALYZE, FORMAT JSON) SELECT beeline_current_idle_report($1::jsonb)',
        values: [JSON.stringify({ originCornerId: corner, idleSince: '1' })],
      })).rows[0]['QUERY PLAN'][0]['Planning Time'] as number;
      expect(before).toBeGreaterThan(40);
      expect(after).toBeLessThan(before / 2);
    } finally {
      await Promise.all([jobs.close(), app.close(), database.close()]);
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  }, 180_000);
});

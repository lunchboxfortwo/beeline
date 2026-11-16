import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GitHubAppClient } from '@beeline/auth/github';
import { advanceCorner, createCornerFacts, type CornerEvent } from './corner-lifecycle.js';
import { migrate, PostgresDatabase, type SqlDatabase } from './database.js';
import { GitHubOperations } from './github-operations.js';
import { systemLine } from './system-line.js';
import { assignCornerWorker } from './test-fixtures/corner-commands.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Corner contention proofs require isolated loopback PostgreSQL');
const owner = 'c'.repeat(64), agent = 'd'.repeat(64);
const workspace = '55555555-5555-4555-8555-555555555555';
const room = '66666666-6666-4666-8666-666666666666';
const head = '7'.repeat(40);
// Production app connections time out a row lock wait after 500 ms.
const PRODUCTION_LOCK_TIMEOUT_MS = 500;
// Production logs show the corner idle snapshot taking 0.6-1.3 s on a busy corner.
const SLOW_SNAPSHOT_SECONDS = 0.7;
const IDLE_SNAPSHOT = 'WITH live_corner AS MATERIALIZED';

/**
 * The real database, with the corner idle snapshot as slow as in production.
 * `onSnapshot` runs before each snapshot so a test can interleave another event.
 */
function slowSnapshots(database: SqlDatabase, onSnapshot?: () => Promise<void>): SqlDatabase {
  const wrap = (db: SqlDatabase): SqlDatabase => ({
    ...db,
    query: (async (sql: string, values?: unknown[], name?: string) => {
      if (sql.includes(IDLE_SNAPSHOT)) {
        await onSnapshot?.();
        await db.query('SELECT pg_sleep($1)', [SLOW_SNAPSHOT_SECONDS]);
      }
      return db.query(sql, values, name);
    }) as SqlDatabase['query'],
    transaction: work => db.transaction(inner => work(wrap(inner))),
  });
  return wrap(database);
}

describe.skipIf(!url)('corner advance under one busy corner', () => {
  const databaseName = `corner_contention_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  const isolatedUrl = new URL(url ?? 'postgresql://localhost/postgres');
  isolatedUrl.pathname = `/${databaseName}`;
  const options = `-c lock_timeout=${PRODUCTION_LOCK_TIMEOUT_MS} -c statement_timeout=8000`;
  const database = new PostgresDatabase('', 8, {
    pool: new Pool({ connectionString: isolatedUrl.toString(), options, max: 8 }),
  });

  async function seedBusyCorner(): Promise<{ cornerId: string; checkMessageId: string }> {
    const cornerId = randomUUID();
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Busy corner')`,
      [cornerId, workspace, room, agent],
    );
    await createCornerFacts(database, cornerId);
    await assignCornerWorker(database, cornerId, agent);
    await database.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [cornerId, JSON.stringify({
      lifecycle: 'in-review', checks: 'passing',
      pr: { number: 9, headSha: head, url: 'https://github.com/owner/widgets/pull/9' },
    })]);
    const check = await systemLine(database, {
      roomId: cornerId, authorId: agent, subject: { kind: 'github', name: 'GitHub' },
      verb: 'passed a check', kind: 'check-passed', object: { text: 'Tests', headSha: head },
    });
    return { cornerId, checkMessageId: check.id };
  }

  const burst = (checkMessageId: string): CornerEvent[] => [
    { kind: 'push', headSha: head, contents: {} },
    { kind: 'checks', result: 'passing', sourceMessageId: checkMessageId },
    { kind: 'checks', result: 'passing', sourceMessageId: checkMessageId },
    { kind: 'push', headSha: head, contents: {} },
    { kind: 'checks', result: 'passing', sourceMessageId: checkMessageId },
    { kind: 'reconcile' },
  ];

  const machine = async (cornerId: string) =>
    (await database.query<{ machine: unknown }>('SELECT machine FROM corner_facts WHERE corner_id=$1', [cornerId])).rows[0]?.machine;

  const commands = async (cornerId: string) =>
    (await database.query<{ reason: string; agent_id: string; state: string }>(
      `SELECT reason,agent_id,state FROM agent_commands WHERE room_id=$1 AND reason<>'human_tag'
       ORDER BY reason,agent_id,state`, [cornerId],
    )).rows;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${databaseName}`);
    await migrate(database);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Helper')`, [owner, agent]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Contention proof')`, [workspace]);
    await database.query(`INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,'machine')`, [agent, owner]);
    await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`, [room, workspace, owner]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`, [workspace, owner, agent, room]);
  }, 60_000);

  afterAll(async () => {
    await database.close();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  });

  it('Reproduction corner-lock-burst: concurrent check and push events on one corner all commit, matching the serial result', async () => {
    const serial = await seedBusyCorner();
    for (const event of burst(serial.checkMessageId)) await advanceCorner(database, serial.cornerId, event);
    const busy = await seedBusyCorner();
    const slow = slowSnapshots(database);
    // A reconcile skips a corner another event holds; the other events must all commit.
    const results = await Promise.allSettled(burst(busy.checkMessageId).map(event => advanceCorner(slow, busy.cornerId, event)));
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason as { code?: string; message?: string }] : []);
    expect(failures.map(failure => failure.code ?? failure.message)).toEqual([]);
    expect(await machine(busy.cornerId)).toEqual(await machine(serial.cornerId));
    expect(await commands(busy.cornerId)).toEqual(await commands(serial.cornerId));
  }, 60_000);

  it('a second event that commits between the unlocked read and the locked write makes the write use the newer facts', async () => {
    const { cornerId } = await seedBusyCorner();
    // A reviewer PASS lands while a push event is still reading the corner.
    const second: CornerEvent = { kind: 'approval', headSha: head, by: 'reviewer' };
    const first: CornerEvent = { kind: 'push', headSha: head, contents: {} };
    let snapshots = 0;
    let secondResult: Awaited<ReturnType<typeof advanceCorner>> | undefined;
    const interleaved = slowSnapshots(database, async () => {
      // The first event has read the corner row; the second commits before the first locks.
      if (++snapshots === 1) secondResult = await advanceCorner(database, cornerId, second);
    });
    const firstResult = await advanceCorner(interleaved, cornerId, first);
    expect(secondResult?.accepted).toBe(true);
    expect(firstResult.accepted).toBe(true);

    const reference = await seedBusyCorner();
    await advanceCorner(database, reference.cornerId, second);
    await advanceCorner(database, reference.cornerId, first);
    // A write from the stale read would drop the recorded yes.
    expect(await machine(cornerId)).toMatchObject({ effects: expect.arrayContaining(['approved-on-green']) });
    expect(await machine(cornerId)).toEqual(await machine(reference.cornerId));
    expect(await commands(cornerId)).toEqual(await commands(reference.cornerId));
    // The first event read the corner again after the second event's commit.
    expect(snapshots).toBe(2);
  }, 60_000);

  it('Reproduction corner-lock-burst: check and push entry paths finish six concurrent events, matching the serial result', async () => {
    await database.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
      VALUES(77,$1,'42','owner','User','selected','active') ON CONFLICT DO NOTHING`, [owner]);
    await database.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
      VALUES(101,77,'owner/widgets','main') ON CONFLICT DO NOTHING`);
    await database.query(`UPDATE rooms SET repository_key='owner/widgets', github_installation_id=77 WHERE id=$1`, [room]);
    const nextHead = '8'.repeat(40);
    const app = {
      installationToken: async () => ({ token: 'fixture' }),
      readPullRequest: async () => ({
        number: 9, state: 'open', merged: false, headSha: nextHead, headRef: 'feature/busy', baseRef: 'main',
        title: 'Busy', url: 'https://github.com/owner/widgets/pull/9', mergeability: 'unknown' as const,
      }),
    } as unknown as GitHubAppClient;
    const entered = async (cornerId: string, slow: SqlDatabase) => {
      const ops = new GitHubOperations(slow, {} as never, app, 'secret');
      const target = {
        corner_id: cornerId, parent_id: room, author_id: agent, corner_name: 'Busy corner', summary: '',
        repository_id: '101', installation_id: '77', has_pr: true, pr_number: '9',
      };
      const check = { name: 'Tests', status: 'passed' as const, headSha: head, conclusion: 'success' };
      const snapshot = {
        token: 'fixture', fetchStartedAt: 1_700_000_000,
        pr: { number: 9, headSha: head, state: 'open' as const, merged: false, headRef: 'feature/busy', baseRef: 'main', title: 'Busy', url: 'https://github.com/owner/widgets/pull/9', mergeability: 'unknown' as const },
        rollup: { state: 'passed' as const, total: 1, failing: [], checks: [{ name: 'Tests', status: 'passed' as const }] },
      };
      await ops.refreshCheckRollup(target, 'owner/widgets', check, slow, { snapshot });
    };
    const pushed = async (cornerId: string, slow: SqlDatabase) => {
      const ops = new GitHubOperations(slow, {} as never, app, 'secret');
      await ops.refreshCornerReviewHead(cornerId);
    };
    const serialChecks = await seedBusyCorner();
    for (let i = 0; i < 3; i++) await entered(serialChecks.cornerId, database);
    const serialPush = await seedBusyCorner();
    for (let i = 0; i < 3; i++) await pushed(serialPush.cornerId, database);
    const busyChecks = await seedBusyCorner();
    const busyPush = await seedBusyCorner();
    const slow = slowSnapshots(database);
    const results = await Promise.allSettled([
      entered(busyChecks.cornerId, slow), entered(busyChecks.cornerId, slow), entered(busyChecks.cornerId, slow),
      pushed(busyPush.cornerId, slow), pushed(busyPush.cornerId, slow), pushed(busyPush.cornerId, slow),
    ]);
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason as { code?: string; message?: string }] : []);
    expect(failures.map(failure => failure.code ?? failure.message)).toEqual([]);
    expect(await machine(busyChecks.cornerId)).toEqual(await machine(serialChecks.cornerId));
    expect(await commands(busyChecks.cornerId)).toEqual(await commands(serialChecks.cornerId));
    expect(await machine(busyPush.cornerId)).toEqual(await machine(serialPush.cornerId));
    expect(await commands(busyPush.cornerId)).toEqual(await commands(serialPush.cornerId));
  }, 60_000);
});

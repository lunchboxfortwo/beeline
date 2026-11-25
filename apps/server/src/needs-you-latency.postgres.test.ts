import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { migrate, PostgresDatabase, type SqlDatabase } from './database.js';
import { readWorkBoard } from './work-board.js';
import { countNeedsYouItems, needsYouItems, readNeedsYouOrder } from './needs-you.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
  throw new Error('Needs you latency proof requires isolated loopback PostgreSQL');
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const viewer = 'a'.repeat(64), agent = 'b'.repeat(64);
const reports = 257;

type PlanNode = {
  'Index Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
};
function nodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodes)];
}

describe.skipIf(!url)('Needs you report query workload', () => {
  it('reads report bodies once even when statistics underestimate reports, for both rows and badge', async () => {
    const name = `needs_you_latency_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8'`);
    const target = new URL(url!);
    target.pathname = `/${name}`;
    const database = new PostgresDatabase('', 1, {
      pool: new Pool({ connectionString: target.toString(), max: 1, options: '-c jit=off' }),
      mode: 'migration',
    });
    try {
      await migrate(database);
      await database.query(`INSERT INTO identities(id,kind,name,handle)
        VALUES($1,'human','Reader','reader'),($2,'agent','Helper','helper')`, [viewer, agent]);
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Tasks workload')`, [workspace]);
      await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Tasks')`, [room, workspace]);
      await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`, [workspace, viewer, room]);
      await database.query(`INSERT INTO messages(id,room_id,author_id,text)
        SELECT 'history-'||n,$1,$2,'Ordinary history '||n FROM generate_series(1,10000) n`, [room, agent]);
      // Production estimated one report while its partial index contained 257.
      // Analyze before the reports arrive to reproduce that skew without forcing a join strategy.
      await database.query('ANALYZE');
      await database.query(`INSERT INTO messages(id,room_id,author_id,text,card)
        SELECT 'report-'||n,$1,$2,'blocked: Choose an approach '||n,
          jsonb_build_object('reportStatus','blocked','reportToId',$3::text)
        FROM generate_series(1,$4::int) n`, [room, agent, viewer, reports]);
      await database.query(`INSERT INTO needs_you_marks(identity_id,message_id,workspace_id,cleared_at)
        SELECT $1,'report-'||n,$2,now() FROM generate_series(1,$3::int) n
        ON CONFLICT(identity_id,message_id) DO UPDATE SET cleared_at=EXCLUDED.cleared_at`, [viewer, workspace, reports - 4]);

      const statements: { sql: string; values?: unknown[] }[] = [];
      const capture: SqlDatabase = {
        query: (sql, values) => {
          statements.push({ sql, values });
          return database.query(sql, values);
        },
        transaction: work => work(capture),
      };
      const expected = ['report-254', 'report-255', 'report-256', 'report-257'];
      const read = await needsYouItems(capture, workspace, viewer,
        row => ({ pubkey: row.id, kind: row.kind, name: row.name }), false);
      expect(read.items.map(item => item.messageId).sort()).toEqual(expected);
      expect(await countNeedsYouItems(capture, workspace, viewer)).toMatchObject({ count: 4 });
      expect((await readNeedsYouOrder(capture, workspace, viewer)).order.sort()).toEqual(expected);
      expect((await needsYouItems(capture, workspace, viewer,
        row => ({ pubkey: row.id, kind: row.kind, name: row.name }), false, [room]))
        .items.map(item => item.messageId).sort()).toEqual(expected);

      for (const { sql, values } of statements) {
        const result = await database.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, values);
        const plan = result.rows[0]!['QUERY PLAN'][0];
        const visits = nodes(plan.Plan).filter(node => node['Index Name'] === 'messages_needs_you_report_status_idx')
          .reduce((sum, node) => sum + (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops'], 0);
        console.log(JSON.stringify({ reportVisits: visits, planningMs: plan['Planning Time'], executionMs: plan['Execution Time'] }));
        expect(visits, 'report candidates must not rescan the report index per candidate').toBeLessThanOrEqual(reports * 2);
      }
    } finally {
      await database.close();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    }
  }, 120_000);

  it('reads only open records with 5,000 historical reports and person tags across rooms', async () => {
    const name = `person_tags_latency_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8'`);
    const target = new URL(url!);
    target.pathname = `/${name}`;
    const database = new PostgresDatabase('', 1, {
      pool: new Pool({ connectionString: target.toString(), max: 1, options: '-c jit=off' }),
      mode: 'migration',
    });
    try {
      await migrate(database);
      const peer = 'c'.repeat(64);
      await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES
        ($1,'human','Reader','reader'),($2,'agent','Helper','helper'),($3,'human','Peer','peer')`, [viewer, agent, peer]);
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Tasks workload')`, [workspace]);
      await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Tasks')`, [room, workspace]);
      await database.query(`INSERT INTO rooms(id,workspace_id,name)
        SELECT md5('human-room-'||n)::uuid,$1,'Human room '||n FROM generate_series(1,5) n`, [workspace]);
      await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
        ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner')`, [workspace, viewer, peer, room]);
      await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        SELECT $1,r.id,i.id,'member' FROM rooms r CROSS JOIN identities i
        WHERE r.id<>$2 AND i.kind='human'`, [workspace, room]);
      await database.query(`INSERT INTO messages(id,room_id,author_id,text)
        SELECT 'history-'||n,$1,$2,'Ordinary history '||n FROM generate_series(1,10000) n`, [room, agent]);
      await database.query(`INSERT INTO messages(id,room_id,author_id,text,card,created_at)
        SELECT 'human-'||n,md5('human-room-'||(1+n%5))::uuid,
          CASE WHEN n%2=0 THEN $1 ELSE $2 END,
          CASE WHEN n%2=0 THEN '@reader please review note ' ELSE 'blocked: choose route ' END||n,
          CASE WHEN n%2=0 THEN NULL ELSE jsonb_build_object('reportStatus','blocked','reportToId',$3::text) END,
          now()-interval '10 days' FROM generate_series(1,5000) n`, [peer, agent, viewer]);
      await database.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
        SELECT 'answered-'||n,md5('human-room-'||n)::uuid,$1,'Reviewed.',now()-interval '9 days'
        FROM generate_series(1,5) n`, [viewer]);
      // Keep the report skew and four outstanding reports from the original fixture.
      await database.query('ANALYZE');
      await database.query(`INSERT INTO messages(id,room_id,author_id,text,card)
        SELECT 'report-'||n,$1,$2,'blocked: Choose an approach '||n,
          jsonb_build_object('reportStatus','blocked','reportToId',$3::text) FROM generate_series(1,$4::int) n`, [room, agent, viewer, reports]);
      await database.query(`INSERT INTO needs_you_marks(identity_id,message_id,workspace_id,cleared_at)
        SELECT $1,'report-'||n,$2,now() FROM generate_series(1,$3::int) n
        ON CONFLICT(identity_id,message_id) DO UPDATE SET cleared_at=EXCLUDED.cleared_at`, [viewer, workspace, reports-4]);
      const samples: number[] = [];
      let board;
      for (let run = 0; run < 13; run++) {
        const start = performance.now();
        board = await readWorkBoard(database, workspace, viewer);
        samples.push(performance.now()-start);
      }
      const sorted = [...samples.slice(6)].sort((a,b) => a-b);
      const median = sorted[Math.floor(sorted.length/2)]!;
      console.log(JSON.stringify({ fixture: '4455 plus 5000 answered reports and person tags in 5 rooms',
        samplesMs: samples, warmMedianMs: median, warmMaxMs: Math.max(...sorted),
        cards: board!.items.filter(item => item.ask).length }));
      expect(board!.items.filter(item => item.ask)).toHaveLength(4);
      expect(await countNeedsYouItems(database, workspace, viewer)).toMatchObject({ count: 4 });
      expect(Math.max(...sorted), 'every warm board read stays within the 450ms page budget').toBeLessThan(450);
    } finally {
      await database.close();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    }
  }, 120_000);

});

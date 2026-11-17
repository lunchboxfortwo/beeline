import { beforeEach, expect, it } from 'vitest';
import type { SqlDatabase } from '../database.js';
import { PhoneService } from '../phone-service.js';
import { migratedDatabase, type PgliteDatabase } from '../test-support.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const BOTH = '22222222-2222-4222-8222-222222222222';
const OFFLINE_ONLY = '33333333-3333-4333-8333-333333333333';
const HIDDEN_OFFLINE = '44444444-4444-4444-8444-444444444444';
const CORNER = '55555555-5555-4555-8555-555555555555';
const DM_ONLINE = '66666666-6666-4666-8666-666666666666';
const DM_OFFLINE = '77777777-7777-4777-8777-777777777777';
const PERSON = 'a'.repeat(64);
const ONLINE = 'b'.repeat(64);
const OFFLINE = 'c'.repeat(64);
const HIDDEN = 'd'.repeat(64);

let database: PgliteDatabase;
let phone: PhoneService;
let enrichment: { sql: string; values: unknown[] } | undefined;

beforeEach(async () => {
  database = await migratedDatabase();
  enrichment = undefined;
  const capture: SqlDatabase = {
    query: (sql, values, name) => {
      if (name === 'phone-chats-1') enrichment = { sql, values: values ?? [] };
      return database.query(sql, values, name);
    },
    transaction: (work) => database.transaction(work),
  };
  phone = new PhoneService(database, 'https://server.usebeeline.app', undefined, undefined, undefined, false, capture);
  await database.query(
    `INSERT INTO identities(id,kind,name,handle,hidden_from_roster) VALUES
      ($1,'human','Person','person',false),($2,'agent','Online','online',false),
      ($3,'agent','Offline','offline',false),($4,'agent','Hidden','hidden',true)`,
    [PERSON, ONLINE, OFFLINE, HIDDEN],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,name,parent_id,direct_participants,created_by) VALUES
      ($1,$7,'both',NULL,NULL,$8),($2,$7,'offline only',NULL,NULL,$8),($3,$7,'hidden offline',NULL,NULL,$8),
      ($4,$7,'corner',$2,NULL,$8),
      ($5,$7,'dm online',NULL,jsonb_build_array($8::text,$9::text),$8),
      ($6,$7,'dm offline',NULL,jsonb_build_array($8::text,$10::text),$8)`,
    [BOTH, OFFLINE_ONLY, HIDDEN_OFFLINE, CORNER, DM_ONLINE, DM_OFFLINE, WORKSPACE, PERSON, ONLINE, OFFLINE],
  );
  // Every chat shares the same two agents, so per-chat lookups would repeat them.
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),($1,NULL,$5,'member'),
      ($1,$6,$2,'owner'),($1,$6,$3,'member'),($1,$6,$4,'member'),
      ($1,$7,$2,'owner'),($1,$7,$4,'member'),
      ($1,$8,$2,'owner'),($1,$8,$5,'member'),
      ($1,$9,$2,'owner'),($1,$9,$3,'member'),
      ($1,$10,$2,'owner'),($1,$10,$4,'member')`,
    [WORKSPACE, PERSON, ONLINE, OFFLINE, HIDDEN, BOTH, OFFLINE_ONLY, HIDDEN_OFFLINE, DM_ONLINE, DM_OFFLINE],
  );
  await database.query(
    `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES
      ($1,$2,'presence','presence','{"status":"online"}'),
      ($1,$3,'presence','presence','{"status":"offline"}'),
      ($1,$4,'presence','presence','{"status":"offline"}')`,
    [BOTH, ONLINE, OFFLINE, HIDDEN],
  );
});

it('keeps each chat\'s presence while reading each shared agent once per list', async () => {
  const view = await phone.readChats(WORKSPACE, PERSON);
  const byId = new Map(view?.chats.map((chat) => [chat.room.id, chat]));
  expect([...byId.keys()].sort()).toEqual([BOTH, OFFLINE_ONLY, HIDDEN_OFFLINE, DM_ONLINE, DM_OFFLINE].sort());
  // A chat is offline only when every visible agent in it is known and offline.
  expect(byId.get(BOTH)?.agentsOffline).toBeUndefined();
  expect(byId.get(OFFLINE_ONLY)?.agentsOffline).toBe(true);
  // A hidden agent does not count toward the chat's agents.
  expect(byId.get(HIDDEN_OFFLINE)?.agentsOffline).toBeUndefined();
  expect(byId.get(DM_ONLINE)?.directMessage?.presence?.status).toBe('online');
  expect(byId.get(DM_OFFLINE)?.directMessage?.presence?.status).toBe('offline');
  expect(byId.get(DM_OFFLINE)?.agentsOffline).toBe(true);

  // Count how often the presence sources are scanned. Before this change it
  // was once per chat per agent (and once per agent peer); now it is once per
  // distinct agent in the list: ONLINE and OFFLINE (hidden agents never count).
  expect(enrichment).toBeDefined();
  const plan = await database.query<{ 'QUERY PLAN': unknown }>(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${enrichment!.sql}`, enrichment!.values);
  const raw = plan.rows[0]!['QUERY PLAN'];
  const root = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>;
  expect(scans(root[0]!.Plan, 'rooms_mcp_delivery')).toBe(2);
  expect(scans(root[0]!.Plan, 'live_outputs')).toBe(2);
});

type PlanNode = { 'Relation Name'?: string; 'Actual Loops'?: number; Plans?: PlanNode[] };

function scans(node: PlanNode, relation: string): number {
  const own = node['Relation Name'] === relation ? node['Actual Loops'] ?? 0 : 0;
  return own + (node.Plans ?? []).reduce((total, child) => total + scans(child, relation), 0);
}

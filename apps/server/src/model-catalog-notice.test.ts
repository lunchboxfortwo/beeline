import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const AGENT = 'b'.repeat(64);
const HUMAN = 'a'.repeat(64);

async function fixture() {
  const database = await migratedDatabase();
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Niglet','niglet')`,
    [HUMAN, AGENT],
  );
  await database.query(`INSERT INTO agents(agent_id,owner_id,selected_model) VALUES($1,$2,'opus[1m]')`, [
    AGENT,
    HUMAN,
  ]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
     VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member')`,
    [WORKSPACE, HUMAN, AGENT],
  );
  return database;
}

const MODEL_OPTIONS = [
  {
    id: 'model',
    category: 'model',
    currentValue: 'opus',
    options: [
      { id: 'sonnet', name: 'Sonnet 5.5' },
      { id: 'opus', name: 'Opus 5.5' },
    ],
  },
];

async function agentRow(database: PgliteDatabase) {
  return (
    await database.query<{ selected_model: string | null; model_unavailable: string | null }>(
      `SELECT selected_model,model_unavailable FROM agents WHERE agent_id=$1`,
      [AGENT],
    )
  ).rows[0];
}

async function ownerDmText(database: PgliteDatabase) {
  const rows = (
    await database.query<{ text: string }>(
      `SELECT m.text FROM messages m
       JOIN rooms r ON r.id=m.room_id
       JOIN memberships mem ON mem.room_id=r.id AND mem.identity_id=$1
       WHERE r.workspace_id=$2 ORDER BY m.created_at,m.id`,
      [HUMAN, WORKSPACE],
    )
  ).rows;
  return rows.map((row) => row.text);
}

describe('postAgentModelCatalog stays silent', () => {
  let database: PgliteDatabase;
  beforeEach(async () => { database = await fixture(); });
  afterEach(async () => { await database.close(); });

  it.each([undefined, 'model', 'effort', 'selection'] as const)(
    'persists catalog and selection without a DM when unavailable=%s', async unavailable => {
      const daemon = new DaemonService(database, new LiveHub());
      for (let mirror = 0; mirror < 2; mirror++) {
        await daemon.execute('postAgentModelCatalog', {
          agentId: AGENT, workspaceId: WORKSPACE, options: MODEL_OPTIONS,
          selection: { model: 'opus' }, ...(unavailable ? { unavailable } : {}),
        }, AGENT);
      }
      expect(await agentRow(database)).toEqual({ selected_model: 'opus', model_unavailable: unavailable ?? null });
      expect(await ownerDmText(database)).toEqual([]);
      expect((await database.query('SELECT 1 FROM rooms')).rowCount).toBe(0);
    },
  );
});

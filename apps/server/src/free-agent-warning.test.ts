import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpileModule } from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateData } from './database.js';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
import { FREE_AGENT_CONNECT_GUIDE, freeAgentConfigFromEnv, freeAgentInstructions } from './free-agents.js';
import { recordAgentConnectedAfterNudge } from './free-agent-warning.js';
import { PhoneService } from './phone-service.js';
import { AGENT_INVITATION_PATHS, AGENT_INVITATION_PROMPT } from '@beeline/api-contract/agent-invitation-guide';

const OWNER = 'a'.repeat(64), AGENT = 'b'.repeat(64), OTHER = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';

describe('historical free agent nudge conversions', () => {
  let db: PgliteDatabase;
  beforeEach(async () => {
    db = await migratedDatabase();
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Fern'),($3,'human','Other')`, [OWNER, AGENT, OTHER]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
    for (const member of [OWNER, AGENT, OTHER]) await db.query(
      `INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member')`, [WORKSPACE, member]);
    await db.query(`WITH workspace AS (SELECT $2::uuid) INSERT INTO free_agents(agent_id,owner_id,sealed_keys,state) VALUES($1,$3,'sealed','running')`, [AGENT, WORKSPACE, OWNER]);
    // The person's working room: OWNER and AGENT in, OTHER out.
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name,visibility) VALUES($1,$2,$3,'General','public')`, [ROOM, WORKSPACE, OWNER]);
    for (const member of [OWNER, AGENT]) await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WORKSPACE, ROOM, member]);
  });
  afterEach(async () => { await db.close(); });
  const historicalWarning = () => db.query(`INSERT INTO free_agent_events(agent_id,kind,detail)
    VALUES($1,'allowance_warning','{}'::jsonb)`, [AGENT]);

  it('records a non-free agent connected within 24 hours once, excludes old warnings', async () => {
    await historicalWarning();
    await recordAgentConnectedAfterNudge(db, OWNER, WORKSPACE, OTHER);
    await recordAgentConnectedAfterNudge(db, OWNER, WORKSPACE, OTHER);
    await recordAgentConnectedAfterNudge(db, OWNER, WORKSPACE, AGENT);
    expect((await db.query(`SELECT * FROM free_agent_events WHERE kind='agent_connected_after_nudge'`)).rowCount).toBe(1);
    await db.query(`DELETE FROM free_agent_events WHERE kind='agent_connected_after_nudge'`);
    await db.query(`UPDATE free_agent_events SET at=now()-interval '25 hours'`);
    await recordAgentConnectedAfterNudge(db, OWNER, WORKSPACE, OTHER);
    expect((await db.query(`SELECT * FROM free_agent_events WHERE kind='agent_connected_after_nudge'`)).rowCount).toBe(0);
  });

  it('records reaching Add agent after a warning as a guide start, without storing codes', async () => {
    const phone = new PhoneService(db, 'https://server.test');
    await phone.execute('createAgentPairingCode', { workspaceId: WORKSPACE }, OWNER);
    expect((await db.query(`SELECT * FROM free_agent_events WHERE kind='guide_started'`)).rowCount).toBe(0);
    await historicalWarning();
    await phone.execute('createAgentPairingCode', { workspaceId: WORKSPACE }, OTHER);
    expect((await db.query(`SELECT * FROM free_agent_events WHERE kind='guide_started'`)).rowCount).toBe(0);
    await phone.execute('createAgentPairingCode', { workspaceId: WORKSPACE }, OWNER);
    await phone.execute('createAgentPairingCode', { workspaceId: WORKSPACE }, OWNER);
    const events = await db.query(`SELECT detail FROM free_agent_events WHERE kind='guide_started'`);
    expect(events.rowCount).toBe(1);
    expect(events.rows[0]!.detail.source).toBe('add_agent_command');
    expect(Object.keys(events.rows[0]!.detail).sort()).toEqual(['source', 'warningId']);
  });

  it('updates existing free-agent instructions once while preserving their soul', async () => {
    await db.query(`INSERT INTO agents(agent_id,owner_id,soul) VALUES($1,$2,$3::jsonb)`, [AGENT, OWNER, JSON.stringify({ name: 'Fern', instructions: 'Original soul', avatarSeed: 'seed' })]);
    await db.query(`DELETE FROM workflow_backfills WHERE name='free-agent-connect-guide-v1'`);
    await migrateData(db);
    await migrateData(db);
    const soul = (await db.query<{ soul: { instructions: string; avatarSeed: string } }>(`SELECT soul FROM agents WHERE agent_id=$1`, [AGENT])).rows[0]!.soul;
    expect(soul.instructions).toBe(`Original soul\n\n${FREE_AGENT_CONNECT_GUIDE}`);
    expect(soul.avatarSeed).toBe('seed');
  });
});

it('keeps the real Add agent command on demand without computer-only or daily-nudge prompt restrictions', async () => {
  // Compile the pure mobile helper without loading Expo's tsconfig in server-only CI.
  const source = readFileSync(new URL('../../mobile/sources/buzz/agent-pairing-command.ts', import.meta.url), 'utf8');
  const pairing = {} as { agentPairingCommand: (code: string) => string };
  runInNewContext(transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText,
    { exports: pairing }, { timeout: 1000 });
  const config = freeAgentConfigFromEnv({ BEELINE_FREE_AGENT_SEAL_KEY: 'seal', FLY_FREE_AGENT_IMAGE: 'image' })!;
  const instructions = freeAgentInstructions('Soul', 'Fern', config);
  expect(AGENT_INVITATION_PATHS.helper).toContain(pairing.agentPairingCommand('<code>'));
  expect(instructions).toContain(AGENT_INVITATION_PROMPT);
  expect(instructions).not.toContain('turn limit');
  expect(instructions).not.toContain('At most one unsolicited nudge');
  for (const text of ['check your remaining allowance', 'device, assistant and plan', 'Never create, retrieve, request, repeat or post a pairing code', 'Confirm a tagged reply']) expect(instructions).toContain(text);
});

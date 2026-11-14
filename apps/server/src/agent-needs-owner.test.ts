import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PgliteDatabase, migratedDatabase } from './test-support.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const AGENT = 'a'.repeat(64);
const OWNER = 'b'.repeat(64);

const SNAPSHOT = await (async () => {
  const database = await migratedDatabase();
  try { return await database.snapshot(); } finally { await database.close(); }
})();

let database: PgliteDatabase;
let daemon: DaemonService;
beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  database = PgliteDatabase.fromSnapshot(SNAPSHOT);
  await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Clara','clara'),($2,'human','Owner','owner')`, [AGENT, OWNER]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [ROOM, WORKSPACE]);
  await database.query(`INSERT INTO agents(agent_id,owner_id,harness) VALUES($1,$2,'claude')`, [AGENT, OWNER]);
  for (const [identity, role] of [[AGENT, 'member'], [OWNER, 'owner']] as const)
    for (const room of [null, ROOM])
      await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,$4)`, [WORKSPACE, room, identity, role]);
  daemon = new DaemonService(database, new LiveHub());
});
afterEach(async () => { await database.close(); vi.restoreAllMocks(); });

const failed = (requestId: string, reasonKind: 'not-signed-in' | 'allowance-spent', reason: string) =>
  daemon.execute('postAgentTurnReceipt', { agentId: AGENT, roomId: ROOM, requestId, outcome: 'failed', reason, reasonKind }, AGENT);
const rows = async () => (await database.query<{ id: string; text: string; presentation: string; card_type: string | null; status: string | null; author_id: string }>(
  `SELECT id,text,presentation,card_type,card->>'status' status,author_id FROM messages WHERE room_id=$1 ORDER BY created_at,id`, [ROOM])).rows;

it('shows one sign-in card, never a card plus a line, and reuses it in place', async () => {
  await failed('turn-1', 'not-signed-in', 'Authentication required: the agent needs to sign in again');
  // The helper is offline here, so starting the sign-in settles the same card.
  await vi.waitFor(async () => expect((await rows())[0]?.status).toBe('failed'));
  await failed('turn-2', 'not-signed-in', 'Authentication required: the agent needs to sign in again');
  await vi.waitFor(async () => expect((await rows())[0]?.status).toBe('failed'));
  const shown = await rows();
  expect(shown).toHaveLength(1);
  expect(shown[0]).toMatchObject({ text: '@clara needs to sign in', presentation: 'card', card_type: 'agent-sign-in' });
  expect(shown[0]!.author_id).not.toBe(AGENT);

  // Signing in ends the episode; the next failure is a new card.
  await database.query(`UPDATE messages SET card=card||'{"status":"signed-in"}'::jsonb WHERE id=$1`, [shown[0]!.id]);
  await failed('turn-3', 'not-signed-in', 'Authentication required: the agent needs to sign in again');
  expect((await rows()).filter(row => row.card_type === 'agent-sign-in')).toHaveLength(2);
});

it('shows one out-of-limit line with its reset time', async () => {
  const reason = "You've hit your usage limit. Upgrade to Pro for more usage, or try again at Sep 19th, 2026 4:09 AM.";
  await failed('turn-1', 'allowance-spent', reason);
  await failed('turn-2', 'allowance-spent', reason);
  const shown = await rows();
  expect(shown.map(row => [row.text, row.presentation])).toEqual([['@clara is out of its limit · resets at Sep 19th, 2026 4:09 AM', 'system']]);
  expect(shown[0]!.author_id).not.toBe(AGENT);
  expect((await database.query(`SELECT 1 FROM agent_commands`)).rowCount).toBe(0);
});

it('shows nothing for any other failed turn', async () => {
  await daemon.execute('postAgentTurnReceipt', { agentId: AGENT, roomId: ROOM, requestId: 'turn-1', outcome: 'failed', reason: 'signal SIGKILL' }, AGENT);
  expect(await rows()).toEqual([]);
});

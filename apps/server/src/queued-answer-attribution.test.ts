import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { answerQueuedMessage, createAgentCommand } from './agent-command.js';
import { recordSigninFunnelEvent } from './signin-funnel.js';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';

const OWNER = '1'.repeat(64), AGENT = '2'.repeat(64), PEER = '3'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
let database: PgliteDatabase;
beforeAll(async () => {
  database = await migratedDatabase();
  await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','customer'),($2,'agent','Agent','agent'),($3,'agent','Peer','peer')`, [OWNER, AGENT, PEER]);
  await database.query(`INSERT INTO agents(agent_id,owner_id,selected_model) VALUES($1,$3,'openai/gpt-6-luna'),($2,$3,'openai/gpt-6-luna')`, [AGENT, PEER, OWNER]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Attribution')`, [WORKSPACE]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Task')`, [ROOM, WORKSPACE]);
  for (const identity of [OWNER, AGENT, PEER]) for (const room of [null, ROOM])
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`, [WORKSPACE, room, identity]);
}, 30_000);
afterAll(async () => database.close());

async function ask() {
  const sourceMessageId = randomUUID();
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Please help')`, [sourceMessageId, ROOM, OWNER]);
  return (await createAgentCommand(database, { roomId: ROOM, agentId: AGENT, sourceMessageId, reason: 'human_tag' }))!;
}

it('an ordinary answer records the selected model and keeps it across replay', async () => {
  const item = await ask();
  const answer = await answerQueuedMessage(database, AGENT, { roomId: ROOM, requestId: item.id, text: 'Here is the answer.' });
  const stored = () => database.query('SELECT agent_model FROM messages WHERE id=$1', [answer.id]);
  expect((await stored()).rows).toEqual([{ agent_model: 'openai/gpt-6-luna' }]);
  await database.query(`UPDATE agents SET selected_model='anthropic/opus' WHERE agent_id=$1`, [AGENT]);
  expect(await answerQueuedMessage(database, AGENT, { roomId: ROOM, requestId: item.id, text: 'Here is the answer.' })).toMatchObject({ id: answer.id });
  expect((await stored()).rows).toEqual([{ agent_model: 'openai/gpt-6-luna' }]);
});

it.each([
  ['Finished the task.', ['task_first_answer', 'task_final_answer']],
  ['@peer Please review this.', ['task_first_answer', 'task_review_requested']],
])('a starter depth-0 answer records its funnel milestones: %s', async (text, expected) => {
  await database.query(`INSERT INTO free_agents(agent_id,owner_id,sealed_keys,starter_role)
    VALUES($1,$2,'fixture','beebee') ON CONFLICT(agent_id) DO NOTHING`, [AGENT, OWNER]);
  const installId = randomUUID(), attemptId = randomUUID();
  await recordSigninFunnelEvent(database, { event: 'signed_in', installId, attemptId, provider: 'google',
    platform: 'web', version: 'test', environment: 'production', timestamp: new Date().toISOString() }, 'server', OWNER);
  await database.query(`INSERT INTO signin_funnel_events(install_id,attempt_id,event,platform,version,source,occurred_at)
    VALUES($1,$2,'signup','web','test','server',now())`, [installId, attemptId]);
  const item = await ask();
  expect(item.agent_depth).toBe(0);
  await answerQueuedMessage(database, AGENT, { roomId: ROOM, requestId: item.id, text });
  await expect.poll(async () => (await database.query<{ event: string }>(
    `SELECT event FROM signin_funnel_events WHERE install_id=$1 AND event LIKE 'task_%' ORDER BY event`, [installId],
  )).rows.map(row => row.event)).toEqual([...expected].sort());
});

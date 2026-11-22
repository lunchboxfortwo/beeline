import { afterEach, beforeEach, expect, it } from 'vitest';
import { readAgentDetailView, readWorkspaceMemberListView } from '@beeline/api-contract/phone';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { PgliteDatabase, migratedDatabase } from './test-support.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const AGENT = 'e'.repeat(64);
const OWNER = 'a'.repeat(64);
// The published catalog still says Astra: the session never applied it.
const CATALOG = [{
  id: 'model', category: 'model', currentValue: 'gpt-6.2-astra',
  options: [{ id: 'gpt-6.2-astra', name: '6.2 Astra' }, { id: 'gpt-6-sol', name: '6 Sol' }],
}];

let database: PgliteDatabase;
beforeEach(async () => {
  database = await migratedDatabase();
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Emberus','emberus')`,
    [OWNER, AGENT],
  );
  await database.query(
    `INSERT INTO agents(agent_id,owner_id,selected_model,model_catalog) VALUES($1,$2,'gpt-6.2-astra',$3::jsonb)`,
    [AGENT, OWNER, JSON.stringify(CATALOG)],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member')`,
    [WORKSPACE, OWNER, AGENT],
  );
});
afterEach(async () => { await database.close(); });

const phone = () => new PhoneService(database, 'https://server.example');
const report = (input: Record<string, unknown>) =>
  new DaemonService(database, new LiveHub()).execute('postAgentRunningModel', { agentId: AGENT, ...input } as never, AGENT);
const detail = async () => readAgentDetailView(await phone().readAgent(WORKSPACE, AGENT, OWNER));
const memberLabel = async () => readWorkspaceMemberListView(await phone().readWorkspaceMembers(WORKSPACE, OWNER))?.agents[0]?.model;

it('names the model the session runs, with the mismatch and its reason, when Astra was not applied', async () => {
  await report({ model: 'gpt-6-sol', selected: 'gpt-6.2-astra', reason: "This agent's harness does not offer gpt-6.2-astra." });
  expect(await memberLabel()).toBe('6 Sol');
  expect(await detail()).toMatchObject({
    runtimeSelection: { model: 'gpt-6-sol' },
    selected: { model: 'gpt-6.2-astra' },
    modelUnavailable: 'model',
    modelMismatch: { selected: 'gpt-6.2-astra', running: 'gpt-6-sol',
      reason: "This agent's harness does not offer gpt-6.2-astra." },
  });
});

it('shows no mismatch once a session reports the selected model running', async () => {
  await report({ model: 'gpt-6-sol', selected: 'gpt-6.2-astra', reason: 'refused' });
  await report({ model: 'gpt-6.2-astra', selected: 'gpt-6.2-astra' });
  expect(await memberLabel()).toBe('6.2 Astra');
  const view = await detail();
  expect(view?.modelMismatch).toBeUndefined();
  expect(view?.modelUnavailable).toBeUndefined();
});

it('keeps an old reason off a newer selection that no session has tried yet', async () => {
  await database.query(`UPDATE agents SET selected_model='gpt-6-sol' WHERE agent_id=$1`, [AGENT]);
  await report({ model: 'gpt-6.2-astra', selected: 'gpt-6.2-astra' });
  await database.query(`UPDATE agents SET selected_model='gpt-6.2-astra' WHERE agent_id=$1`, [AGENT]);
  await report({ model: 'gpt-6-sol', selected: 'gpt-6-sol', reason: 'old failure' });
  expect((await detail())?.modelMismatch).toEqual({ selected: 'gpt-6.2-astra', running: 'gpt-6-sol' });
});

it('falls back to the published catalog before any session reports', async () => {
  expect(await memberLabel()).toBe('6.2 Astra');
  expect((await detail())?.modelMismatch).toBeUndefined();
});

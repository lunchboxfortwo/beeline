// Isolated built HTTP proof; no production accounts, helper runtime or pairing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { transform } from 'esbuild';
import { PgliteDatabase } from '../../apps/server/src/test-support.ts';
import { agentInvitationGuide } from '../api-contract/dist/agent-invitation-guide.js';

const before = process.argv.includes('--before');
const baseline = '411764ba1'; // Parent checkout before this corner's invitation changes.
const output = new URL('../../.beeline-proof/agent-invitations/', import.meta.url);
mkdirSync(output, { recursive: true });
const compiledApps = new URL('../../apps/server/dist/daemon/apps.js', import.meta.url);
const current = readFileSync(compiledApps);
let database, server;
try {
  if (before) {
    const source = execFileSync('git', ['show', `${baseline}:apps/server/src/daemon/apps.ts`], { encoding: 'utf8' });
    writeFileSync(compiledApps, (await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' })).code);
  }
  const [{ migrate }, { DaemonService }, { PhoneService }, { LiveHub }, { createBeelineServer }] = await Promise.all([
    import('../../apps/server/dist/database.js'), import('../../apps/server/dist/daemon-service.js'),
    import('../../apps/server/dist/phone-service.js'), import('../../apps/server/dist/live.js'), import('../../apps/server/dist/server.js'),
  ]);
  // Modules are now loaded. Restore generated code even in the before process.
  writeFileSync(compiledApps, current);
  database = new PgliteDatabase();
  await migrate(database);
  const owner = 'a'.repeat(64), agent = 'b'.repeat(64);
  const workspace = '11111111-1111-4111-8111-111111111111', room = '22222222-2222-4222-8222-222222222222';
  await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Person','person'),($2,'agent','Agent','agent')`, [owner, agent]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
  await database.query(`INSERT INTO agents(agent_id,owner_id,machine_id,machine_name) VALUES($1,$2,'proof','Proof computer')`, [agent, owner]);
  await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'General')`, [room, workspace, owner]);
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`, [workspace, owner, agent, room]);
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('invitation-source',$1,$2,'How do I add my agent?')`, [room, owner]);
  await database.query(`INSERT INTO agent_commands(id,room_id,agent_id,source_message_id,turn_request_id,action,reason,root_command_id,root_source_message_id,agent_depth,state,generation_id,lease_expires_at)
    VALUES('invitation-command',$1,$2,'invitation-source','invitation-request','input','human_tag','invitation-command','invitation-source',0,'claimed','invitation-generation',now()+interval '10 minutes')`, [room, agent]);
  server = createBeelineServer({ database, phone: new PhoneService(database, 'http://localhost'),
    daemon: new DaemonService(database, new LiveHub()), live: new LiveHub(), mediaMaximumBytes: 1,
    auth: { authenticateDaemon: async () => agent, authenticatePhone: async () => null } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const rows = [];
  for (const service of ['claude', 'chatgpt', 'muse', 'grok', ...(before ? [] : ['gemini', 'cursor', 'codex', 'claude code', 'beeline helper', 'grok bot', 'grok business', 'grok cli', 'opencode', 'pi', 'hermes', 'zcode', 'goose'])]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/daemon/operations/connect`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer bdt_isolated-proof-token-0001' },
      body: JSON.stringify({ roomId: room, requestId: 'invitation-request', generationId: 'invitation-generation',
        service, reason: 'Explain adding this agent on iPhone and desktop, including plan limits' }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, `HTTP ${service}: ${JSON.stringify(result)}`);
    rows.push({ service, http: response.status, pass: result.next === agentInvitationGuide(service), result });
  }
  writeFileSync(new URL(before ? 'before.json' : 'after.json', output), JSON.stringify(rows, null, 2) + '\n');
  console.log(`Reproduction onboarding-prompt-1: built HTTP connect → ${rows.every(row => row.pass) ? 'canonical assistant guidance' : 'conflicting generic guidance'} (${rows.length} assistants)`);
  assert.ok(rows.every(row => row.pass), 'HTTP answers must match the canonical assistant guide, with device/plan/delivery distinctions');
  assert.equal((await database.query('SELECT id FROM workspace_apps')).rowCount, 0);
} finally {
  writeFileSync(compiledApps, current);
  if (server) await new Promise(resolve => server.close(resolve));
  await database?.close();
}

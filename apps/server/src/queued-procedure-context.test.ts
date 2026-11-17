import { randomUUID } from 'node:crypto';
import { afterEach, vi } from 'vitest';
import { applySkillRevision } from './institutional-skills.js';
import { pendingMcpWakes } from './rooms-mcp-agent.js';
import { readAgentCommands } from './agent-command-read-agent-commands.js';
import { itemPrompt } from '../../body/src/place-prompt.js';
import {
  AGENT, HUMAN, ROOM, WORKSPACE, MESSAGE, OTHER_WORKSPACE, OTHER_ROOM,
  rootFixture, createAgentCommand, expect, it,
} from './test-support-institutional-memory-shadow.test-support.js';

afterEach(() => vi.unstubAllEnvs());

it.each(['checkout-runbook', 'Pay the supplier'])('pushes the named procedure %s on the first tagged turn', async (name) => {
  vi.stubEnv('OPENROUTER_EMBEDDING_API_KEY', '');
  await applySkillRevision(rootFixture.database, {
    workspaceId: WORKSPACE, sourceRoomId: ROOM, slug: 'checkout-runbook',
    description: 'Use the existing supplier account.', kind: 'procedure',
    markdown: '# Pay the supplier\n\nUse the saved supplier invoice before opening payment sign-in.',
    sourceMessageIds: [MESSAGE],
  });
  await applySkillRevision(rootFixture.database, {
    workspaceId: OTHER_WORKSPACE, sourceRoomId: OTHER_ROOM, slug: 'checkout-runbook',
    description: 'Private other workspace.', kind: 'procedure',
    markdown: '# Pay the supplier\n\nOTHER WORKSPACE SECRET', sourceMessageIds: [MESSAGE],
  });
  const source = randomUUID();
  await rootFixture.database.query('INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)',
    [source, ROOM, HUMAN, `@Bee please follow “${name}”.`]);
  const command = await createAgentCommand(rootFixture.database, {
    roomId: ROOM, agentId: AGENT, sourceMessageId: source, reason: 'human_tag',
  });
  const queued = (await readAgentCommands(rootFixture.database, AGENT)).commands.find(c => c.id === command!.id)!;
  const prompt = itemPrompt(queued, { names: new Map(), fresh: true });
  expect(prompt).toContain('Use the saved supplier invoice before opening payment sign-in.');
  expect(prompt).toContain('<workspace-procedure>');
  expect(prompt).not.toContain('OTHER WORKSPACE SECRET');
  const wake = (await pendingMcpWakes(rootFixture.database, AGENT)).find(c => c.id === command!.id)!;
  expect(wake.institutionalContext).toContain('Use the saved supplier invoice before opening payment sign-in.');
  // The same body is frozen for reconnects, even after the saved version changes.
  await rootFixture.database.query("UPDATE workspace_skill_versions SET markdown='changed later' WHERE skill_id IN (SELECT id FROM workspace_skills WHERE workspace_id=$1)", [WORKSPACE]);
  expect((await readAgentCommands(rootFixture.database, AGENT)).commands.find(c => c.id === command!.id)!.source.institutionalContext)
    .toBe(queued.source.institutionalContext);
  expect((await rootFixture.database.query('SELECT text FROM messages WHERE id=$1', [source])).rows[0]!.text)
    .not.toContain('supplier invoice');
});

it('does not load a procedure body for a partial name or a retired procedure', async () => {
  vi.stubEnv('OPENROUTER_EMBEDDING_API_KEY', '');
  await applySkillRevision(rootFixture.database, {
    workspaceId: WORKSPACE, sourceRoomId: ROOM, slug: 'checkout-runbook',
    description: 'Supplier account.', kind: 'procedure', markdown: '# Supplier checkout\n\nUNREQUESTED BODY',
    sourceMessageIds: [MESSAGE],
  });
  for (const text of ['Use precheckout-runbooks please', 'Follow checkout-runbook']) {
    if (text.startsWith('Follow')) await rootFixture.database.query("UPDATE workspace_skills SET state='archived' WHERE workspace_id=$1", [WORKSPACE]);
    const source = randomUUID();
    await rootFixture.database.query('INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)', [source, ROOM, HUMAN, text]);
    const command = await createAgentCommand(rootFixture.database, { roomId: ROOM, agentId: AGENT, sourceMessageId: source, reason: 'human_tag' });
    expect(command!.message?.institutionalContext).not.toContain('UNREQUESTED BODY');
  }
});

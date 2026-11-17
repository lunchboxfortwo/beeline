import { expect, it, vi } from 'vitest';
import { createAgentCommand, readAgentCommands } from './agent-command.js';
import { describedWorkflow } from './test-support.js';
import { cancelWorkflowRun, handoff, saveWorkflow, startWorkflow } from './workflow-runs.js';
import { CONTRACT, IMPLEMENTER, OWNER, REVIEWER, APPROVER, ROOM, adminCommand, commandFor, database, rootMessage } from './test-fixtures/workflow-runs.js';

vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return { ...crypto, randomBytes: vi.fn(crypto.randomBytes) };
});

async function start() {
  const command = await commandFor(IMPLEMENTER, await rootMessage(OWNER));
  await saveWorkflow(database, command, { contract: describedWorkflow({ ...CONTRACT,
    handoffs: { ...CONTRACT.handoffs,
      implement: { ...CONTRACT.handoffs.implement, hint: 'Include the pull request.' },
      checks: { ...CONTRACT.handoffs.checks, hint: 'Include the checked commit.' },
    },
  }) });
  const { runId } = await startWorkflow(database, command, { name: 'corner',
    roleBindings: { implementer: IMPLEMENTER, reviewer: REVIEWER, approver: APPROVER } });
  const wake = (await readAgentCommands(database, IMPLEMENTER)).commands.find(item => item.source.body.includes(`You are in run ${runId}`))!;
  return { runId, wake, parent: (await database.query<import('./agent-command.js').CommandRow>('SELECT * FROM agent_commands WHERE id=$1', [wake.id])).rows[0]! };
}

it('freezes state, pinned outcomes and receipt hint when the workflow wake is queued', async () => {
  const { runId, wake, parent } = await start();
  expect(wake.source.body).toContain('Current state: implement. Allowed outcomes:');
  expect(wake.source.body).toContain('pushed -> checks');
  expect(wake.source.body).toContain('stuck -> ask_human');
  expect(wake.source.body).toContain('Receipt hint for this state: Include the pull request.');
  expect(wake.source.body).toContain('This wake is attempt 0');
  await handoff(database, parent, { runId, outcome: 'pushed', contents: { summary: 'Ready', prUrl: 'https://example.com/change' }, attempt: 0 });
  const stored = (await database.query<{ message: { body: string } }>('SELECT message FROM agent_commands WHERE id=$1', [wake.id])).rows[0]!;
  expect(stored.message.body).toBe(wake.source.body);
});

it('an approval resume uses its parent workflow and the current state from the pinned version', async () => {
  const { runId, parent } = await start();
  await handoff(database, parent, { runId, outcome: 'pushed', contents: { summary: 'Ready', prUrl: 'https://example.com/change' }, attempt: 0 });
  // A newer saved contract must not replace the run's pinned contract.
  await saveWorkflow(database, await adminCommand(), { contract: describedWorkflow(CONTRACT) });
  const sourceMessageId = await rootMessage(OWNER, 'Permission granted');
  const resumed = await createAgentCommand(database, { roomId: ROOM, agentId: IMPLEMENTER,
    sourceMessageId, reason: 'resume', parent, resume: true });
  expect(resumed!.message!.body).toContain(`You are in run ${runId} of corner`);
  expect(resumed!.message!.body).toContain('Current state: checks. Allowed outcomes:');
  expect(resumed!.message!.body).toContain('passing -> review');
  expect(resumed!.message!.body).toContain('failing -> implement');
  expect(resumed!.message!.body).toContain('Receipt hint for this state: Include the checked commit.');
});

it('a resume for a closed run offers no outcomes or live attempt', async () => {
  const { runId, parent } = await start();
  await cancelWorkflowRun(database, await adminCommand(), { runId, reason: 'Task cancelled' });
  const resumed = await createAgentCommand(database, { roomId: ROOM, agentId: IMPLEMENTER,
    sourceMessageId: await rootMessage(OWNER, 'Permission granted'), reason: 'resume', parent, resume: true });
  expect(resumed!.message!.body).toContain(`You are in run ${runId} of corner`);
  expect(resumed!.message!.body).toMatch(/Current state: .* \([^)]+\). Allowed outcomes: none\./);
  expect(resumed!.message!.body).not.toContain('This wake is attempt');
});

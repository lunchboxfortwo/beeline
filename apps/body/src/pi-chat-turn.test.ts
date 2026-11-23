import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { afterEach, expect, it } from 'vitest';
import { agentCornerCheckoutPaths } from './agent-corner-checkout.js';
import { installPiSystemPrompt } from './pi-session-instructions.js';
import { itemPrompt, memberThreads } from './place-prompt.js';
import { assembleSessionPrompt } from './prompt-assembly.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const count = (text: string, part: string) => text.split(part).length - 1;

it('a Pi chat turn names its open thread and checkout once, and its rules live once in SYSTEM.md', async () => {
  const root = mkdtempSync(join(tmpdir(), 'beeline-pi-chat-turn-'));
  roots.push(root);
  const agent = { publicKey: 'grunt' };
  const thread = {
    cornerId: 'd3293b70-78c0-424f-b62d-15a38c3974b0',
    parentRoomId: 'apm',
    name: 'game-3d',
    createdBy: 'grunt',
    archived: false,
    pullRequestNumber: 1,
    objective: 'Move the 3D slice into the repository.',
  };
  const checkout = agentCornerCheckoutPaths(root, thread.cornerId, agent.publicKey).path;
  mkdirSync(checkout, { recursive: true });
  const session = assembleSessionPrompt({
    surface: 'room',
    agentName: 'Grunt',
    agentCommand: '/opt/adapters/pi/node_modules/.bin/pi-acp',
    repositoryPending: true,
    shell: { available: true },
    writableHome: join(root, 'agent-home', 'user'),
  });
  const item: AgentCommand = {
    id: 'request',
    turnRequestId: 'request',
    rootCommandId: 'request',
    rootSourceMessageId: 'message',
    sourceMessageId: 'message',
    roomId: 'apm',
    roomName: '#apm',
    returnRoomId: 'apm',
    agentId: 'grunt',
    action: 'input',
    reason: 'human_tag',
    agentDepth: 0,
    createdAt: 0,
    source: {
      id: 'message',
      authorId: 'dana',
      type: 'message',
      attachments: [],
      createdAt: 0,
      body: '@grunt the start button does not work on phones. Please fix it.',
    },
  };
  const threads = memberThreads(
    'room',
    {
      corners: [thread, { ...thread, cornerId: 'closed-thread', name: 'old-work', archived: true }],
    },
    { placeId: 'apm', runtime: { supervisorRoot: root }, agent },
  );
  const turn = itemPrompt(item, {
    names: new Map([['dana', 'Dana']]),
    turnPrefix: session.turnPrefix,
    threads,
    fresh: true,
  });

  expect(turn).toContain(
    'Current threads you belong to (use the exact address with read or message):\n' +
      `- game-3d (${thread.cornerId}), parent chat apm, created by grunt, PR #1, checkout ${checkout}: Move the 3D slice into the repository.`,
  );
  expect(count(turn, thread.cornerId)).toBe(1);
  expect(count(turn, checkout)).toBe(1);
  expect(turn).not.toContain('old-work');
  expect(session.systemPrompt).toContain('Code work happens only in a thread.');
  expect(session.systemPrompt).not.toContain('write/edit tools');
  expect(session.turnPrefix).toBe('');
  expect(count(turn, 'You are Grunt in Beeline')).toBe(0);
  const env = { PI_CODING_AGENT_DIR: join(root, 'agent-home', 'pi') };
  await installPiSystemPrompt(env, session.systemPrompt);
  const system = readFileSync(join(env.PI_CODING_AGENT_DIR, 'SYSTEM.md'), 'utf8');
  expect(system).toBe(session.systemPrompt);
  expect(count(system, 'You are Grunt in Beeline')).toBe(1);
});

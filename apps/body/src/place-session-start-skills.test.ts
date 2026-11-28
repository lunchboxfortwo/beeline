import type { AgentCommand } from '@beeline/api-contract/daemon';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AcpClient } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { PlaceSession } from './place-session.js';
import type { AgentRuntimeRecord } from './runtime.js';

// The optional prepare never finishes: only the session-start home step can write skills.
vi.mock('./agent-home.js', async (original) => ({
  ...(await original<typeof import('./agent-home.js')>()),
  prepareRoomAgentHome: vi.fn(() => new Promise(() => {})),
}));

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

it('pi-skills-1123: a new Room starts its Pi harness with the skills its rules name, without prepare', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-start-skills-'));
  roots.push(root);
  const agentHomeRoot = join(root, 'agent-home');
  let atStart: string[] = [];
  const client = Object.assign(new EventEmitter(), {
    isAlive: true,
    startProcess: vi.fn(async () => {
      atStart = await readdir(join(agentHomeRoot, 'pi', 'skills'));
    }),
    stopProcess: vi.fn(async () => {}),
    sessionNew: vi.fn(async () => ({ sessionId: 'live', raw: {} })),
    sessionPrompt: vi.fn(async () => ({
      agentText: 'The answer',
      stopReason: 'end_turn',
      updates: [],
      toolCalls: [],
    })),
    canLoadSession: () => false,
    canPromptWithImages: () => false,
    promptDelivery: () => undefined,
  });
  const spawn = vi.fn(
    (_options: { agentEnv?: Record<string, string> }) => client as unknown as AcpClient,
  );
  const session = new PlaceSession({
    agent: { publicKey: 'a'.repeat(64), name: 'Agent' },
    runtime: { supervisorRoot: root, agent: { publicKey: 'a'.repeat(64) } } as AgentRuntimeRecord,
    config: {
      workspaceRoot: root,
      agentHomeRoot,
      operatorHome: root,
      agentKind: 'pi',
      agentBinary: 'fixture',
      agentEnv: {},
      readonlyMcpCommand: 'fixture',
      mcpBinary: 'fixture',
    } as BodyConfig,
    api: {
      baseUrl: 'https://synthetic.test',
      execute: vi.fn(() => new Promise(() => {})),
      refreshMachineVault: async () => {},
      connection: () => ({
        baseUrl: 'http://localhost',
        daemonToken: 'fixture',
        agentId: 'a'.repeat(64),
        helperVersion: 'test',
      }),
    } as unknown as DaemonApiClient,
    placeId: 'room',
    workspaceId: 'workspace',
    onExit() {},
    createAcpClient: spawn,
  });
  await session.start();
  const env = spawn.mock.calls[0]![0].agentEnv!;
  roots.push(env.TMPDIR!);
  expect(env.PI_CODING_AGENT_DIR).toBe(join(agentHomeRoot, 'pi'));
  expect(atStart).toEqual(expect.arrayContaining(['beeline-triage', 'beeline-spec']));
  const item = {
    id: 'item',
    rootCommandId: 'task',
    roomId: 'room',
    returnRoomId: 'room',
    turnRequestId: 'item',
    reason: 'human_tag',
    agentId: 'a'.repeat(64),
    source: {
      id: 'message',
      authorId: 'human',
      body: 'Please answer',
      attachments: [],
      type: 'message',
    },
  } as AgentCommand;
  expect(await session.deliver(item, [])).toMatchObject({ text: 'The answer' });
  const { prepareRoomAgentHome } = await import('./agent-home.js');
  expect(prepareRoomAgentHome).not.toHaveBeenCalled();
  await session.dispose();
});

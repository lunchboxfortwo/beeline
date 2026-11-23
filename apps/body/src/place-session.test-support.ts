import type { AgentCommand } from '@beeline/api-contract/daemon';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, vi } from 'vitest';
import type { AcpClient } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { PlaceSession } from './place-session.js';
import type { AgentRuntimeRecord } from './runtime.js';

const pendingRead = (name: string) =>
  name === 'listRoomCorners' ? Promise.resolve({ corners: [] }) : new Promise(() => {});
const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

export async function fixture(corner = false, temporaryRoot = tmpdir()) {
  const root = await mkdtemp(join(temporaryRoot, 'session-start-'));
  roots.push(root);
  let delivered = false;
  const prompt = vi.fn(async () => {
    delivered = true;
    return { agentText: 'The answer', stopReason: 'end_turn', updates: [], toolCalls: [] };
  });
  const client = Object.assign(new EventEmitter(), {
    isAlive: true,
    startProcess: vi.fn(async () => {}),
    stopProcess: vi.fn(async () => {}),
    sessionNew: vi.fn(async () => ({
      sessionId: 'live',
      raw: {
        configOptions: [
          {
            id: 'model',
            category: 'model',
            currentValue: 'default-model',
            options: [{ value: 'default-model' }],
          },
        ],
      },
    })),
    sessionPrompt: prompt,
    canLoadSession: () => false,
    canPromptWithImages: () => false,
  });
  const execute = vi.fn((name: string) => {
    if (name.startsWith('get') || name === 'listAgentGrants') expect(delivered).toBe(true);
    return pendingRead(name);
  });
  const config = {
    workspaceRoot: root,
    agentHomeRoot: join(root, 'agent-home'),
    operatorHome: root,
    agentBinary: 'fixture',
    agentEnv: {},
    readonlyMcpCommand: 'fixture',
    mcpBinary: 'fixture',
  } as BodyConfig;
  const spawn = vi.fn(() => client as unknown as AcpClient);
  const session = new PlaceSession({
    agent: { publicKey: 'a'.repeat(64), name: 'Agent' },
    runtime: { supervisorRoot: root, agent: { publicKey: 'a'.repeat(64) } } as AgentRuntimeRecord,
    config,
    api: {
      baseUrl: 'https://synthetic.test',
      execute,
      refreshMachineVault: async () => {},
      connection: () => ({
        baseUrl: 'http://localhost',
        daemonToken: 'fixture',
        agentId: 'a'.repeat(64),
        helperVersion: 'test',
      }),
    } as unknown as DaemonApiClient,
    placeId: 'room',
    ...(corner ? { parentRoomId: 'parent' } : {}),
    workspaceId: 'workspace',
    onExit() {},
    createAcpClient: spawn,
  });
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
  return { session, item, prompt, execute, config, spawn, client };
}

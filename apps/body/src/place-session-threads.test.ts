import type { AgentCommand } from '@beeline/api-contract/daemon';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AcpClient } from './acp.js';
import { agentCornerCheckoutPaths } from './agent-corner-checkout.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { PlaceSession } from './place-session.js';
import type { AgentRuntimeRecord } from './runtime.js';

vi.mock('./atomic-private-file.js', async original => {
  const actual = await original<typeof import('./atomic-private-file.js')>();
  return { ...actual, writePrivateFileAtomically: async (path: string, contents: string) => {
    if (!path.endsWith('/session-context.json')) await actual.writePrivateFileAtomically(path, contents);
  } };
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(parentRoomId?: string) {
  const root = await mkdtemp(join(process.cwd(), '.thread-context-'));
  roots.push(root);
  const prompt = vi.fn(async (_sessionId: string, _prompt: unknown) => ({
    agentText: 'Done', stopReason: 'end_turn', updates: [], toolCalls: [],
  }));
  const client = Object.assign(new EventEmitter(), {
    isAlive: true, startProcess: vi.fn(async () => {}), stopProcess: vi.fn(async () => {}),
    sessionNew: vi.fn(async () => ({ sessionId: 'live', raw: {} })), sessionPrompt: prompt,
    canLoadSession: () => false, canPromptWithImages: () => false,
  });
  const execute = vi.fn((name: string): Promise<unknown> => name === 'listRoomCorners'
    ? Promise.resolve({ corners: [] }) : new Promise(() => {}));
  const agent = { publicKey: 'a'.repeat(64), name: 'Agent' };
  const session = new PlaceSession({
    agent, runtime: { supervisorRoot: root, agent } as AgentRuntimeRecord,
    config: { workspaceRoot: root, agentHomeRoot: join(root, 'agent-home'), operatorHome: root,
      agentBinary: 'fixture', agentEnv: {}, readonlyMcpCommand: 'fixture', mcpBinary: 'fixture' } as BodyConfig,
    api: { execute, refreshMachineVault: async () => {},
      connection: () => ({ baseUrl: 'http://localhost', daemonToken: 'fixture', agentId: agent.publicKey, helperVersion: 'test' }) } as unknown as DaemonApiClient,
    placeId: 'room', parentRoomId, workspaceId: 'workspace', onExit() {},
    createAcpClient: () => client as unknown as AcpClient,
  });
  const item = { id: 'item', rootCommandId: 'task', roomId: 'room', returnRoomId: 'room',
    turnRequestId: 'item', reason: 'human_tag', agentId: agent.publicKey,
    source: { id: 'message', authorId: 'human', body: 'Fix the code', attachments: [], type: 'message' },
  } as AgentCommand;
  return { root, agent, session, item, prompt, execute };
}

it.each([
  [undefined, false, false], [undefined, true, true],
  ['parent', false, true], ['parent', true, false],
] as const)('delivers first-turn thread addresses and checkouts (parent=%s, legacy=%s, batch=%s)', async (parent, legacy, batch) => {
  const f = await fixture(parent);
  if (legacy) await writeFile(join(f.root, 'session-context.json'), JSON.stringify({ modelCatalog: [] }));
  const checkout = agentCornerCheckoutPaths(f.root, 'open-thread', f.agent.publicKey).path;
  await mkdir(checkout, { recursive: true });
  let reconcile!: (value: unknown) => void;
  const snapshot = new Promise(resolve => { reconcile = resolve; });
  let requested!: () => void;
  const request = new Promise<void>(resolve => { requested = resolve; });
  f.execute.mockImplementation(name => {
    if (name !== 'listRoomCorners') return new Promise(() => {});
    requested();
    return snapshot;
  });
  try {
    await f.session.start();
    expect(f.session.resources.context.threads).toBeUndefined();
    const next = { ...f.item, id: 'second', turnRequestId: 'second' };
    const delivery = f.session.deliver(f.item, batch ? [f.item, next] : []);
    await request;
    expect(f.prompt).not.toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledWith('listRoomCorners', { roomId: parent ?? 'room', activeOnly: true });
    reconcile({ corners: [{ cornerId: 'open-thread', parentRoomId: parent ?? 'room', name: 'Game fix',
      createdBy: f.agent.publicKey, archived: false, objective: 'Repair the start button' }] });
    await delivery;
    const emitted = f.prompt.mock.calls[0]![1];
    expect(emitted).toContain('Current threads you belong to');
    expect(emitted).toContain('Game fix (open-thread)');
    expect(emitted).toContain(`checkout ${checkout}`);
    f.execute.mockImplementation(() => new Promise(() => {}));
    await expect(f.session.deliver(next)).resolves.toMatchObject({ text: 'Done' });
    expect(f.prompt.mock.calls[1]![1]).toContain(`checkout ${checkout}`);
  } finally { await f.session.dispose(); }
});

it('delivers the first turn when thread reconciliation fails', async () => {
  const f = await fixture();
  f.execute.mockImplementation(name => name === 'listRoomCorners'
    ? Promise.reject(new Error('offline')) : new Promise(() => {}));
  try {
    await f.session.start();
    await expect(f.session.deliver(f.item)).resolves.toMatchObject({ text: 'Done' });
    expect(f.prompt.mock.calls[0]![1]).not.toContain('Current threads you belong to');
  } finally { await f.session.dispose(); }
});

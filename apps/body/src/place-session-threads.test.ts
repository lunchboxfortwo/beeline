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
    const command = { ...f.item, threads: { corners: [{
      cornerId: 'open-thread', parentRoomId: parent ?? 'room', name: 'Game fix',
      createdBy: f.agent.publicKey, archived: false, objective: 'Repair the start button',
    }] } };
    const delivery = f.session.deliver(command, batch ? [command, next] : []);
    await request;
    await expect(delivery).resolves.toMatchObject({ text: 'Done' });
    expect(f.prompt).toHaveBeenCalledOnce();
    expect(f.execute).toHaveBeenCalledWith('listRoomCorners', { roomId: parent ?? 'room', activeOnly: true });
    const emitted = f.prompt.mock.calls[0]![1];
    expect(emitted.includes('Current threads you belong to')).toBe(!parent);
    expect(emitted.includes('Game fix (open-thread)')).toBe(!parent);
    expect(emitted.includes(`checkout ${checkout}`)).toBe(!parent);
    reconcile(command.threads);
    await vi.waitFor(() => expect(f.session.resources.context.threads).toEqual(command.threads));
    f.execute.mockImplementation(() => new Promise(() => {}));
    await expect(f.session.deliver(next)).resolves.toMatchObject({ text: 'Done' });
    expect(f.prompt.mock.calls[1]![1].includes(`checkout ${checkout}`)).toBe(!parent);
  } finally { await f.session.dispose(); }
});

it.each(['pending', 'failed'])('delivers legacy commands when optional thread reconciliation is %s', async outcome => {
  const f = await fixture();
  f.execute.mockImplementation(name => name === 'listRoomCorners'
    ? (outcome === 'failed' ? Promise.reject(new Error('offline')) : new Promise(() => {}))
    : new Promise(() => {}));
  try {
    await f.session.start();
    await expect(f.session.deliver(f.item)).resolves.toMatchObject({ text: 'Done' });
    expect(f.prompt.mock.calls[0]![1]).not.toContain('Current threads you belong to');
  } finally { await f.session.dispose(); }
});

it.each([false, true])('uses the newest received threads for a waiting command (batch=%s)', async batch => {
  const f = await fixture();
  const checkout = agentCornerCheckoutPaths(f.root, 'opened-thread', f.agent.publicKey).path;
  await mkdir(checkout, { recursive: true });
  const opened = { corners: [{ cornerId: 'opened-thread', parentRoomId: 'room', name: 'Game fix',
    createdBy: f.agent.publicKey, archived: false, objective: 'Repair the start button' }] };
  let finish!: () => void;
  const active = new Promise<void>(resolve => { finish = resolve; });
  f.prompt.mockImplementationOnce(async () => {
    await active;
    return { agentText: 'Done', stopReason: 'end_turn', updates: [], toolCalls: [] };
  });
  f.execute.mockImplementation(() => new Promise(() => {}));
  try {
    await f.session.start();
    const first = f.session.deliver(f.item);
    await vi.waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
    const waiting = { ...f.item, id: 'waiting', turnRequestId: 'waiting', threads: { corners: [] } };
    const sibling = { ...waiting, id: 'sibling', turnRequestId: 'sibling' };
    f.session.resources.receiveCommand(waiting);
    f.session.resources.receiveCommand(sibling);
    finish();
    await first;
    f.execute.mockImplementation(name => name === 'listRoomCorners'
      ? Promise.resolve(opened) : new Promise(() => {}));
    await f.session.resources.refreshThreads();
    f.execute.mockImplementation(() => new Promise(() => {}));
    await f.session.deliver(waiting, batch ? [waiting, sibling] : []);
    expect(f.prompt.mock.calls[1]![1]).toContain('Game fix (opened-thread)');
    expect(f.prompt.mock.calls[1]![1]).toContain(`checkout ${checkout}`);

    f.session.resources.receiveCommand({ ...waiting, threads: { corners: [] } });
    await f.session.deliver(waiting);
    expect(f.prompt.mock.calls[2]![1]).not.toContain('Game fix (opened-thread)');
  } finally { finish(); await f.session.dispose(); }
});

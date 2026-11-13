import type { AgentCommand } from '@beeline/api-contract/daemon';
import { EventEmitter } from 'node:events';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname,join } from 'node:path';
import { afterEach,expect,it,vi } from 'vitest';
import type { AcpClient } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { PlaceSession } from './place-session.js';
import type { AgentRuntimeRecord } from './runtime.js';

// Cache persistence is tested with real files by SessionResources. These
// prompt tests intentionally finish while optional background work is pending.
vi.mock('./atomic-private-file.js', async original => ({
  ...await original<typeof import('./atomic-private-file.js')>(),
  writePrivateFileAtomically: vi.fn(async () => {}),
}));
vi.mock('./agent-home.js', async original => ({
  ...await original<typeof import('./agent-home.js')>(),
  prepareRoomAgentHome: vi.fn(() => new Promise(() => {})),
}));
const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'session-start-')); roots.push(root);
  let delivered = false;
  const prompt = vi.fn(async () => { delivered = true; return { agentText: 'The answer', stopReason: 'end_turn', updates: [], toolCalls: [] }; });
  const client = Object.assign(new EventEmitter(), {
    isAlive: true, startProcess: vi.fn(async () => {}), stopProcess: vi.fn(async () => {}),
    sessionNew: vi.fn(async () => ({ sessionId: 'live', raw: { configOptions: [
      { id: 'model', category: 'model', currentValue: 'default-model', options: [{ value: 'default-model' }] },
    ] } })), sessionPrompt: prompt, canLoadSession: () => false,
  });
  const execute = vi.fn((name: string) => {
    if (name.startsWith('get') || name === 'listAgentGrants') expect(delivered).toBe(true);
    return new Promise(() => {});
  });
  const config = { workspaceRoot: root, agentHomeRoot: join(root, 'agent-home'), operatorHome: root,
    agentBinary: 'fixture', agentEnv: {}, readonlyMcpCommand: 'fixture', mcpBinary: 'fixture' } as BodyConfig;
  const spawn = vi.fn(() => client as unknown as AcpClient);
  const session = new PlaceSession({
    agent: { publicKey: 'a'.repeat(64), name: 'Agent' },
    runtime: { supervisorRoot: root, agent: { publicKey: 'a'.repeat(64) } } as AgentRuntimeRecord,
    config, api: { execute, connection: () => ({ baseUrl: 'http://localhost', daemonToken: 'fixture', agentId: 'a'.repeat(64), helperVersion: 'test' }) } as unknown as DaemonApiClient,
    placeId: 'room', workspaceId: 'workspace', onExit() {}, createAcpClient: spawn,
  });
  const item = { id: 'item', roomId: 'room', returnRoomId: 'room', turnRequestId: 'item', reason: 'human_tag',
    agentId: 'a'.repeat(64),
    source: { id: 'message', authorId: 'human', body: 'Please answer', attachments: [], type: 'message' } } as AgentCommand;
  return { session, item, prompt, execute, config, spawn };
}

it('starts and answers before optional reads begin, even if none of them resolve', async () => {
  const f = await fixture();
  await f.session.start();
  expect(f.execute).not.toHaveBeenCalled();
  expect(await f.session.deliver(f.item, [])).toMatchObject({ text: 'The answer' });
  expect(f.execute).toHaveBeenCalledWith('getAgentConfiguration', expect.anything());
  expect(f.session.resources.read()).toMatchObject({ status: { configuration: 'loading', grants: 'loading' } });
  expect(f.prompt.mock.calls[0]?.[1]).toContain('the agent default');
  await f.session.dispose();
});

it('an optional home/skills setup that never resolves cannot hold the answer', async () => {
  const f = await fixture();
  f.execute.mockImplementation(() => Promise.resolve({ commands: [], yoloMode: false, isReviewer: true }));
  await f.session.start();
  expect(await f.session.deliver(f.item, [])).toMatchObject({ text: 'The answer' });
  const { prepareRoomAgentHome } = await import('./agent-home.js');
  expect(prepareRoomAgentHome).not.toHaveBeenCalled();
  void f.session.resources.prepare();
  await vi.waitFor(() => expect(prepareRoomAgentHome).toHaveBeenCalled());
  await f.session.dispose();
});

it('answers from a fresh private home when the configured home is a file', async () => {
  const f = await fixture();
  await writeFile(f.config.agentHomeRoot!, 'not a directory');
  await f.session.start();
  const home = f.spawn.mock.calls[0]![0].agentEnv!.HOME!;
  roots.push(dirname(home));
  expect(home).not.toBe(f.config.operatorHome);
  expect(home).not.toContain(f.config.agentHomeRoot!);
  expect(await f.session.deliver(f.item, [])).toMatchObject({ text: 'The answer' });
  expect(f.prompt.mock.calls[0]?.[1]).toContain('Private home setup failed');
  expect(f.prompt.mock.calls[0]?.[1]).toContain('fresh private home');
  await f.session.dispose();
});

it('discloses an unavailable cached paid model and uses the advertised agent default', async () => {
  const f = await fixture();
  f.session.resources.context.configuration = { model: 'unavailable-paid-model', commands: [], yoloMode: false, isReviewer: true,
    soul: { name: 'Reviewer', instructions: 'Review carefully.' } };
  await f.session.start();
  await f.session.deliver(f.item, []);
  expect(f.prompt.mock.calls[0]?.[1]).toContain('Selected model unavailable-paid-model is unavailable; this session runs with default-model');
  expect(f.session.client?.sessionNew).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: expect.stringContaining('Review carefully.') }));
  await f.session.dispose();
});

it('does not pass an unverified retired model to a native launch before it can fall back', async () => {
  const f = await fixture();
  f.config.agentKind = 'grok';
  f.config.agentArgs = ['agent', '--model', 'retired-paid-model', 'stdio'];
  f.config.modelSelection = { model: 'retired-paid-model' };
  await f.session.start();
  expect(f.spawn.mock.calls[0]?.[0].agentArgs).toEqual(['agent', 'stdio']);
  await f.session.deliver(f.item, []);
  expect(f.prompt.mock.calls[0]?.[1]).toContain('Selected model retired-paid-model is unavailable');
  await f.session.dispose();
});

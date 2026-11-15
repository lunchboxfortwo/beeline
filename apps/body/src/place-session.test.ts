import type { AgentCommand } from '@beeline/api-contract/daemon';
import { EventEmitter } from 'node:events';
import { mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname,join } from 'node:path';
import { afterEach,expect,it,vi } from 'vitest';
import type { AcpClient } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { freeAgentPiConfig } from './free-agent-vm.js';
import { PlaceSession } from './place-session.js';
import { sharedSquireMcpClient } from './squire-mcp-client.js';
import type { AgentRuntimeRecord } from './runtime.js';
import { execFileAsync,prepareWorkspace } from './workspace-checkout.js';

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
vi.mock('./squire-mcp-client.js', async original => ({
  ...await original<typeof import('./squire-mcp-client.js')>(),
  sharedSquireMcpClient: vi.fn(),
}));
const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });

async function fixture(corner = false) {
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
    config, api: { baseUrl: 'https://synthetic.test', execute, refreshMachineVault: async () => {}, connection: () => ({ baseUrl: 'http://localhost', daemonToken: 'fixture', agentId: 'a'.repeat(64), helperVersion: 'test' }) } as unknown as DaemonApiClient,
    placeId: 'room', ...(corner ? { parentRoomId: 'parent' } : {}), workspaceId: 'workspace', onExit() {}, createAcpClient: spawn,
  });
  const item = { id: 'item', rootCommandId: 'task', roomId: 'room', returnRoomId: 'room', turnRequestId: 'item', reason: 'human_tag',
    agentId: 'a'.repeat(64),
    source: { id: 'message', authorId: 'human', body: 'Please answer', attachments: [], type: 'message' } } as AgentCommand;
  return { session, item, prompt, execute, config, spawn, client };
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

it('discovers and calls Squire in the same cold session without a Registry installation', async () => {
  const requestMcp = vi.fn(async (method: string) => method === 'tools/list'
    ? { tools: [{ name: 'list_credentials', inputSchema: { type: 'object' } }] }
    : { content: [{ type: 'text', text: '{"credentials":[]}' }] });
  vi.mocked(sharedSquireMcpClient).mockReturnValue({ requestMcp, close() {} } as never);
  const f = await fixture();
  try {
    await f.session.start();
    expect(sharedSquireMcpClient).not.toHaveBeenCalled();
    f.execute.mockImplementation((name: string) => name === 'authorizeResourceCall'
      ? Promise.resolve({ allowed: true }) : new Promise(() => {}));
    // The live request remains the authority for tools; optional config can
    // stay pending, including its Registry routes and grants.
    f.prompt.mockImplementation(async () => {
      const turn = { roomId: f.item.roomId, requestId: f.item.turnRequestId };
      expect(await f.session.resources.mcp({ app: 'registry-mcp:squire' }, turn))
        .toEqual({ tools: [{ name: 'list_credentials', inputSchema: { type: 'object' } }] });
      expect(await f.session.resources.mcp({ app: 'registry-mcp:squire', tool: 'list_credentials', args: { fields: 'summary' } }, turn))
        .toEqual({ content: [{ type: 'text', text: '{"credentials":[]}' }] });
      return { agentText: 'The answer', stopReason: 'end_turn', updates: [], toolCalls: [] };
    });
    await f.session.deliver(f.item, []);
    expect(f.execute).toHaveBeenCalledWith('authorizeResourceCall', expect.objectContaining({ target: 'squire', requestId: f.item.turnRequestId }));
    expect(requestMcp).toHaveBeenCalledWith('tools/call', { name: 'list_credentials', arguments: { fields: 'summary' } });
    f.execute.mockImplementation((name: string) => name === 'authorizeResourceCall'
      ? Promise.resolve({ allowed: false }) : new Promise(() => {}));
    f.prompt.mockImplementation(async () => {
      await expect(f.session.resources.mcp({ app: 'registry-mcp:squire', tool: 'list_credentials' },
        { roomId: f.item.roomId, requestId: f.item.turnRequestId })).rejects.toThrow('not authorized');
      return { agentText: 'Refused', stopReason: 'end_turn', updates: [], toolCalls: [] };
    });
    await f.session.deliver(f.item, []);
    expect(requestMcp.mock.calls.filter(([method]) => method === 'tools/call')).toHaveLength(1);
  } finally {
    await f.session.dispose();
    vi.mocked(sharedSquireMcpClient).mockClear();
  }
});

it('allows an unchanged automatic attention wake to finish without repeating a status', async () => {
  const f = await fixture();
  await f.session.start();
  await f.session.deliver({ ...f.item, reason: 'attention_report' });
  expect(f.prompt.mock.calls[0]![1]).toContain('If nothing has changed or needs action, call no_reply_needed');
  expect(f.prompt.mock.calls[0]![1]).toContain('Human requests in this batch still need an answer.');
  await f.session.dispose();
});

it('keeps a cold repository corner able to check out and push after session context loads', async () => {
  const f = await fixture(true);
  const source = join(f.config.workspaceRoot!, 'source');
  await mkdir(source);
  await execFileAsync('git', ['init', '--initial-branch=main', source]);
  await writeFile(join(source, 'README.md'), 'repository contents\n');
  await execFileAsync('git', ['-C', source, 'add', 'README.md']);
  await execFileAsync('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'Initial']);
  const remote = join(f.config.workspaceRoot!, 'remote.git');
  await execFileAsync('git', ['clone', '--bare', source, remote]);
  const repository = { resolution: 'repository', key: 'owner/repo', remote: `file://${remote}`, targetBranch: 'main' };
  const restore = { featureBranch: 'feature/corner-room', lifecycle: {} };
  f.execute.mockImplementation(name => {
    if (name === 'getRoomRepositoryState') return Promise.resolve(repository);
    if (name === 'getCornerRestoreState') return Promise.resolve(restore);
    if (name === 'postCornerRemoteState') return Promise.resolve({});
    return new Promise(() => {});
  });
  await f.session.start();
  expect(f.execute).not.toHaveBeenCalled();
  await f.session.deliver(f.item, []);
  await vi.waitFor(() => expect(f.session.resources.read()).toMatchObject({ repository, restore }));
  const systemPrompt = vi.mocked(f.session.client!.sessionNew).mock.calls[0]![0].systemPrompt!;
  expect(systemPrompt).not.toContain('repo-less corner');
  expect(systemPrompt).not.toContain('Do not initialize a repository');
  expect(systemPrompt).toContain('workspace');
  expect(systemPrompt).toContain('any agent in this corner may commit, push and open a pull request');
  const ready = await prepareWorkspace({ api: f.session.options.api, config: f.config,
    supervisorRoot: f.session.options.runtime.supervisorRoot, workspaceId: 'workspace',
    agent: f.session.options.agent, placeId: 'room', parentRoomId: 'parent' });
  const checkout = f.session.folder();
  expect(ready).toContain(`Checkout ready at ${checkout} on branch feature/corner-room`);
  expect(await readFile(join(checkout, 'README.md'), 'utf8')).toBe('repository contents\n');
  await writeFile(join(checkout, 'proof.txt'), 'corner edit\n');
  await execFileAsync('git', ['-C', checkout, 'add', 'proof.txt']);
  await execFileAsync('git', ['-C', checkout, 'commit', '-m', 'Prove corner edits']);
  await execFileAsync('git', ['-C', checkout, 'push', 'origin', 'HEAD:refs/heads/proof-corner-checkout']);
  const pushed = await execFileAsync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/proof-corner-checkout']);
  const head = await execFileAsync('git', ['-C', checkout, 'rev-parse', 'HEAD']);
  expect(pushed.stdout).toBe(head.stdout);
  await f.session.dispose();
});

it('does not tell a cold Room that its repository is missing before the read completes', async () => {
  const f = await fixture();
  await f.session.start();
  const systemPrompt = vi.mocked(f.session.client!.sessionNew).mock.calls[0]![0].systemPrompt!;
  expect(systemPrompt).not.toContain('This Beeline Room has no linked repository');
  expect(systemPrompt).toContain('workspace');
  expect(f.execute).not.toHaveBeenCalled();
  await f.session.dispose();
});

it.each([false, true])('does not treat an unverified repository as absent (corner=%s)', async corner => {
  const f = await fixture(corner);
  f.session.resources.context.repository = { resolution: 'unverified' };
  await f.session.start();
  const systemPrompt = vi.mocked(f.session.client!.sessionNew).mock.calls[0]![0].systemPrompt!;
  expect(systemPrompt).not.toContain('This Beeline Room has no linked repository');
  expect(systemPrompt).not.toContain('This is a repo-less corner');
  expect(systemPrompt).toContain('workspace');
  await f.session.dispose();
});

it('replaces a native conversation when its repository instructions change', async () => {
  const f = await fixture(true);
  f.config.agentBinary = 'codex-acp';
  const original = f.spawn.getMockImplementation()!;
  const load = vi.fn(async () => ({ sessionId: 'previous' }));
  f.spawn.mockImplementation(options => Object.assign(original(options), {
    canLoadSession: () => true, sessionLoad: load,
  }));
  f.session.resources.context.repository = { resolution: 'none' };
  await f.session.start();
  expect(f.session.client!.sessionNew).toHaveBeenCalledWith(expect.objectContaining({
    systemPrompt: expect.stringContaining('This is a repo-less corner'),
  }));
  await f.session.stop();
  await f.session.start();
  expect(load).toHaveBeenCalledTimes(1);
  await f.session.stop();
  f.session.resources.context.repository = { resolution: 'repository', key: 'owner/repo', targetBranch: 'main' };
  await f.session.start();
  expect(load).toHaveBeenCalledTimes(1);
  expect(f.session.client!.sessionNew).toHaveBeenLastCalledWith(expect.objectContaining({
    systemPrompt: expect.stringContaining('any agent in this corner may commit, push and open a pull request'),
  }));
  await f.session.dispose();
});

it('delivers a frozen reply pointer without waiting for a parent-message read', async () => {
  const f = await fixture();
  f.item.source.replyToMessageId = 'parent-message';
  await f.session.start();
  expect(await f.session.deliver(f.item, [])).toMatchObject({ text: 'The answer' });
  expect(f.prompt.mock.calls[0]?.[1]).toContain('Reply to message parent-message; read it with session tools if needed.');
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
  expect(f.prompt.mock.calls[0]?.[1]).toContain('Selected model unavailable-paid-model is unavailable at startup; this session runs with default-model');
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

it('returns the successful public answer before a model cleanup error', async () => {
  const f=await fixture();
  await f.session.start();
  const revoke=vi.fn(()=>{throw new Error('cleanup EACCES');});
  (f.session as unknown as {hostedModel:()=>Promise<unknown>}).hostedModel=async()=>({
    paths:()=>({directory:'/fixture'}),revoke,
  });
  const answer=await f.session.deliver(f.item,[]);
  expect(answer.text).toBe('The answer');
  expect(f.prompt).toHaveBeenCalledTimes(1);
  expect(revoke).not.toHaveBeenCalled();
  await expect(answer.cleanup()).rejects.toThrow('cleanup EACCES');
  expect(answer.text).toBe('The answer');
  await f.session.dispose();
});

it('starts and answers without awaiting an optional model setter', async () => {
  const f=await fixture();
  f.config.modelSelection={model:'default-model'};
  const setter=vi.fn(()=>new Promise(()=>{}));
  const original=f.spawn.getMockImplementation()!;
  f.spawn.mockImplementation((options)=>Object.assign(original(options),{setConfigOption:setter}));
  await f.session.start();
  expect((await f.session.deliver(f.item,[])).text).toBe('The answer');
  expect(setter).not.toHaveBeenCalled();
  expect(f.prompt).toHaveBeenCalledTimes(1);
  await f.session.dispose();
});

it('delivers an 18-hour offline backlog as one prompt without requiring steering', async () => {
  const f = await fixture();
  const offlineSeconds = 18 * 3600;
  const tags = [1, 2, 3].map(n => ({ ...f.item, id: `tag-${n}`, turnRequestId: `tag-${n}`, offlineSeconds,
    source: { ...f.item.source, id: `tag-source-${n}`, authorId: `asker-${n}`, body: `question ${n}` } }));
  const runs = Array.from({ length: 25 }, (_, n) => ({ ...f.item, id: `run-${n}`, turnRequestId: `run-${n}`,
    offlineSeconds, reason: 'schedule', scheduleId: 'daily-check',
    source: { ...f.item.source, id: `run-source-${n}`, body: `scheduled run ${n}` } }));
  const batch = [...tags, ...runs];
  await f.session.start();
  await f.session.deliver(tags[0]!, batch);
  expect(f.prompt).toHaveBeenCalledTimes(1);
  const prompt = f.prompt.mock.calls[0]![1];
  expect(prompt).toContain('> You were offline for 18 h. These arrived while you were away and may be outdated.');
  for (let n = 1; n <= 3; n++) expect(prompt).toContain(`asker-${n}: question ${n}`);
  expect(prompt.match(/scheduled run/g)).toHaveLength(1);
  expect(prompt).toContain('scheduled run 24');
  expect(prompt).toContain('Answer each asker in one combined reply.');
  await f.session.dispose();
});

it('opens a fresh hosted ACP session with provider configuration and the queue credential already present', async () => {
  const f = await fixture();
  f.config.agentKind = 'pi';
  f.config.agentEnv.BEELINE_FREE_AGENT_MODEL_TOKEN = 'legacy-bootstrap-marker';
  const operatorModels = join(f.config.operatorHome!, '.pi', 'agent');
  await mkdir(operatorModels, { recursive: true });
  await writeFile(join(operatorModels, 'models.json'), freeAgentPiConfig({
    modelBaseUrl: 'https://synthetic.test/v1/free-agents/model', upstreamModel: 'synthetic/model',
  }));
  const modelCredential = { v: 1 as const, token: 'bfmc_v1.' + 'a'.repeat(32) + '.' + 'b'.repeat(64), expiresAt: null };
  f.client.sessionNew.mockImplementation(async () => {
    const environment = f.spawn.mock.calls[0]![0].agentEnv!;
    const modelConfig = JSON.parse(await readFile(join(environment.PI_CODING_AGENT_DIR!, 'models.json'), 'utf8'));
    expect(modelConfig.providers.beeline.apiKey).toBeTruthy();
    const active = JSON.parse(await readFile(f.session.contextPath, 'utf8'));
    expect(active.itemId).toBe(f.item.id);
    const auth = JSON.parse(await readFile(join(active.ownedModelDirectory, 'credential.json'), 'utf8'));
    expect(auth.credential).toEqual(modelCredential);
    return { sessionId: 'live', raw: { configOptions: [] } };
  });
  try {
    await f.session.start({ ...f.item, modelCredential });
    expect(await f.session.deliver({ ...f.item, modelCredential })).toMatchObject({ text: 'The answer' });
    expect(f.execute.mock.calls.some(([name]) => name === 'getModelCredential')).toBe(false);
  } finally { await f.session.dispose(); }
});

it('rejects a hosted item without its credential before launching ACP', async () => {
  const f = await fixture();
  f.config.agentEnv.BEELINE_FREE_AGENT_MODEL_TOKEN = 'legacy-bootstrap-marker';
  await expect(f.session.start(f.item)).rejects.toThrow('Owned model local intent is unavailable');
  expect(f.spawn).not.toHaveBeenCalled();
  await f.session.dispose();
});

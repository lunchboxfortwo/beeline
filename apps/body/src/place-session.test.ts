import type { AgentCommand } from '@beeline/api-contract/daemon';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname,join } from 'node:path';
import { OwnedModelFiles } from './owned-model-files.js';
import { afterEach,expect,it,vi } from 'vitest';
import type { AcpClient } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { installCornerGitHubWrappers } from './corner-github-auth.js';
import { GrantCommandRunner } from './grant-runner.js';
import { readGrantScript } from './read-only-mcp-agent-grant-deps.js';
import { parseCommandGrantTarget } from '@beeline/api-contract/agent-grants';
import { freeAgentPiConfig } from './free-agent-vm.js';
import { PlaceSession } from './place-session.js';
import { distillTurnFailureReason } from './turn-failure-reason.js';
import { sharedSquireMcpClient } from './squire-mcp-client.js';
import type { AgentRuntimeRecord } from './runtime.js';
import { execFileAsync,prepareWorkspace } from './workspace-checkout.js';
import { testTmpDir } from '../../../packages/test-helpers/helpers/helper.js';
// Cache persistence is tested with real files by SessionResources. These
// prompt tests intentionally finish while optional background work is pending.
vi.mock('./atomic-private-file.js', async original => {
  const actual = await original<typeof import('./atomic-private-file.js')>();
  return { ...actual, writePrivateFileAtomically: vi.fn(async (path: string, contents: string) => {
    if (!path.endsWith('/session-context.json')) await actual.writePrivateFileAtomically(path, contents);
  }) };
});
vi.mock('./agent-home.js', async original => ({
  ...await original<typeof import('./agent-home.js')>(),
  prepareRoomAgentHome: vi.fn(() => new Promise(() => {})),
}));
vi.mock('./squire-mcp-client.js', async original => ({
  ...await original<typeof import('./squire-mcp-client.js')>(),
  sharedSquireMcpClient: vi.fn(),
}));
const pendingRead = (name: string) => name === 'listRoomCorners' ? Promise.resolve({ corners: [] }) : new Promise(() => {});
const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });

async function fixture(corner = false, temporaryRoot = tmpdir()) {
  const root = await mkdtemp(join(temporaryRoot, 'session-start-')); roots.push(root);
  let delivered = false;
  const prompt = vi.fn(async () => { delivered = true; return { agentText: 'The answer', stopReason: 'end_turn', updates: [], toolCalls: [] }; });
  const client = Object.assign(new EventEmitter(), {
    isAlive: true, startProcess: vi.fn(async () => {}), stopProcess: vi.fn(async () => {}),
    sessionNew: vi.fn(async () => ({ sessionId: 'live', raw: { configOptions: [
      { id: 'model', category: 'model', currentValue: 'default-model', options: [{ value: 'default-model' }] },
    ] } })), sessionPrompt: prompt, canLoadSession: () => false, canPromptWithImages: () => false,
  });
  const execute = vi.fn((name: string) => {
    if (name.startsWith('get') || name === 'listAgentGrants') expect(delivered).toBe(true);
    return pendingRead(name);
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
it('rewrites pruned-release git/gh launchers before reusing a retained thread', async () => {
  const f = await fixture(true);
  const root = f.config.workspaceRoot!;
  const entry = 'lib/beeline/beeline-cli.mjs';
  const missing = join(root, 'lib/beeline-releases/pruned', entry);
  const stable = join(root, 'lib/beeline', entry);
  await mkdir(dirname(stable), { recursive: true });
  await writeFile(stable, "process.stdout.write('fixture-token');");
  const originalEntrypoint = process.argv[1];
  process.argv[1] = missing;
  f.config.runtimeConfigPath = join(root, 'runtime.json');
  f.config.agentEnv.PATH = '/usr/bin:/bin';
  try {
    await f.session.start();
    const home = f.config.agentHomeRoot!;
    await installCornerGitHubWrappers({ root: home, runtimeConfigPath: f.config.runtimeConfigPath,
      roomId: 'parent', cornerId: 'room', cliEntrypoint: stable, gitBinary: '/usr/bin/git', ghBinary: '/usr/bin/gh',
      featureBranch: 'feature/corner-room', targetBranch: 'main' });
    // Reproduce launchers written by the old generator, before release pruning.
    for (const name of ['git', 'gh']) {
      const path = join(home, 'beeline-github-bin', name);
      await writeFile(path, (await readFile(path, 'utf8')).replace(stable, missing));
    }
    const gh = join(home, 'beeline-github-bin/gh');
    const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state') };
    await expect(execFileAsync(process.execPath, [gh, 'auth', 'token'], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('MODULE_NOT_FOUND'),
    });
    await f.session.start();
    expect(f.spawn).toHaveBeenCalledTimes(1);
    for (const name of ['git', 'gh']) {
      const source = await readFile(join(home, 'beeline-github-bin', name), 'utf8');
      expect(source).toContain(stable);
      expect(source).not.toContain(missing);
    }
    expect(await readFile(gh, 'utf8')).toContain('"command":"/usr/bin/gh"');
    const expected = await execFileAsync('/usr/bin/gh', ['--version'], { env });
    expect((await execFileAsync(process.execPath, [gh, '--version'], { env })).stdout).toBe(expected.stdout);
    expect((await execFileAsync(process.execPath, [gh, 'auth', 'token'], { env })).stdout.trim()).toBe('fixture-token');
  } finally {
    process.argv[1] = originalEntrypoint;
    await f.session.dispose();
  }
});
it('answers after thread reconciliation while other optional reads remain pending', async () => {
  const f = await fixture();
  await f.session.start();
  expect(f.execute).not.toHaveBeenCalled();
  const item = { ...f.item, source: { ...f.item.source,
    institutionalContext: '- Procedure buy-for-wife (read facet:procedure): Buy through the Japanese proxy' } };
  f.prompt.mockResolvedValueOnce({ agentText: 'The answer', stopReason: 'end_turn', updates: [], toolCalls: [],
    tokenUsage: { inputTokens: 9, outputTokens: 2 } } as never);
  expect(await f.session.deliver(item, [])).toMatchObject({ text: 'The answer', tokenUsage: { inputTokens: 9, outputTokens: 2 } });
  expect(f.prompt.mock.calls[0]?.[1]).toContain('Procedure buy-for-wife');
  expect(f.execute).toHaveBeenCalledWith('getAgentConfiguration', expect.anything());
  expect(f.session.resources.read()).toMatchObject({ status: { configuration: 'loading', grants: 'loading' } });
  expect(f.prompt.mock.calls[0]?.[1]).toContain('the agent default');
  await f.session.dispose();
});

it.each([false, true])('keeps the operator Pi login out of the live session (thread=%s)', async corner => {
  const f = await fixture(corner);
  f.config.operatorHome = await mkdtemp(`${testTmpDir()}/session-login-operator-`); roots.push(f.config.operatorHome);
  const loginDir = join(f.config.operatorHome!, '.pi', 'agent');
  await mkdir(loginDir, { recursive: true });
  const login = JSON.stringify({ anthropic: { type: 'oauth', refresh: 'operator-refresh' } });
  await writeFile(join(loginDir, 'auth.json'), login);
  f.config.agentKind = 'pi';
  f.config.bwrapPath = '/usr/bin/bwrap';
  try {
    await f.session.start();
    const launch = f.spawn.mock.calls[0]![0];
    const commandIndex = launch.agentArgs!.lastIndexOf(launch.harnessCommand!);
    expect(commandIndex).toBeGreaterThan(0);
    await execFileAsync(launch.agentCommand, [...launch.agentArgs!.slice(0, commandIndex), process.execPath, '-e', `
      const fs = require('node:fs');
      const assert = require('node:assert/strict');
      assert.equal(fs.existsSync(process.env.PI_CODING_AGENT_DIR + '/auth.json'), false);
      // The masked operator login is neither readable nor writable here.
      const operatorLogin = ${JSON.stringify(join(loginDir, 'auth.json'))};
      let seen = '';
      try { seen = fs.readFileSync(operatorLogin, 'utf8'); } catch {}
      assert.equal(seen.includes('operator-refresh'), false);
      assert.throws(() => fs.writeFileSync(operatorLogin, 'escape'));
    `], { env: { ...process.env, ...launch.agentEnv } });
    expect(await readFile(join(loginDir, 'auth.json'), 'utf8')).toBe(login);
    expect(JSON.stringify(launch.agentEnv)).not.toContain('operator-refresh');
  } finally { await f.session.dispose(); }
});

it('delivers report audience names from the queue with only people in the roster', async () => {
  const f = await fixture();
  f.session.resources.context.roster = { members: [
    { identityId: 'worker', kind: 'agent', name: 'Jellybean', role: 'member' },
  ] };
  try {
    await f.session.start();
    const report: AgentCommand = { ...f.item, reason: 'report',
      roomName: 'fast-source-setup', returnRoomId: 'owner-room', returnRoomName: 'Milo',
      source: { ...f.item.source, authorId: 'worker', body: 'The work is ready.' },
    };
    await f.session.deliver(report);
    const prompt = f.prompt.mock.calls[0]![1];
    expect(prompt).toContain(`From: Jellybean in #fast-source-setup\nid: ${report.id}\nReply needed: false\ntext: The work is ready.`);
    expect(prompt).not.toContain('Reply(id:');
    // Offline delivery uses each item's own names, not the session's roster.
    await f.session.deliver({ ...report, offlineSeconds: 60 });
    expect(f.prompt.mock.calls[1]![1]).toContain('From: Jellybean in #');
    await f.session.deliver({ ...report, reason: 'order' });
    expect(f.prompt.mock.calls[2]![1]).toContain(`Reply needed: true\ntext: The work is ready.\nReply(id: ${report.id}, text: ...) with your reply`);
  } finally {
    await f.session.dispose();
  }
});

it('does not restore a streamed preamble after ACP selects no final answer', async () => {
  const f = await fixture();
  await f.session.start();
  f.prompt.mockImplementation(async (_sessionId?: unknown, _prompt?: unknown, onChunk?: unknown) => {
    (onChunk as (delta: string, full: string, run: string) => void)('Gathering data', 'Gathering data', 'Gathering data');
    return {agentText:'',stopReason:'end_turn',updates:[],toolCalls:[]};
  });
  expect(await f.session.deliver(f.item)).toMatchObject({text:'',stopReason:'end_turn'});
  await f.session.dispose();
});

it('fails a Codex turn whose whole reply is the proxy signed-out refusal, so the sign-in card shows', async () => {
  const f = await fixture();
  await f.session.start();
  const refusal = 'unknown provider for model gpt-6.1-sol';
  f.prompt.mockImplementationOnce(async (_sessionId?: unknown, _prompt?: unknown, onChunk?: unknown) => {
    (onChunk as (delta: string, full: string, run: string) => void)(refusal, refusal, refusal);
    return { agentText: `${refusal}  `, stopReason: 'end_turn', updates: [], toolCalls: [] };
  });
  const failure = await f.session.deliver(f.item).catch((error: unknown) => error);
  expect(failure).toMatchObject({ name: 'WallRefusal', kind: 'signed-in' });
  expect(distillTurnFailureReason(failure)).toEqual({ text: 'Authentication required: the agent needs to sign in again', kind: 'not-signed-in' });
  // An answer that only mentions the refusal is still an answer.
  const quoted = `The proxy said "${refusal}", so I switched models.`;
  f.prompt.mockResolvedValueOnce({ agentText: quoted, stopReason: 'end_turn', updates: [], toolCalls: [] });
  expect(await f.session.deliver({ ...f.item, id: 'second', turnRequestId: 'second' })).toMatchObject({ text: quoted });
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
      ? Promise.resolve({ allowed: true }) : pendingRead(name));
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
    expect(f.prompt.mock.calls[0]?.[1]).not.toContain('Trusty Squire tools are available');
    expect(f.prompt.mock.calls[0]?.[1]).toContain('Trusty Squire uses app_tool(app:"registry-mcp:squire")');
    expect(f.execute).toHaveBeenCalledWith('authorizeResourceCall', expect.objectContaining({ target: 'squire', requestId: f.item.turnRequestId }));
    expect(requestMcp).toHaveBeenCalledWith('tools/call', { name: 'list_credentials', arguments: { fields: 'summary' } });
    f.execute.mockImplementation((name: string) => name === 'authorizeResourceCall'
      ? Promise.resolve({ allowed: false }) : pendingRead(name));
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
  expect(f.prompt.mock.calls[0]![1]).toContain('Reply needed: false');
  expect(f.prompt.mock.calls[0]![1]).not.toContain('Reply(id:');
  await f.session.dispose();
});

it('keeps a cold repository thread able to check out and push after session context loads', async () => {
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
    return pendingRead(name);
  });
  await f.session.start();
  expect(f.execute).not.toHaveBeenCalled();
  await f.session.deliver(f.item, []);
  await vi.waitFor(() => expect(f.session.resources.read()).toMatchObject({ repository, restore }));
  const systemPrompt = vi.mocked(f.session.client!.sessionNew).mock.calls[0]![0].systemPrompt!;
  expect(systemPrompt).not.toContain('repo-less thread');
  expect(systemPrompt).not.toContain('Do not initialize a repository');
  expect(systemPrompt).toContain('workspace');
  expect(systemPrompt).toContain('Implementer rules: the rules below');
  const ready = await prepareWorkspace({ api: f.session.options.api, config: f.config,
    supervisorRoot: f.session.options.runtime.supervisorRoot, workspaceId: 'workspace',
    agent: f.session.options.agent, placeId: 'room', parentRoomId: 'parent' });
  const checkout = f.session.folder();
  expect(ready).toContain(`Checkout ready at ${checkout} on branch feature/corner-room`);
  expect(await readFile(join(checkout, 'README.md'), 'utf8')).toBe('repository contents\n');
  await writeFile(join(checkout, 'proof.txt'), 'thread edit\n');
  await execFileAsync('git', ['-C', checkout, 'add', 'proof.txt']);
  await execFileAsync('git', ['-C', checkout, 'commit', '-m', 'Prove thread edits']);
  await execFileAsync('git', ['-C', checkout, 'push', 'origin', 'HEAD:refs/heads/proof-corner-checkout']);
  const pushed = await execFileAsync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/proof-corner-checkout']);
  const head = await execFileAsync('git', ['-C', checkout, 'rev-parse', 'HEAD']);
  expect(pushed.stdout).toBe(head.stdout);
  await f.session.dispose();
});

it('does not tell a cold chat that its repository is missing before the read completes', async () => {
  const f = await fixture();
  await f.session.start();
  const systemPrompt = vi.mocked(f.session.client!.sessionNew).mock.calls[0]![0].systemPrompt!;
  expect(systemPrompt).not.toContain('This Beeline chat has no linked repository');
  expect(systemPrompt).toContain('workspace');
  expect(f.execute).not.toHaveBeenCalled();
  await f.session.dispose();
});

it.each([false, true])('does not treat an unverified repository as absent (thread=%s)', async corner => {
  const f = await fixture(corner);
  f.session.resources.context.repository = { resolution: 'unverified' };
  await f.session.start();
  const systemPrompt = vi.mocked(f.session.client!.sessionNew).mock.calls[0]![0].systemPrompt!;
  expect(systemPrompt).not.toContain('This Beeline chat has no linked repository');
  expect(systemPrompt).not.toContain('This is a repo-less thread');
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
    systemPrompt: expect.stringContaining('This is a repo-less thread'),
  }));
  await f.session.stop();
  await f.session.start();
  expect(load).toHaveBeenCalledTimes(1);
  await f.session.stop();
  f.session.resources.context.repository = { resolution: 'repository', key: 'owner/repo', targetBranch: 'main' };
  await f.session.start();
  expect(load).toHaveBeenCalledTimes(1);
  expect(f.session.client!.sessionNew).toHaveBeenLastCalledWith(expect.objectContaining({
    systemPrompt: expect.stringContaining('Implementer rules: the rules below'),
  }));
  await f.session.dispose();
});

it('delivers a frozen reply pointer without waiting for a parent-message read', async () => {
  const f = await fixture();
  f.item.source.replyToMessageId = 'parent-message';
  await f.session.start();
  expect(await f.session.deliver(f.item, [])).toMatchObject({ text: 'The answer' });
  expect(f.prompt.mock.calls[0]?.[1]).toContain('In reply to message parent-message');
  await f.session.dispose();
});

it('an optional home/skills setup that never resolves cannot hold the answer', async () => {
  const f = await fixture();
  f.execute.mockImplementation(name => Promise.resolve(name === 'listRoomCorners' ? { corners: [] } : { commands: [], yoloMode: false, isReviewer: true }));
  await f.session.start();
  expect(await f.session.deliver(f.item, [])).toMatchObject({ text: 'The answer' });
  const { prepareRoomAgentHome } = await import('./agent-home.js');
  expect(prepareRoomAgentHome).not.toHaveBeenCalled();
  void f.session.resources.prepare();
  await vi.waitFor(() => expect(prepareRoomAgentHome).toHaveBeenCalled());
  await f.session.dispose();
});

it('session prepare makes the Room checkout before it reports setup ready', async () => {
  const f = await fixture();
  const root = f.config.workspaceRoot!;
  const source = join(root, 'source');
  await execFileAsync('git', ['init', '--initial-branch=main', source]);
  await writeFile(join(source, 'README.md'), 'Room repository contents');
  await execFileAsync('git', ['-C', source, 'add', 'README.md']);
  await execFileAsync('git', ['-C', source, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-m', 'initial']);
  const repository = { resolution: 'repository', key: 'owner/repo', remote: `file://${source}`, targetBranch: 'main' };
  f.execute.mockImplementation(name => name === 'getRoomRepositoryState' ? Promise.resolve(repository) : pendingRead(name));
  const { prepareRoomAgentHome } = await import('./agent-home.js');
  vi.mocked(prepareRoomAgentHome).mockResolvedValueOnce({});
  await f.session.resources.prepare();
  const { status } = f.session.resources.read() as { status: Record<string, string> };
  expect(status.setup).toBe('ready');
  const path = /Checkout ready at (\S+) on main \(read-only\)/.exec(status.checkout ?? '')?.[1];
  expect(path).toBeDefined();
  expect(await readFile(join(path!, 'README.md'), 'utf8')).toBe('Room repository contents');
  await f.session.dispose();
});

it('session prepare reports a failed checkout instead of setup ready', async () => {
  const f = await fixture();
  const repository = { resolution: 'repository', key: 'owner/missing', remote: `file://${join(f.config.workspaceRoot!, 'missing')}`, targetBranch: 'main' };
  f.execute.mockImplementation(name => name === 'getRoomRepositoryState' ? Promise.resolve(repository) : pendingRead(name));
  const { prepareRoomAgentHome } = await import('./agent-home.js');
  vi.mocked(prepareRoomAgentHome).mockResolvedValueOnce({});
  await expect(f.session.resources.prepare()).rejects.toThrow();
  const { status } = f.session.resources.read() as { status: Record<string, string> };
  expect(status.setup).not.toBe('ready');
  expect(status.setup).toContain('missing');
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

it('discloses a chosen model absent from a cold pi session’s fresh catalog and uses its default', async () => {
  const f = await fixture();
  f.config.agentKind = 'pi';
  const setter = vi.fn();
  Object.assign(f.client, { setConfigOption: setter });
  f.session.resources.context.configuration = { model: 'unavailable-paid-model', commands: [], yoloMode: false, isReviewer: true,
    soul: { name: 'Reviewer', instructions: 'Review carefully.' } };
  await f.session.start();
  await f.session.deliver(f.item, []);
  expect(setter).not.toHaveBeenCalled();
  expect(f.prompt.mock.calls[0]?.[1]).toContain('Selected model unavailable-paid-model is unavailable at startup; this session runs with default-model');
  expect(f.session.client?.sessionNew).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: expect.stringContaining('Review carefully.') }));
  await f.session.dispose();
});

it('switches a cold pi session to its chosen model from the fresh catalog before its first prompt', async () => {
  const f = await fixture();
  f.config.agentKind = 'pi';
  f.config.modelSelection = { model: 'grunt/grunt' };
  expect(f.session.resources.context.modelCatalog).toBeUndefined();
  const models = { id: 'model', category: 'model', currentValue: 'default-model',
    options: [{ value: 'default-model' }, { value: 'grunt/grunt' }] };
  f.client.sessionNew.mockResolvedValue({ sessionId: 'live', raw: { configOptions: [models] } });
  let finish!: () => void;
  const setter = vi.fn(async () => {
    await new Promise<void>(resolve => { finish = resolve; });
    models.currentValue = 'grunt/grunt';
    return { configOptions: [models] };
  });
  Object.assign(f.client, { setConfigOption: setter });
  const starting = f.session.start();
  await vi.waitFor(() => expect(setter).toHaveBeenCalledWith('live', 'model', 'grunt/grunt'));
  finish();
  await starting;
  expect(f.session.resources.context.modelCatalog?.find(option => option.category === 'model')?.currentValue).toBe('grunt/grunt');
  expect((await f.session.deliver(f.item, [])).text).toBe('The answer');
  expect(f.prompt.mock.calls[0]?.[1]).not.toContain('is unavailable at startup');
  expect(f.prompt.mock.calls[0]?.[1]).toContain('This session uses grunt/grunt');
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

it('Stop ends a harness that ignores session/cancel, with the tool it started, and the next item starts fresh', async () => {
  const f = await fixture();
  const pidFile = join(f.config.workspaceRoot!, 'tool.pid');
  // Answers setup, ignores session/cancel, and holds a long-running child tool.
  const harness = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
  if (request.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: {} });
  if (request.method === 'session/new') reply({ sessionId: 'fixture' });
  if (request.method === 'session/prompt') fs.writeFileSync(${JSON.stringify(pidFile)}, String(spawn('sleep', ['300']).pid));
});`;
  const { AcpClient: RealAcpClient } = await import('./acp.js');
  const clients: AcpClient[] = [];
  f.spawn.mockImplementation((options => {
    const client = new RealAcpClient({ ...options, agentCommand: process.execPath, agentArgs: ['-e', harness],
      inheritProcessEnv: false, resourceScope: 'none' });
    clients.push(client);
    return client;
  }) as never);
  await f.session.start(f.item);
  const answering = f.session.deliver(f.item, []);
  const settled = answering.then(() => 'answered', () => 'ended');
  await vi.waitFor(async () => expect(await readFile(pidFile, 'utf8').catch(() => '')).not.toBe(''));
  const toolPid = Number(await readFile(pidFile, 'utf8'));
  f.session.cancel();
  expect(await settled).toBe('ended');
  await vi.waitFor(() => expect(() => process.kill(toolPid, 0)).toThrow());
  expect(clients[0]!.isAlive).toBe(false);
  await f.session.start(f.item);
  expect(clients).toHaveLength(2);
  expect(f.session.alive).toBe(true);
  await f.session.dispose();
});

it('brings another agent\'s push into an existing thread checkout before the next turn', async () => {
  const f = await fixture(true);
  const root = f.config.workspaceRoot!;
  const git = (cwd: string, ...args: string[]) => execFileAsync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args]);
  const origin = join(root, 'origin.git'), other = join(root, 'other');
  const branch = 'feature/corner-room';
  await execFileAsync('git', ['init', '--bare', '-b', branch, origin]);
  await execFileAsync('git', ['clone', `file://${origin}`, other]);
  await git(other, 'checkout', '-b', branch);
  await git(other, 'commit', '--allow-empty', '-m', 'first');
  await git(other, 'push', 'origin', branch);
  const folder = f.session.folder();
  await mkdir(dirname(folder), { recursive: true });
  await execFileAsync('git', ['clone', '-b', branch, `file://${origin}`, folder]);
  await git(other, 'commit', '--allow-empty', '-m', 'second agent push');
  await git(other, 'push', 'origin', branch);
  await f.session.start(f.item);
  await f.session.deliver(f.item, []);
  expect((await git(folder, 'log', '-1', '--format=%s')).stdout.trim()).toBe('second agent push');
  // A failed refresh still delivers, with one line saying so.
  await git(folder, 'remote', 'set-url', 'origin', `file://${join(root, 'missing.git')}`);
  await f.session.deliver(f.item, []);
  expect(f.prompt.mock.calls[1]?.[1]).toContain(`Your branch ${branch} could not be refreshed from origin`);
  await f.session.dispose();
});

it('sends a received picture to an image-capable harness as image content, bounded per image', async () => {
  const f = await fixture();
  Object.assign(f.client, { canPromptWithImages: () => true });
  const small = Buffer.from('small-png'), large = Buffer.alloc(5 * 1024 * 1024 + 1);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(url.endsWith('large') ? large : small,
    { headers: { 'content-type': 'image/png' } })));
  try {
    await f.session.start(f.item);
    const attachments = [
      { url: 'https://synthetic.test/v1/media/small', name: 'keyboard.png', mimeType: 'image/png' },
      { url: 'https://synthetic.test/v1/media/large', name: 'scan.png', mimeType: 'image/png' },
    ];
    await f.session.deliver({ ...f.item, source: { ...f.item.source, attachments } } as AgentCommand, []);
    const sent = f.prompt.mock.calls[0]?.[1] as unknown as { type: string; text?: string; data?: string }[];
    expect(sent[0]).toMatchObject({ type: 'text', text: expect.stringContaining('keyboard.png') });
    expect(sent.slice(1)).toEqual([{ type: 'image', data: small.toString('base64'), mimeType: 'image/png' }]);
  } finally {
    vi.unstubAllGlobals();
    await f.session.dispose();
  }
});

it('mounts the CodeGraph tools and the operator host MCP routes into the session', async () => {
  const f = await fixture(true);
  f.config.agentKind = 'claude';
  f.config.codegraphCommand = '/opt/codegraph';
  await writeFile(join(f.config.operatorHome!, '.claude.json'), JSON.stringify({ mcpServers: {
    linear: { command: 'linear-mcp', args: ['--stdio'] },
  } }));
  await f.session.start(f.item);
  const servers = (f.client.sessionNew.mock.calls[0] as unknown as [{ mcpServers: { name: string; command: string; args?: string[]; env?: { name: string; value: string }[] }[] }])[0].mcpServers;
  expect(servers.find(server => server.name === 'codegraph')).toMatchObject({ command: '/opt/codegraph',
    args: ['serve', '--mcp', '--path', f.session.folder()] });
  const linear = servers.find(server => server.name === 'linear');
  expect(linear?.env).toEqual(expect.arrayContaining([{ name: 'BEELINE_RESOURCE_TARGET', value: 'linear' }]));
  await f.session.dispose();
});

it('gives a fresh session the recent window once, then only what it has not seen', async () => {
  const f = await fixture();
  const item = (id: string, delta?: string) => ({ ...f.item, id, turnRequestId: id, source: { ...f.item.source, id,
    ...(delta ? { conversationContext: delta } : {}), conversationWindow: `Window before ${id}` } }) as AgentCommand;
  await f.session.start(f.item);
  await f.session.deliver(item('one', 'Delta before one'));
  await f.session.deliver(item('two', 'Delta before two'));
  await f.session.deliver(item('three'));
  const sent = f.prompt.mock.calls.map(call => String((call as unknown[])[1]));
  expect(sent[0]).toContain('Window before one');
  expect(sent[0]).not.toContain('Delta before one');
  expect(sent[1]).toContain('Delta before two');
  expect(sent[1]).not.toContain('Window before');
  expect(sent[2]).not.toContain('Window before');
  f.session.stale = true;
  await f.session.start(f.item);
  await f.session.deliver(item('four', 'Delta before four'));
  expect(String((f.prompt.mock.calls[3] as unknown[])[1])).toContain('Window before four');
  await f.session.dispose();
});

it('applies a changed effort and Fast Mode when the selected model already runs', async () => {
  const f = await fixture();
  f.config.agentKind = 'claude';
  f.session.resources.context.configuration = { model: 'default-model', effort: 'high', fastMode: true, commands: [], yoloMode: false };
  f.client.sessionNew.mockResolvedValue({ sessionId: 'live', raw: { configOptions: [
    { id: 'model', category: 'model', currentValue: 'default-model', options: [{ value: 'default-model' }] },
    { id: 'effort', category: 'effort', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }] },
    { id: 'fast-mode', category: 'model_config', currentValue: 'off', options: [{ value: 'off' }, { value: 'on' }] },
  ] } });
  const setter = vi.fn(async () => ({}));
  Object.assign(f.client, { setConfigOption: setter });
  await f.session.start();
  await vi.waitFor(() => expect(setter).toHaveBeenCalledWith('live', 'fast-mode', 'on'));
  expect(setter).toHaveBeenCalledWith('live', 'effort', 'high');
  expect(setter).not.toHaveBeenCalledWith('live', 'model', expect.anything());
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
  for (let n = 1; n <= 3; n++) expect(prompt).toMatch(new RegExp(`^From: asker-${n} in #.+\\nid: tag-${n}\\nReply needed: (true|false)\\ntext: question ${n}$`, 'm'));
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

it('admits the hosted model journal inside the live Room sandbox across cold and warm items', async () => {
  const f = await fixture(false, testTmpDir());
  f.config.bwrapPath = '/usr/bin/bwrap';
  const modelCredential = { v: 1 as const, token: 'bfmc_v1.' + 'a'.repeat(32) + '.' + 'b'.repeat(64), expiresAt: null };
  try {
    for (const id of ['cold-tag', 'warm-tag']) {
      const item = { ...f.item, id, turnRequestId: id, modelCredential };
      await f.session.start(item);
      const launch = f.spawn.mock.calls[0]![0];
      const commandIndex = launch.agentArgs!.lastIndexOf(launch.harnessCommand!);
      const probe = `import {OwnedModelFiles} from ${JSON.stringify(new URL('./owned-model-files.ts', import.meta.url).href)};
        import {readFileSync,writeFileSync} from 'node:fs';
        const active=JSON.parse(readFileSync(process.env.BEELINE_TURN_CONTEXT_FILE,'utf8'));
        const owner=OwnedModelFiles.open(active.ownedModelDirectory);
        owner.prepareHeaders(); console.log(owner.snapshot().state);
        try {writeFileSync(process.env.BEELINE_TURN_CONTEXT_FILE,'escape');throw new Error('turn context became writable');}
        catch(error){if(error.code!=='EROFS')throw error;}`;
      const result = await execFileAsync(launch.agentCommand, [...launch.agentArgs!.slice(0, commandIndex),
        process.execPath, '--import', createRequire(import.meta.url).resolve('tsx'), '--input-type=module', '-e', probe], { env: { ...process.env, ...launch.agentEnv } });
      expect(result.stdout.trim()).toBe('unknown');
      const active = JSON.parse(await readFile(f.session.contextPath, 'utf8'));
      expect(OwnedModelFiles.open(active.ownedModelDirectory).snapshot()).toMatchObject({ state: 'unknown' });
      const answer = await f.session.deliver(item);
      void answer.cleanup();
    }
    expect(f.spawn).toHaveBeenCalledTimes(1);
  } finally { await f.session.dispose(); }
});

it('mounts Room CodeGraph at the cached workspace checkout', async () => {
  const f = await fixture();
  const root = f.config.workspaceRoot!;
  const source = join(root, 'source');
  await execFileAsync('git', ['init', '--initial-branch=main', source]);
  await writeFile(join(source, 'README.md'), 'Room repository contents');
  await execFileAsync('git', ['-C', source, 'add', 'README.md']);
  await execFileAsync('git', ['-C', source, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-m', 'initial']);
  const repository = { resolution: 'repository', key: 'owner/repo', remote: `file://${source}`, targetBranch: 'main' };
  f.execute.mockImplementation(name => name === 'getRoomRepositoryState' ? Promise.resolve(repository) : pendingRead(name));
  f.session.resources.context.repository = repository;
  const ready = await prepareWorkspace({ api: f.session.options.api, config: f.config,
    supervisorRoot: root, workspaceId: 'workspace', agent: f.session.options.agent, placeId: 'room' });
  f.config.codegraphCommand = '/opt/codegraph';
  await f.session.start(f.item);
  const servers = (f.client.sessionNew.mock.calls[0] as unknown as [{ mcpServers: { name: string; args: string[] }[] }])[0].mcpServers;
  const args = servers.find(server => server.name === 'codegraph')!.args;
  const path = args[args.indexOf('--path') + 1]!;
  expect(ready).toContain(`Checkout ready at ${path} on main (read-only)`);
  expect(path).not.toBe(f.session.folder());
  expect(await readFile(join(path, 'README.md'), 'utf8')).toBe('Room repository contents');
  expect(args).toContain('--no-watch');
  await f.session.dispose();
});

it('delivers a cold Room with CodeGraph before optional repository reads resolve', async () => {
  const f = await fixture();
  f.config.codegraphCommand = '/opt/codegraph';
  await f.session.start(f.item);
  expect(f.execute).not.toHaveBeenCalled();
  const servers = (f.client.sessionNew.mock.calls[0] as unknown as [{ mcpServers: { name: string; args: string[] }[] }])[0].mcpServers;
  expect(servers.find(server => server.name === 'codegraph')!.args).toEqual([
    'serve', '--mcp', '--path', f.session.folder(), '--no-watch',
  ]);
  expect(await f.session.deliver(f.item)).toMatchObject({ text: 'The answer' });
  expect(f.session.resources.read()).toMatchObject({ status: { repository: 'loading' } });
  await f.session.dispose();
});

it.runIf(process.platform !== 'win32')('Stop kills granted commands and descendants for its place and preserves another place', async () => {
  const f = await fixture(true);
  const root = f.config.workspaceRoot!;
  const worker = 'require("node:fs").writeFileSync("worker.pid", String(process.pid)); setInterval(() => {}, 1000)';
  const command = `require("node:fs").writeFileSync(process.argv[1], String(process.pid)); require("node:child_process").spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`;
  const argv = ['node', '-e', command, 'running.pid'];
  const script = readGrantScript(parseCommandGrantTarget(JSON.stringify(argv)), {
    roomId: 'room', scriptRoots: [root], scriptEnv: { PATH: process.env.PATH }, execute: async () => ({}),
  });
  const grants = [{ grantId: 'approved', workspaceId: 'workspace', kind: 'command',
    target: JSON.stringify(argv), status: 'approved', requestedBy: 'owner', script }];
  const runner = new GrantCommandRunner({ agentId: 'agent', env: { PATH: process.env.PATH, HOME: root },
    api: { execute: async (operation: string) => operation === 'listTurnAgentGrants' ? { grants } : {} } as never });
  f.session.options.cancelGrantedCommands = () => runner.cancel('room');
  Object.assign(f.client, { sessionCancel: vi.fn() });
  await f.session.start(f.item);
  const runs: Promise<unknown>[] = [];
  const pids: number[] = [];
  const workers: number[] = [];
  const running = async (pid: number) => {
    try {
      const { stdout } = await execFileAsync('ps', ['-o', 'stat=', '-p', String(pid)]);
      return stdout.trim() !== '' && !stdout.trim().startsWith('Z');
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) return false;
      throw error;
    }
  };
  try {
    for (const place of ['room', 'room', 'other']) {
      const cwd = join(root, `command-${runs.length}`);
      await mkdir(cwd);
      runner.register(place, { workspaceId: 'workspace', cwd,
        writePolicy: () => ({ surface: 'corner' }), turn: () => ({ requestId: 'request' }) });
      runs.push(runner.run({ roomId: place, argv }));
      await vi.waitFor(async () => expect(await readFile(join(cwd, 'running.pid'), 'utf8').catch(() => '')).not.toBe(''));
      pids.push(Number(await readFile(join(cwd, 'running.pid'), 'utf8')));
      await vi.waitFor(async () => expect(await readFile(join(cwd, 'worker.pid'), 'utf8').catch(() => '')).not.toBe(''));
      workers.push(Number(await readFile(join(cwd, 'worker.pid'), 'utf8')));
    }
    for (const pid of [...pids, ...workers]) expect(await running(pid)).toBe(true);
    f.session.cancel();
    await vi.waitFor(async () => {
      for (const pid of [...pids.slice(0, 2), ...workers.slice(0, 2)]) expect(await running(pid)).toBe(false);
    });
    const stopped = await Promise.all(runs.slice(0, 2));
    expect(stopped).toEqual([expect.objectContaining({ signal: 'SIGKILL', timedOut: false }), expect.objectContaining({ signal: 'SIGKILL', timedOut: false })]);
    expect(await running(pids[2]!)).toBe(true);
    expect(await running(workers[2]!)).toBe(true);
  } finally {
    for (const pid of [...pids, ...workers]) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await Promise.allSettled(runs);
    await f.session.dispose();
  }
});

const twoModels = { sessionId: 'live', raw: { configOptions: [
  { id: 'model', category: 'model', currentValue: 'sol', options: [{ value: 'sol' }, { value: 'astra' }] },
] } };
const runningReports = (execute: ReturnType<typeof vi.fn>) =>
  execute.mock.calls.filter(([name]) => name === 'postAgentRunningModel').map(([, input]) => input);

it('reports the running model and the reason when the harness refuses the selected model', async () => {
  const f = await fixture();
  f.session.resources.context.configuration = { model: 'astra', commands: [], yoloMode: false };
  f.client.sessionNew.mockResolvedValue(twoModels);
  Object.assign(f.client, { setConfigOption: vi.fn(async () => { throw new Error('astra is not on this plan'); }) });
  await f.session.start(f.item);
  await f.session.deliver(f.item, []);
  await vi.waitFor(() => expect(runningReports(f.execute)).toContainEqual({
    agentId: 'a'.repeat(64), model: 'sol', selected: 'astra',
    reason: expect.stringContaining('astra is not on this plan'),
  }));
  await f.session.dispose();
});

it('reports the running model when the selected model is not offered, without holding delivery', async () => {
  const f = await fixture();
  f.session.resources.context.configuration = { model: 'gpt-astra', commands: [], yoloMode: false };
  f.client.sessionNew.mockResolvedValue(twoModels);
  await f.session.start(f.item);
  expect(runningReports(f.execute)).toEqual([]);
  await f.session.deliver(f.item, []);
  expect(f.prompt.mock.calls[0]?.[1]).toContain('Selected model gpt-astra is unavailable at startup');
  expect(runningReports(f.execute)).toEqual([{ agentId: 'a'.repeat(64), model: 'sol', selected: 'gpt-astra',
    reason: "This agent's harness does not offer gpt-astra." }]);
  await f.session.dispose();
});

it('runs a changed model on the very next turn while the configuration read is still unresolved', async () => {
  const f = await fixture();
  f.session.resources.context.configuration = { model: 'sol', commands: [], yoloMode: false };
  f.client.sessionNew.mockResolvedValue(twoModels);
  const setter = vi.fn(async () => ({}));
  Object.assign(f.client, { setConfigOption: setter });
  await f.session.start(f.item);
  await f.session.deliver(f.item, []);
  expect(setter).not.toHaveBeenCalled();
  // The owner picks Astra and a message follows at once. The configuration
  // read never answers; the queue item carries the choice.
  f.execute.mockImplementation(name => pendingRead(name));
  f.session.configurationChanged();
  const next = { ...f.item, id: 'next', turnRequestId: 'next', modelSelection: { model: 'astra' } } as AgentCommand;
  await f.session.start(next);
  await f.session.deliver(next, []);
  expect(f.client.sessionNew).toHaveBeenCalledTimes(2);
  expect(setter).toHaveBeenCalledWith('live', 'model', 'astra');
  expect(setter.mock.invocationCallOrder[0]).toBeLessThan(f.prompt.mock.invocationCallOrder[1]!);
  await f.session.dispose();
});

it('runs the first prompt after a model change on the new model, even when the switch answers late', async () => {
  const f = await fixture();
  f.client.sessionNew.mockResolvedValue(twoModels);
  let running = 'sol';
  let confirm!: () => void;
  const setter = vi.fn((_session: string, id: string, value: string) => new Promise(resolve => {
    confirm = () => { if (id === 'model') running = value; resolve({}); };
  }));
  const usedModel: string[] = [];
  f.prompt.mockImplementation(async () => {
    usedModel.push(running);
    return { agentText: 'The answer', stopReason: 'end_turn', updates: [], toolCalls: [] };
  });
  Object.assign(f.client, { setConfigOption: setter });
  const item = { ...f.item, modelSelection: { model: 'astra' } } as AgentCommand;
  const starting = f.session.start(item);
  await vi.waitFor(() => expect(setter).toHaveBeenCalledWith('live', 'model', 'astra'));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(f.prompt).not.toHaveBeenCalled();
  confirm();
  await starting;
  await f.session.deliver(item, []);
  expect(usedModel).toEqual(['astra']);
  await f.session.dispose();
});

it('still answers on the running model when the harness refuses the switch', async () => {
  const f = await fixture();
  f.client.sessionNew.mockResolvedValue(twoModels);
  Object.assign(f.client, { setConfigOption: vi.fn(async () => { throw new Error('astra is not on this plan'); }) });
  const item = { ...f.item, modelSelection: { model: 'astra' } } as AgentCommand;
  await f.session.start(item);
  expect(await f.session.deliver(item, [])).toMatchObject({ text: 'The answer' });
  expect(runningReports(f.execute)).toContainEqual(expect.objectContaining({ model: 'sol', selected: 'astra' }));
  await f.session.dispose();
});

it('restarts a live session whose model differs from the choice a queue item carries', async () => {
  const f = await fixture();
  f.session.resources.context.configuration = { model: 'sol', commands: [], yoloMode: false };
  f.client.sessionNew.mockResolvedValue(twoModels);
  Object.assign(f.client, { setConfigOption: vi.fn(async () => ({})) });
  await f.session.start(f.item);
  await f.session.deliver(f.item, []);
  await f.session.start({ ...f.item, modelSelection: { model: 'sol' } } as AgentCommand);
  expect(f.client.sessionNew).toHaveBeenCalledTimes(1);
  await f.session.start({ ...f.item, modelSelection: { model: 'astra' } } as AgentCommand);
  expect(f.client.sessionNew).toHaveBeenCalledTimes(2);
  await f.session.dispose();
});

it('reports the refusal when a live session cannot switch to a newer selection', async () => {
  const f = await fixture();
  f.session.resources.context.configuration = { model: 'sol', commands: [], yoloMode: false };
  f.client.sessionNew.mockResolvedValue(twoModels);
  Object.assign(f.client, { setConfigOption: vi.fn(async () => { throw new Error('astra is not on this plan'); }) });
  let answer!: (value: unknown) => void;
  f.execute.mockImplementation((name: string) => name === 'getAgentConfiguration'
    ? new Promise(resolve => { answer = resolve; }) : pendingRead(name));
  await f.session.start(f.item);
  await f.session.deliver(f.item, []);
  answer({ model: 'astra', commands: [], yoloMode: false });
  await vi.waitFor(() => expect(runningReports(f.execute).at(-1)).toEqual({ agentId: 'a'.repeat(64), model: 'sol',
    selected: 'astra', reason: expect.stringContaining('astra is not on this plan') }));
  await f.session.dispose();
});

it('writes a completed thread tool while the harness prompt remains unresolved', async () => {
  const f = await fixture(true);
  let activityWritten!: () => void;
  const activity = new Promise<void>(resolve => { activityWritten = resolve; });
  f.execute.mockImplementation(async name => {
    if (name === 'listRoomCorners') return { corners: [] };
    if (name === 'postAgentActivity') activityWritten();
    return {};
  });
  let finish!: (result: any) => void;
  const promptResult = new Promise<any>(resolve => { finish = resolve; });
  f.prompt.mockImplementation((...args: any[]) => {
    const onTools = args[4];
    onTools([{ id: 'live-tool', title: 'Read source', status: 'completed' }]);
    return promptResult;
  });
  await f.session.start(f.item);
  let returned = false;
  const answer = f.session.deliver(f.item, [], { id: 'live-invocation', requestId: f.item.turnRequestId })
    .then(result => { returned = true; return result; });
  try {
    // Delivery includes asynchronous context writes before the prompt starts.
    // Wait for its protocol event, not a polling deadline tied to host speed.
    await Promise.race([activity, answer.then(() => { throw new Error('Session returned before its live step'); })]);
    expect(f.execute).toHaveBeenCalledWith('postAgentActivity', expect.objectContaining({
      cornerActivityKey: expect.stringMatching(/^[a-f0-9]{64}$/), activity: [expect.objectContaining({ title: 'Read source' })],
    }));
    expect(returned).toBe(false);
  } finally {
    finish({ agentText: 'Done', stopReason: 'end_turn', updates: [], toolCalls: [] });
    try { await answer; }
    finally { await f.session.dispose(); }
  }
});

it('reports the model that did switch when a later setting is refused', async () => {
  const f = await fixture();
  f.session.resources.context.configuration = { model: 'astra', effort: 'high', commands: [], yoloMode: false };
  f.client.sessionNew.mockResolvedValue({ sessionId: 'live', raw: { configOptions: [
    { id: 'model', category: 'model', currentValue: 'sol', options: [{ value: 'sol' }, { value: 'astra' }] },
    { id: 'effort', category: 'effort', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }] },
  ] } });
  const setter = vi.fn(async (_session: string, id: string) => {
    if (id === 'effort') throw new Error('high effort is not on this plan');
    return {};
  });
  Object.assign(f.client, { setConfigOption: setter });
  await f.session.start(f.item);
  await f.session.deliver(f.item, []);
  await vi.waitFor(() => expect(runningReports(f.execute).at(-1)).toEqual({ agentId: 'a'.repeat(64), model: 'astra',
    selected: 'astra', reason: expect.stringContaining('high effort is not on this plan') }));
  await f.session.dispose();
});

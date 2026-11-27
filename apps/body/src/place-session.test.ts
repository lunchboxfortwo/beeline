import type { AgentCommand } from '@beeline/api-contract/daemon';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AcpClient } from './acp.js';
import { installCornerGitHubWrappers } from './corner-github-auth.js';
import { distillTurnFailureReason } from './turn-failure-reason.js';
import { sharedSquireMcpClient } from './squire-mcp-client.js';
import { prepareWorkspace } from './workspace-checkout.js';
import { runOwnedFile as execFileAsync } from './wait.js';
import { fixture, pendingRead, roots } from './place-session.test-support.js';
import { testTmpDir } from '../../../packages/test-helpers/helpers/helper.js';

// Cache persistence is tested with real files by SessionResources; these prompt tests intentionally finish while optional background work is pending.
vi.mock('./atomic-private-file.js', async (original) => {
  const actual = await original<typeof import('./atomic-private-file.js')>();
  return {
    ...actual,
    writePrivateFileAtomically: vi.fn(async (path: string, contents: string) => {
      if (!path.endsWith('/session-context.json'))
        await actual.writePrivateFileAtomically(path, contents);
    }),
  };
});
vi.mock('./agent-home.js', async (original) => ({
  ...(await original<typeof import('./agent-home.js')>()),
  prepareRoomAgentHome: vi.fn(() => new Promise(() => {})),
}));
vi.mock('./squire-mcp-client.js', async (original) => ({
  ...(await original<typeof import('./squire-mcp-client.js')>()),
  sharedSquireMcpClient: vi.fn(),
}));

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
    await installCornerGitHubWrappers({
      root: home,
      runtimeConfigPath: f.config.runtimeConfigPath,
      roomId: 'parent',
      cornerId: 'room',
      cliEntrypoint: stable,
      gitBinary: '/usr/bin/git',
      ghBinary: '/usr/bin/gh',
      featureBranch: 'feature/corner-room',
      targetBranch: 'main',
    });
    // Reproduce launchers written by the old generator, before release pruning.
    for (const name of ['git', 'gh']) {
      const path = join(home, 'beeline-github-bin', name);
      await writeFile(path, (await readFile(path, 'utf8')).replace(stable, missing));
    }
    const gh = join(home, 'beeline-github-bin/gh');
    const env = {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_STATE_HOME: join(root, 'state'),
    };
    await expect(
      execFileAsync(process.execPath, [gh, 'auth', 'token'], { env }),
    ).rejects.toMatchObject({
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
    expect((await execFileAsync(process.execPath, [gh, '--version'], { env })).stdout).toBe(
      expected.stdout,
    );
    expect(
      (await execFileAsync(process.execPath, [gh, 'auth', 'token'], { env })).stdout.trim(),
    ).toBe('fixture-token');
  } finally {
    process.argv[1] = originalEntrypoint;
    await f.session.dispose();
  }
});
it('answers after thread reconciliation while other optional reads remain pending', async () => {
  const f = await fixture();
  await f.session.start();
  expect(f.execute).not.toHaveBeenCalled();
  const item = {
    ...f.item,
    source: {
      ...f.item.source,
      institutionalContext:
        '- Procedure buy-for-wife (read facet:procedure): Buy through the Japanese proxy',
    },
  };
  f.prompt.mockResolvedValueOnce({
    agentText: 'The answer',
    stopReason: 'end_turn',
    updates: [],
    toolCalls: [],
    tokenUsage: { inputTokens: 9, outputTokens: 2 },
  } as never);
  expect(await f.session.deliver(item, [])).toMatchObject({
    text: 'The answer',
    tokenUsage: { inputTokens: 9, outputTokens: 2 },
  });
  expect(f.prompt.mock.calls[0]?.[1]).toContain('Procedure buy-for-wife');
  expect(f.execute).toHaveBeenCalledWith('getAgentConfiguration', expect.anything());
  expect(f.session.resources.read()).toMatchObject({
    status: { configuration: 'loading', grants: 'loading' },
  });
  expect(f.prompt.mock.calls[0]?.[1]).toContain('the agent default');
  await f.session.dispose();
});

it.each([false, true])(
  'keeps the operator Pi login out of the live session (thread=%s)',
  async (corner) => {
    const f = await fixture(corner);
    f.config.operatorHome = await mkdtemp(`${testTmpDir()}/session-login-operator-`);
    roots.push(f.config.operatorHome);
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
      await execFileAsync(
        launch.agentCommand,
        [
          ...launch.agentArgs!.slice(0, commandIndex),
          process.execPath,
          '-e',
          `
      const fs = require('node:fs');
      const assert = require('node:assert/strict');
      assert.equal(fs.existsSync(process.env.PI_CODING_AGENT_DIR + '/auth.json'), false);
      // The masked operator login is neither readable nor writable here.
      const operatorLogin = ${JSON.stringify(join(loginDir, 'auth.json'))};
      let seen = '';
      try { seen = fs.readFileSync(operatorLogin, 'utf8'); } catch {}
      assert.equal(seen.includes('operator-refresh'), false);
      assert.throws(() => fs.writeFileSync(operatorLogin, 'escape'));
    `,
        ],
        { env: { ...process.env, ...launch.agentEnv } },
      );
      expect(await readFile(join(loginDir, 'auth.json'), 'utf8')).toBe(login);
      expect(JSON.stringify(launch.agentEnv)).not.toContain('operator-refresh');
    } finally {
      await f.session.dispose();
    }
  },
);

it('delivers report audience names from the queue with only people in the roster', async () => {
  const f = await fixture();
  f.session.resources.context.roster = {
    members: [{ identityId: 'worker', kind: 'agent', name: 'Jellybean', role: 'member' }],
  };
  try {
    await f.session.start();
    const report: AgentCommand = {
      ...f.item,
      reason: 'report',
      roomName: 'fast-source-setup',
      returnRoomId: 'owner-room',
      returnRoomName: 'Milo',
      source: { ...f.item.source, authorId: 'worker', body: 'The work is ready.' },
    };
    await f.session.deliver(report);
    const prompt = f.prompt.mock.calls[0]![1];
    expect(prompt).toContain(
      `From: Jellybean in #fast-source-setup\nid: ${report.source.id}\ntext: The work is ready.`,
    );
    expect(prompt).not.toContain('Reply(id:');
    // Offline delivery uses each item's own names, not the session's roster.
    await f.session.deliver({ ...report, offlineSeconds: 60 });
    expect(f.prompt.mock.calls[1]![1]).toContain('From: Jellybean in #');
    await f.session.deliver({ ...report, reason: 'order' });
    expect(f.prompt.mock.calls[2]![1]).toContain(
      `id: ${report.source.id}\ntext: The work is ready.`,
    );
  } finally {
    await f.session.dispose();
  }
});

it('does not restore a streamed preamble after ACP selects no final answer', async () => {
  const f = await fixture();
  await f.session.start();
  f.prompt.mockImplementation(
    async (_sessionId?: unknown, _prompt?: unknown, onChunk?: unknown) => {
      (onChunk as (currentRun: string) => void)('Gathering data');
      return { agentText: '', stopReason: 'end_turn', updates: [], toolCalls: [] };
    },
  );
  expect(await f.session.deliver(f.item)).toMatchObject({ text: '', stopReason: 'end_turn' });
  await f.session.dispose();
});

it('fails a Codex turn whose whole reply is the proxy signed-out refusal, so the sign-in card shows', async () => {
  const f = await fixture();
  await f.session.start();
  const refusal = 'unknown provider for model gpt-6.1-sol';
  f.prompt.mockImplementationOnce(
    async (_sessionId?: unknown, _prompt?: unknown, onChunk?: unknown) => {
      (onChunk as (currentRun: string) => void)(refusal);
      return { agentText: `${refusal}  `, stopReason: 'end_turn', updates: [], toolCalls: [] };
    },
  );
  const failure = await f.session.deliver(f.item).catch((error: unknown) => error);
  expect(failure).toMatchObject({ name: 'WallRefusal', kind: 'signed-in' });
  expect(distillTurnFailureReason(failure)).toEqual({
    text: 'Authentication required: the agent needs to sign in again',
    kind: 'not-signed-in',
  });
  // An answer that only mentions the refusal is still an answer.
  const quoted = `The proxy said "${refusal}", so I switched models.`;
  f.prompt.mockResolvedValueOnce({
    agentText: quoted,
    stopReason: 'end_turn',
    updates: [],
    toolCalls: [],
  });
  expect(
    await f.session.deliver({ ...f.item, id: 'second', turnRequestId: 'second' }),
  ).toMatchObject({ text: quoted });
  await f.session.dispose();
});

it('discovers and calls Squire in the same cold session without a Registry installation', async () => {
  const requestMcp = vi.fn(async (method: string) =>
    method === 'tools/list'
      ? { tools: [{ name: 'list_credentials', inputSchema: { type: 'object' } }] }
      : { content: [{ type: 'text', text: '{"credentials":[]}' }] },
  );
  vi.mocked(sharedSquireMcpClient).mockReturnValue({ requestMcp, close() {} } as never);
  const f = await fixture();
  try {
    await f.session.start();
    expect(sharedSquireMcpClient).not.toHaveBeenCalled();
    f.execute.mockImplementation((name: string) =>
      name === 'authorizeResourceCall' ? Promise.resolve({ allowed: true }) : pendingRead(name),
    );
    // The live request remains the authority for tools; optional config can
    // stay pending, including its Registry routes and grants.
    f.prompt.mockImplementation(async () => {
      const turn = { roomId: f.item.roomId, requestId: f.item.turnRequestId };
      expect(await f.session.resources.mcp({ app: 'registry-mcp:squire' }, turn)).toEqual({
        tools: [{ name: 'list_credentials', inputSchema: { type: 'object' } }],
      });
      expect(
        await f.session.resources.mcp(
          { app: 'registry-mcp:squire', tool: 'list_credentials', args: { fields: 'summary' } },
          turn,
        ),
      ).toEqual({ content: [{ type: 'text', text: '{"credentials":[]}' }] });
      return { agentText: 'The answer', stopReason: 'end_turn', updates: [], toolCalls: [] };
    });
    await f.session.deliver(f.item, []);
    expect(f.prompt.mock.calls[0]?.[1]).not.toContain('Trusty Squire tools are available');
    expect(f.prompt.mock.calls[0]?.[1]).toContain(
      'Trusty Squire uses app_tool(app:"registry-mcp:squire")',
    );
    expect(f.execute).toHaveBeenCalledWith(
      'authorizeResourceCall',
      expect.objectContaining({ target: 'squire', requestId: f.item.turnRequestId }),
    );
    expect(requestMcp).toHaveBeenCalledWith('tools/call', {
      name: 'list_credentials',
      arguments: { fields: 'summary' },
    });
    f.execute.mockImplementation((name: string) =>
      name === 'authorizeResourceCall' ? Promise.resolve({ allowed: false }) : pendingRead(name),
    );
    f.prompt.mockImplementation(async () => {
      await expect(
        f.session.resources.mcp(
          { app: 'registry-mcp:squire', tool: 'list_credentials' },
          { roomId: f.item.roomId, requestId: f.item.turnRequestId },
        ),
      ).rejects.toThrow('not authorized');
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
  expect(f.prompt.mock.calls[0]![1]).toContain(f.item.source.body);
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
  await execFileAsync('git', [
    '-C',
    source,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.com',
    'commit',
    '-m',
    'Initial',
  ]);
  const remote = join(f.config.workspaceRoot!, 'remote.git');
  await execFileAsync('git', ['clone', '--bare', source, remote]);
  const repository = {
    resolution: 'repository',
    key: 'owner/repo',
    remote: `file://${remote}`,
    targetBranch: 'main',
  };
  const restore = { featureBranch: 'feature/corner-room', lifecycle: {} };
  f.execute.mockImplementation((name) => {
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
  const ready = await prepareWorkspace({
    api: f.session.options.api,
    config: f.config,
    supervisorRoot: f.session.options.runtime.supervisorRoot,
    workspaceId: 'workspace',
    agent: f.session.options.agent,
    placeId: 'room',
    parentRoomId: 'parent',
  });
  const checkout = f.session.folder();
  expect(ready).toContain(`Checkout ready at ${checkout} on branch feature/corner-room`);
  expect(await readFile(join(checkout, 'README.md'), 'utf8')).toBe('repository contents\n');
  await writeFile(join(checkout, 'proof.txt'), 'thread edit\n');
  await execFileAsync('git', ['-C', checkout, 'add', 'proof.txt']);
  await execFileAsync('git', ['-C', checkout, 'commit', '-m', 'Prove thread edits']);
  await execFileAsync('git', [
    '-C',
    checkout,
    'push',
    'origin',
    'HEAD:refs/heads/proof-corner-checkout',
  ]);
  const pushed = await execFileAsync('git', [
    '--git-dir',
    remote,
    'rev-parse',
    'refs/heads/proof-corner-checkout',
  ]);
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

it.each([false, true])(
  'does not treat an unverified repository as absent (thread=%s)',
  async (corner) => {
    const f = await fixture(corner);
    f.session.resources.context.repository = { resolution: 'unverified' };
    await f.session.start();
    const systemPrompt = vi.mocked(f.session.client!.sessionNew).mock.calls[0]![0].systemPrompt!;
    expect(systemPrompt).not.toContain('This Beeline chat has no linked repository');
    expect(systemPrompt).not.toContain('This is a repo-less thread');
    expect(systemPrompt).toContain('workspace');
    await f.session.dispose();
  },
);

it('replaces a native conversation when its repository instructions change', async () => {
  const f = await fixture(true);
  f.config.agentBinary = 'codex-acp';
  const original = f.spawn.getMockImplementation()!;
  const load = vi.fn(async () => ({ sessionId: 'previous' }));
  f.spawn.mockImplementation((options) =>
    Object.assign(original(options), {
      canLoadSession: () => true,
      sessionLoad: load,
    }),
  );
  f.session.resources.context.repository = { resolution: 'none' };
  await f.session.start();
  expect(f.session.client!.sessionNew).toHaveBeenCalledWith(
    expect.objectContaining({
      systemPrompt: expect.stringContaining('This is a repo-less thread'),
    }),
  );
  await f.session.stop();
  await f.session.start();
  expect(load).toHaveBeenCalledTimes(1);
  await f.session.stop();
  f.session.resources.context.repository = {
    resolution: 'repository',
    key: 'owner/repo',
    targetBranch: 'main',
  };
  await f.session.start();
  expect(load).toHaveBeenCalledTimes(1);
  expect(f.session.client!.sessionNew).toHaveBeenLastCalledWith(
    expect.objectContaining({
      systemPrompt: expect.stringContaining('Implementer rules: the rules below'),
    }),
  );
  await f.session.dispose();
});

it('delivers the human tag without a second ID when the parent excerpt is absent', async () => {
  const f = await fixture();
  f.item.source.replyToMessageId = 'parent-message';
  await f.session.start();
  expect(await f.session.deliver(f.item, [])).toMatchObject({ text: 'The answer' });
  expect(f.prompt.mock.calls[0]?.[1]).toContain('id: message');
  expect(f.prompt.mock.calls[0]?.[1]).not.toContain('parent-message');
  await f.session.dispose();
});

it('an optional home/skills setup that never resolves cannot hold the answer', async () => {
  const f = await fixture();
  f.execute.mockImplementation((name) =>
    Promise.resolve(
      name === 'listRoomCorners'
        ? { corners: [] }
        : { commands: [], yoloMode: false, isReviewer: true },
    ),
  );
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
  await execFileAsync('git', [
    '-C',
    source,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@t',
    'commit',
    '-m',
    'initial',
  ]);
  const repository = {
    resolution: 'repository',
    key: 'owner/repo',
    remote: `file://${source}`,
    targetBranch: 'main',
  };
  f.execute.mockImplementation((name) =>
    name === 'getRoomRepositoryState' ? Promise.resolve(repository) : pendingRead(name),
  );
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
  const repository = {
    resolution: 'repository',
    key: 'owner/missing',
    remote: `file://${join(f.config.workspaceRoot!, 'missing')}`,
    targetBranch: 'main',
  };
  f.execute.mockImplementation((name) =>
    name === 'getRoomRepositoryState' ? Promise.resolve(repository) : pendingRead(name),
  );
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
  f.session.resources.context.configuration = {
    model: 'unavailable-paid-model',
    commands: [],
    yoloMode: false,
    isReviewer: true,
    soul: { name: 'Reviewer', instructions: 'Review carefully.' },
  };
  await f.session.start();
  await f.session.deliver(f.item, []);
  expect(setter).not.toHaveBeenCalled();
  expect(f.prompt.mock.calls[0]?.[1]).toContain(
    'Selected model unavailable-paid-model is unavailable at startup; this session runs with default-model',
  );
  expect(f.session.client?.sessionNew).toHaveBeenCalledWith(
    expect.objectContaining({ systemPrompt: expect.stringContaining('Review carefully.') }),
  );
  await f.session.dispose();
});

it('switches a cold pi session to its chosen model from the fresh catalog before its first prompt', async () => {
  const f = await fixture();
  f.config.agentKind = 'pi';
  f.config.modelSelection = { model: 'grunt/grunt' };
  expect(f.session.resources.context.modelCatalog).toBeUndefined();
  const models = {
    id: 'model',
    category: 'model',
    currentValue: 'default-model',
    options: [{ value: 'default-model' }, { value: 'grunt/grunt' }],
  };
  f.client.sessionNew.mockResolvedValue({ sessionId: 'live', raw: { configOptions: [models] } });
  let finish!: () => void;
  const setter = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    models.currentValue = 'grunt/grunt';
    return { configOptions: [models] };
  });
  Object.assign(f.client, { setConfigOption: setter });
  const starting = f.session.start();
  await vi.waitFor(() => expect(setter).toHaveBeenCalledWith('live', 'model', 'grunt/grunt'));
  finish();
  await starting;
  expect(
    f.session.resources.context.modelCatalog?.find((option) => option.category === 'model')
      ?.currentValue,
  ).toBe('grunt/grunt');
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

it('starts and answers without awaiting an optional model setter', async () => {
  const f = await fixture();
  f.config.modelSelection = { model: 'default-model' };
  const setter = vi.fn(() => new Promise(() => {}));
  const original = f.spawn.getMockImplementation()!;
  f.spawn.mockImplementation((options) =>
    Object.assign(original(options), { setConfigOption: setter }),
  );
  await f.session.start();
  expect((await f.session.deliver(f.item, [])).text).toBe('The answer');
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
  f.spawn.mockImplementation(((options) => {
    const client = new RealAcpClient({
      ...options,
      agentCommand: process.execPath,
      agentArgs: ['-e', harness],
      inheritProcessEnv: false,
      resourceScope: 'none',
    });
    clients.push(client);
    return client;
  }) as never);
  await f.session.start(f.item);
  const answering = f.session.deliver(f.item, []);
  const settled = answering.then(
    () => 'answered',
    () => 'ended',
  );
  await vi.waitFor(async () =>
    expect(await readFile(pidFile, 'utf8').catch(() => '')).not.toBe(''),
  );
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

async function branchRefreshFixture() {
  const f = await fixture(true);
  delete f.config.agentHomeRoot;
  const root = f.config.workspaceRoot!;
  const git = (cwd: string, ...args: string[]) =>
    execFileAsync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args]);
  const origin = join(root, 'origin.git'),
    other = join(root, 'other');
  const branch = 'feature/corner-room';
  await execFileAsync('git', ['init', '--bare', '-b', branch, origin]);
  await execFileAsync('git', ['clone', `file://${origin}`, other]);
  await git(other, 'checkout', '-b', branch);
  await writeFile(join(other, 'tracked.md'), 'initial text\n');
  await mkdir(join(other, 'packages', 'sample'), { recursive: true });
  await writeFile(join(other, 'packages', 'sample', 'index.js'), 'export {};\n');
  await git(other, 'add', '.');
  await git(other, 'commit', '-m', 'first');
  await git(other, 'push', 'origin', branch);
  const folder = f.session.folder();
  await mkdir(dirname(folder), { recursive: true });
  await execFileAsync('git', ['clone', '-b', branch, `file://${origin}`, folder]);
  async function push(message: string) {
    await writeFile(join(other, 'tracked.md'), `${message}\n`);
    await git(other, 'commit', '-am', message);
    await git(other, 'push', 'origin', branch);
    return (await git(other, 'rev-parse', 'HEAD')).stdout.trim();
  }
  return { ...f, root, folder, other, branch, git, push };
}

it("brings another agent's push into an existing thread checkout before the next turn", async () => {
  const f = await branchRefreshFixture();
  const { root, folder, branch, git } = f;
  await f.push('second agent push');
  await f.session.start(f.item);
  await f.session.deliver(f.item, []);
  expect((await git(folder, 'log', '-1', '--format=%s')).stdout.trim()).toBe('second agent push');
  // A failed refresh still delivers, with one line saying so.
  await git(folder, 'remote', 'set-url', 'origin', `file://${join(root, 'missing.git')}`);
  await f.session.deliver(f.item, []);
  expect(f.prompt.mock.calls[1]?.[1]).toContain(
    `Your branch ${branch} could not be refreshed from origin`,
  );
  await f.session.dispose();
});

it('refreshes a reviewer checkout on the next wake with dependency install output present', async () => {
  const f = await branchRefreshFixture();
  const { root, folder, git } = f;
  const wake = { ...f.item, reason: 'corner_review_dispatch' };
  await f.session.start(wake);
  try {
    await f.session.deliver(wake, []);
    // A prepared root dependency symlink and a workspace-local install from the prior review.
    const store = join(root, 'dependencies');
    const localInstall = join(folder, 'packages', 'sample', 'node_modules');
    await mkdir(store);
    await writeFile(join(store, 'package.js'), 'root dependency');
    await symlink(store, join(folder, 'node_modules'), 'dir');
    await mkdir(localInstall);
    await writeFile(join(localInstall, 'package.js'), 'workspace dependency');
    const dirty = (await git(folder, 'status', '--porcelain=v1', '--untracked-files=normal')).stdout;
    expect(dirty.trim().split('\n')).toEqual(['?? node_modules', '?? packages/sample/node_modules/']);

    const head = await f.push('new head for review');
    await f.session.deliver({ ...wake, id: 'next-review', turnRequestId: 'next-review' }, []);

    expect(f.prompt.mock.calls[1]?.[1]).not.toContain('could not be refreshed');
    expect((await git(folder, 'rev-parse', 'HEAD')).stdout.trim()).toBe(head);
    expect(await readFile(join(folder, 'node_modules', 'package.js'), 'utf8')).toBe('root dependency');
    expect(await readFile(join(localInstall, 'package.js'), 'utf8')).toBe('workspace dependency');
  } finally {
    await f.session.dispose();
  }
});

it('refreshes a reviewer checkout with a dependency symlink left by a removed workspace', async () => {
  const f = await branchRefreshFixture();
  const { root, folder, other, git } = f;
  const wake = { ...f.item, reason: 'corner_review_dispatch' };
  const dependencyLink = join(folder, 'packages', 'sample', 'node_modules');
  const store = join(root, 'dependencies');
  await mkdir(store);
  await writeFile(join(store, 'package.js'), 'workspace dependency');
  await symlink(store, dependencyLink, 'dir');
  await git(other, 'rm', 'packages/sample/index.js');
  const removal = await f.push('remove sample workspace');

  await f.session.start(wake);
  try {
    await f.session.deliver(wake, []);
    expect((await git(folder, 'rev-parse', 'HEAD')).stdout.trim()).toBe(removal);
    expect(await readFile(join(dependencyLink, 'package.js'), 'utf8')).toBe('workspace dependency');

    const head = await f.push('new head after workspace removal');
    await f.session.deliver({ ...wake, id: 'next-review', turnRequestId: 'next-review' }, []);

    expect((await git(folder, 'rev-parse', 'HEAD')).stdout.trim()).toBe(head);
    expect(f.prompt.mock.calls[1]?.[1]).not.toContain('could not be refreshed');
    expect(await readFile(join(dependencyLink, 'package.js'), 'utf8')).toBe('workspace dependency');
  } finally {
    await f.session.dispose();
  }
});

it.each([false, true])('refuses a reviewer refresh and names tracked edits (staged=%s)', async (staged) => {
  const f = await branchRefreshFixture();
  const { folder, git } = f;
  const wake = { ...f.item, reason: 'corner_review_dispatch' };
  const oldHead = (await git(folder, 'rev-parse', 'HEAD')).stdout.trim();
  await writeFile(join(folder, 'tracked.md'), 'reviewer edit\n');
  if (staged) await git(folder, 'add', 'tracked.md');
  await f.push('new head for review');
  await f.session.start(wake);
  try {
    await f.session.deliver(wake, []);
    expect((await git(folder, 'rev-parse', 'HEAD')).stdout.trim()).toBe(oldHead);
    expect(await readFile(join(folder, 'tracked.md'), 'utf8')).toBe('reviewer edit\n');
    expect((await git(folder, 'show', ':tracked.md')).stdout).toBe(staged ? 'reviewer edit\n' : 'initial text\n');
    const prompt = String(f.prompt.mock.calls[0]?.[1]);
    expect(prompt.split('\n').find(line => line.includes('could not be refreshed'))).toContain('tracked.md');
  } finally {
    await f.session.dispose();
  }
});

it('still refuses refresh when untracked files are present outside dependency directories', async () => {
  const f = await branchRefreshFixture();
  const { folder, git } = f;
  const oldHead = (await git(folder, 'rev-parse', 'HEAD')).stdout.trim();
  await writeFile(join(folder, 'node_modules'), 'ordinary file\n');
  await writeFile(join(folder, 'review notes.md'), 'untracked review notes\n');
  await f.push('new head for review');
  await f.session.start(f.item);
  try {
    await f.session.deliver(f.item, []);
    expect((await git(folder, 'rev-parse', 'HEAD')).stdout.trim()).toBe(oldHead);
    expect(await readFile(join(folder, 'node_modules'), 'utf8')).toBe('ordinary file\n');
    expect(await readFile(join(folder, 'review notes.md'), 'utf8')).toBe('untracked review notes\n');
    const prompt = String(f.prompt.mock.calls[0]?.[1]);
    const warning = prompt.split('\n').find(line => line.includes('could not be refreshed'));
    expect(warning).toContain('"node_modules"');
    expect(warning).toContain('"review notes.md"');
  } finally {
    await f.session.dispose();
  }
});

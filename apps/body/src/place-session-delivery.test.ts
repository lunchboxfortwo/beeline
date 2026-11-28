import type { AgentCommand } from '@beeline/api-contract/daemon';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AcpClient } from './acp.js';
import { GrantCommandRunner } from './grant-runner.js';
import { readGrantScript } from './read-only-mcp-agent-grant-deps.js';
import { parseCommandGrantTarget } from '@beeline/api-contract/agent-grants';
import { prepareWorkspace } from './workspace-checkout.js';
import { runOwnedFile as execFileAsync } from './wait.js';
import { fixture, pendingRead } from './place-session.test-support.js';

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

it.each([
  { adapter: 'Codex', structured: true, pinned: true },
  { adapter: 'unpinned structured', structured: true, pinned: false },
  { adapter: 'fallback', structured: false, pinned: false },
])('reuses and restores session rules for the $adapter adapter', async ({ structured, pinned }) => {
  const f = await fixture();
  if (pinned) f.config.agentBinary = 'codex-acp';
  f.execute.mockImplementation(pendingRead);
  const rules = 'Use the blue notebook for this session.';
  f.session.resources.context.configuration = {
    commands: [], yoloMode: false, soul: { name: 'Agent', instructions: rules },
  };
  const prompts: string[] = [];
  const systemPrompts: unknown[] = [];
  f.spawn.mockImplementation((options) => {
    const client = new AcpClient(options);
    vi.spyOn(client, 'startProcess').mockImplementation(async () => {
      client.supportsStructuredSystemPrompt = structured;
      client.codexBlockDelivery = pinned;
    });
    vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
      if (method === 'session/new') {
        systemPrompts.push((params as { systemPrompt: unknown }).systemPrompt);
        return { sessionId: 'live' };
      }
      if (method !== 'session/prompt') throw new Error(`Unexpected request ${method}`);
      const { sessionId, prompt } = params as { sessionId: string; prompt: { text: string }[] };
      if (prompt[0]!.text.includes('Reject first prompt')) throw new Error('Prompt rejected');
      prompts.push(prompt[0]!.text);
      if (prompt[0]!.text.includes('Compact now')) {
        client.handleMessage({
          method: 'session/update',
          params: { sessionId, update: { sessionUpdate: 'compaction_update', status: 'completed' } },
        });
      }
      return { stopReason: prompt[0]!.text.includes('Cancelled restore') ? 'cancelled' : 'end_turn' };
    });
    return client;
  });
  const turn = (body: string, offlineSeconds?: number) => f.session.deliver({
    ...f.item, id: body, turnRequestId: body, source: { ...f.item.source, body }, offlineSeconds,
  });
  try {
    await f.session.start(f.item);
    expect(systemPrompts).toEqual([
      structured
        ? { mode: 'append', content: [{ type: 'text', text: expect.stringContaining(rules) }] }
        : expect.stringContaining(rules),
    ]);
    if (!structured) await expect(turn('Reject first prompt')).rejects.toThrow('Prompt rejected');
    for (const body of [
      'First prompt', 'Warm prompt', 'Compact now', 'Cancelled restore', 'After compaction', 'Warm again',
    ]) {
      await turn(body, body === 'Warm prompt' ? 60 : undefined);
      expect(prompts.at(-1)).toContain(body);
    }
    expect(prompts.map((prompt) => prompt.includes(rules))).toEqual([
      !structured, false, false, true, true, false,
    ]);
    f.session.stale = true;
    await f.session.start(f.item);
    await turn('Fresh conversation');
    expect(prompts.at(-1)?.includes(rules)).toBe(!structured);
  } finally {
    await f.session.dispose();
  }
});

it('sends a received picture to an image-capable harness as image content, bounded per image', async () => {
  const f = await fixture();
  Object.assign(f.client, { canPromptWithImages: () => true });
  const small = Buffer.from('small-png'),
    large = Buffer.alloc(5 * 1024 * 1024 + 1);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(url.endsWith('large') ? large : small, {
          headers: { 'content-type': 'image/png' },
        }),
    ),
  );
  try {
    await f.session.start(f.item);
    const attachments = [
      { url: 'https://synthetic.test/v1/media/small', name: 'keyboard.png', mimeType: 'image/png' },
      { url: 'https://synthetic.test/v1/media/large', name: 'scan.png', mimeType: 'image/png' },
    ];
    await f.session.deliver(
      { ...f.item, source: { ...f.item.source, attachments } } as AgentCommand,
      [],
    );
    const sent = f.prompt.mock.calls[0]?.[1] as unknown as {
      type: string;
      text?: string;
      data?: string;
    }[];
    expect(sent[0]).toMatchObject({ type: 'text', text: expect.stringContaining('keyboard.png') });
    expect(sent.slice(1)).toEqual([
      { type: 'image', data: small.toString('base64'), mimeType: 'image/png' },
    ]);
  } finally {
    vi.unstubAllGlobals();
    await f.session.dispose();
  }
});

it('preserves bundled MCP wires when mounting operator host routes', async () => {
  const f = await fixture(true);
  f.config.agentKind = 'claude';
  f.config.codegraphCommand = '/opt/codegraph';
  await writeFile(
    join(f.config.operatorHome!, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        codegraph: { command: 'operator-codegraph', args: ['serve', '--mcp'] },
        'beeline-agent': { command: 'operator-agent' },
        'beeline-readonly-mcp': { command: 'operator-inspection' },
        linear: { command: 'linear-mcp', args: ['--stdio'] },
      },
    }),
  );
  await f.session.start(f.item);
  const servers = (
    f.client.sessionNew.mock.calls[0] as unknown as [
      {
        mcpServers: {
          name: string;
          command: string;
          args?: string[];
          env?: { name: string; value: string }[];
        }[];
      },
    ]
  )[0].mcpServers;
  expect(servers.filter((server) => server.name === 'codegraph')).toMatchObject([{
    command: '/opt/codegraph',
    args: ['serve', '--mcp', '--path', f.session.folder()],
  }]);
  expect(servers.filter((server) => server.name === 'beeline-agent')).toMatchObject([
    { command: f.config.readonlyMcpCommand },
  ]);
  expect(servers).not.toContainEqual(expect.objectContaining({
    name: 'beeline-readonly-mcp',
    env: expect.arrayContaining([{ name: 'BEELINE_RESOURCE_TARGET', value: 'beeline-readonly-mcp' }]),
  }));
  const linear = servers.find((server) => server.name === 'linear');
  expect(linear?.env).toEqual(
    expect.arrayContaining([{ name: 'BEELINE_RESOURCE_TARGET', value: 'linear' }]),
  );
  await f.session.dispose();
});

it('gives a fresh session the recent window once, then only what it has not seen', async () => {
  const f = await fixture();
  const item = (id: string, delta?: string) =>
    ({
      ...f.item,
      id,
      turnRequestId: id,
      source: {
        ...f.item.source,
        id,
        ...(delta ? { conversationContext: delta } : {}),
        conversationWindow: `Window before ${id}`,
      },
    }) as AgentCommand;
  await f.session.start(f.item);
  await f.session.deliver(item('one', 'Delta before one'));
  await f.session.deliver(item('two', 'Delta before two'));
  await f.session.deliver(item('three'));
  const sent = f.prompt.mock.calls.map((call) => String((call as unknown[])[1]));
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
  f.session.resources.context.configuration = {
    model: 'default-model',
    effort: 'high',
    fastMode: true,
    commands: [],
    yoloMode: false,
  };
  f.client.sessionNew.mockResolvedValue({
    sessionId: 'live',
    raw: {
      configOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'default-model',
          options: [{ value: 'default-model' }],
        },
        {
          id: 'effort',
          category: 'effort',
          currentValue: 'low',
          options: [{ value: 'low' }, { value: 'high' }],
        },
        {
          id: 'fast-mode',
          category: 'model_config',
          currentValue: 'off',
          options: [{ value: 'off' }, { value: 'on' }],
        },
      ],
    },
  });
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
  const tags = [1, 2, 3].map((n) => ({
    ...f.item,
    id: `tag-${n}`,
    turnRequestId: `tag-${n}`,
    offlineSeconds,
    source: {
      ...f.item.source,
      id: `tag-source-${n}`,
      authorId: `asker-${n}`,
      body: `question ${n}`,
    },
  }));
  const runs = Array.from({ length: 25 }, (_, n) => ({
    ...f.item,
    id: `run-${n}`,
    turnRequestId: `run-${n}`,
    offlineSeconds,
    reason: 'schedule',
    scheduleId: 'daily-check',
    source: { ...f.item.source, id: `run-source-${n}`, body: `scheduled run ${n}` },
  }));
  const batch = [...tags, ...runs];
  await f.session.start();
  await f.session.deliver(tags[0]!, batch);
  expect(f.prompt).toHaveBeenCalledTimes(1);
  const prompt = f.prompt.mock.calls[0]![1];
  expect(prompt).toContain(
    '> You were offline for 18 h. These arrived while you were away and may be outdated.',
  );
  for (let n = 1; n <= 3; n++)
    expect(prompt).toMatch(
      new RegExp(
        `^From: asker-${n} in #.+\\nid: tag-source-${n}\\ntext: question ${n}$`,
        'm',
      ),
    );
  expect(prompt.match(/scheduled run/g)).toHaveLength(1);
  expect(prompt).toContain('scheduled run 24');
  expect(prompt).toContain('Follow the newest instructions when earlier discussion has moved on.');
  await f.session.dispose();
});

it('mounts Room CodeGraph at the cached workspace checkout', async () => {
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
  f.session.resources.context.repository = repository;
  const ready = await prepareWorkspace({
    api: f.session.options.api,
    config: f.config,
    supervisorRoot: root,
    workspaceId: 'workspace',
    agent: f.session.options.agent,
    placeId: 'room',
  });
  f.config.codegraphCommand = '/opt/codegraph';
  await f.session.start(f.item);
  const servers = (
    f.client.sessionNew.mock.calls[0] as unknown as [
      { mcpServers: { name: string; args: string[] }[] },
    ]
  )[0].mcpServers;
  const args = servers.find((server) => server.name === 'codegraph')!.args;
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
  const servers = (
    f.client.sessionNew.mock.calls[0] as unknown as [
      { mcpServers: { name: string; args: string[] }[] },
    ]
  )[0].mcpServers;
  expect(servers.find((server) => server.name === 'codegraph')!.args).toEqual([
    'serve',
    '--mcp',
    '--path',
    f.session.folder(),
    '--no-watch',
  ]);
  expect(await f.session.deliver(f.item)).toMatchObject({ text: 'The answer' });
  expect(f.session.resources.read()).toMatchObject({ status: { repository: 'loading' } });
  await f.session.dispose();
});

it.runIf(process.platform !== 'win32')(
  'Stop kills granted commands and descendants for its place and preserves another place',
  async () => {
    const f = await fixture(true);
    const root = f.config.workspaceRoot!;
    const worker =
      'require("node:fs").writeFileSync("worker.pid", String(process.pid)); setInterval(() => {}, 1000)';
    const command = `require("node:fs").writeFileSync(process.argv[1], String(process.pid)); require("node:child_process").spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`;
    const argv = ['node', '-e', command, 'running.pid'];
    const script = readGrantScript(parseCommandGrantTarget(JSON.stringify(argv)), {
      roomId: 'room',
      scriptRoots: [root],
      scriptEnv: { PATH: process.env.PATH },
      execute: async () => ({}),
    });
    const grants = [
      {
        grantId: 'approved',
        workspaceId: 'workspace',
        kind: 'command',
        target: JSON.stringify(argv),
        status: 'approved',
        requestedBy: 'owner',
        script,
      },
    ];
    const runner = new GrantCommandRunner({
      agentId: 'agent',
      env: { PATH: process.env.PATH, HOME: root },
      api: {
        execute: async (operation: string) =>
          operation === 'listTurnAgentGrants' ? { grants } : {},
      } as never,
    });
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
        runner.register(place, {
          workspaceId: 'workspace',
          cwd,
          writePolicy: () => ({ surface: 'corner' }),
          turn: () => ({ requestId: 'request' }),
        });
        runs.push(runner.run({ roomId: place, argv }));
        await vi.waitFor(async () =>
          expect(await readFile(join(cwd, 'running.pid'), 'utf8').catch(() => '')).not.toBe(''),
        );
        pids.push(Number(await readFile(join(cwd, 'running.pid'), 'utf8')));
        await vi.waitFor(async () =>
          expect(await readFile(join(cwd, 'worker.pid'), 'utf8').catch(() => '')).not.toBe(''),
        );
        workers.push(Number(await readFile(join(cwd, 'worker.pid'), 'utf8')));
      }
      for (const pid of [...pids, ...workers]) expect(await running(pid)).toBe(true);
      f.session.cancel();
      await vi.waitFor(async () => {
        for (const pid of [...pids.slice(0, 2), ...workers.slice(0, 2)])
          expect(await running(pid)).toBe(false);
      });
      const stopped = await Promise.all(runs.slice(0, 2));
      expect(stopped).toEqual([
        expect.objectContaining({ signal: 'SIGKILL', timedOut: false }),
        expect.objectContaining({ signal: 'SIGKILL', timedOut: false }),
      ]);
      expect(await running(pids[2]!)).toBe(true);
      expect(await running(workers[2]!)).toBe(true);
    } finally {
      for (const pid of [...pids, ...workers]) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      await Promise.allSettled(runs);
      await f.session.dispose();
    }
  },
);

const twoModels = {
  sessionId: 'live',
  raw: {
    configOptions: [
      {
        id: 'model',
        category: 'model',
        currentValue: 'sol',
        options: [{ value: 'sol' }, { value: 'astra' }],
      },
    ],
  },
};
const runningReports = (execute: ReturnType<typeof vi.fn>) =>
  execute.mock.calls.filter(([name]) => name === 'postAgentRunningModel').map(([, input]) => input);

it('reports the running model and the reason when the harness refuses the selected model', async () => {
  const f = await fixture();
  f.session.resources.context.configuration = { model: 'astra', commands: [], yoloMode: false };
  f.client.sessionNew.mockResolvedValue(twoModels);
  Object.assign(f.client, {
    setConfigOption: vi.fn(async () => {
      throw new Error('astra is not on this plan');
    }),
  });
  await f.session.start(f.item);
  await f.session.deliver(f.item, []);
  await vi.waitFor(() =>
    expect(runningReports(f.execute)).toContainEqual({
      agentId: 'a'.repeat(64),
      model: 'sol',
      selected: 'astra',
      reason: expect.stringContaining('astra is not on this plan'),
    }),
  );
  await f.session.dispose();
});

it('reports the running model when the selected model is not offered, without holding delivery', async () => {
  const f = await fixture();
  f.session.resources.context.configuration = { model: 'gpt-astra', commands: [], yoloMode: false };
  f.client.sessionNew.mockResolvedValue(twoModels);
  await f.session.start(f.item);
  expect(runningReports(f.execute)).toEqual([]);
  await f.session.deliver(f.item, []);
  expect(f.prompt.mock.calls[0]?.[1]).toContain(
    'Selected model gpt-astra is unavailable at startup',
  );
  expect(runningReports(f.execute)).toEqual([
    {
      agentId: 'a'.repeat(64),
      model: 'sol',
      selected: 'gpt-astra',
      reason: "This agent's harness does not offer gpt-astra.",
    },
  ]);
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
  f.execute.mockImplementation((name) => pendingRead(name));
  f.session.configurationChanged();
  const next = {
    ...f.item,
    id: 'next',
    turnRequestId: 'next',
    modelSelection: { model: 'astra' },
  } as AgentCommand;
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
  const setter = vi.fn(
    (_session: string, id: string, value: string) =>
      new Promise((resolve) => {
        confirm = () => {
          if (id === 'model') running = value;
          resolve({});
        };
      }),
  );
  const usedModel: string[] = [];
  f.prompt.mockImplementation(async () => {
    usedModel.push(running);
    return { agentText: 'The answer', stopReason: 'end_turn', updates: [], toolCalls: [] };
  });
  Object.assign(f.client, { setConfigOption: setter });
  const item = { ...f.item, modelSelection: { model: 'astra' } } as AgentCommand;
  const starting = f.session.start(item);
  await vi.waitFor(() => expect(setter).toHaveBeenCalledWith('live', 'model', 'astra'));
  await new Promise((resolve) => setTimeout(resolve, 50));
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
  Object.assign(f.client, {
    setConfigOption: vi.fn(async () => {
      throw new Error('astra is not on this plan');
    }),
  });
  const item = { ...f.item, modelSelection: { model: 'astra' } } as AgentCommand;
  await f.session.start(item);
  expect(await f.session.deliver(item, [])).toMatchObject({ text: 'The answer' });
  expect(runningReports(f.execute)).toContainEqual(
    expect.objectContaining({ model: 'sol', selected: 'astra' }),
  );
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
  Object.assign(f.client, {
    setConfigOption: vi.fn(async () => {
      throw new Error('astra is not on this plan');
    }),
  });
  let answer!: (value: unknown) => void;
  f.execute.mockImplementation((name: string) =>
    name === 'getAgentConfiguration'
      ? new Promise((resolve) => {
          answer = resolve;
        })
      : pendingRead(name),
  );
  await f.session.start(f.item);
  await f.session.deliver(f.item, []);
  answer({ model: 'astra', commands: [], yoloMode: false });
  await vi.waitFor(() =>
    expect(runningReports(f.execute).at(-1)).toEqual({
      agentId: 'a'.repeat(64),
      model: 'sol',
      selected: 'astra',
      reason: expect.stringContaining('astra is not on this plan'),
    }),
  );
  await f.session.dispose();
});

it('writes a completed thread tool while the harness prompt remains unresolved', async () => {
  const f = await fixture(true);
  let activityWritten!: () => void;
  const activity = new Promise<void>((resolve) => {
    activityWritten = resolve;
  });
  f.execute.mockImplementation(async (name) => {
    if (name === 'listRoomCorners') return { corners: [] };
    if (name === 'postAgentActivity') activityWritten();
    return {};
  });
  let finish!: (result: any) => void;
  const promptResult = new Promise<any>((resolve) => {
    finish = resolve;
  });
  f.prompt.mockImplementation((...args: any[]) => {
    const onTools = args[4];
    onTools([{ id: 'live-tool', title: 'Read source', status: 'completed' }]);
    return promptResult;
  });
  await f.session.start(f.item);
  let returned = false;
  const answer = f.session
    .deliver(f.item, [], { id: 'live-invocation', requestId: f.item.turnRequestId })
    .then((result) => {
      returned = true;
      return result;
    });
  try {
    // Delivery includes asynchronous context writes before the prompt starts.
    // Wait for its protocol event, not a polling deadline tied to host speed.
    await Promise.race([
      activity,
      answer.then(() => {
        throw new Error('Session returned before its live step');
      }),
    ]);
    expect(f.execute).toHaveBeenCalledWith(
      'postAgentActivity',
      expect.objectContaining({
        cornerActivityKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        activity: [expect.objectContaining({ title: 'Read source' })],
      }),
    );
    expect(returned).toBe(false);
  } finally {
    finish({ agentText: 'Done', stopReason: 'end_turn', updates: [], toolCalls: [] });
    try {
      await answer;
    } finally {
      await f.session.dispose();
    }
  }
});

it('reports the model that did switch when a later setting is refused', async () => {
  const f = await fixture();
  f.session.resources.context.configuration = {
    model: 'astra',
    effort: 'high',
    commands: [],
    yoloMode: false,
  };
  f.client.sessionNew.mockResolvedValue({
    sessionId: 'live',
    raw: {
      configOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'sol',
          options: [{ value: 'sol' }, { value: 'astra' }],
        },
        {
          id: 'effort',
          category: 'effort',
          currentValue: 'low',
          options: [{ value: 'low' }, { value: 'high' }],
        },
      ],
    },
  });
  const setter = vi.fn(async (_session: string, id: string) => {
    if (id === 'effort') throw new Error('high effort is not on this plan');
    return {};
  });
  Object.assign(f.client, { setConfigOption: setter });
  await f.session.start(f.item);
  await f.session.deliver(f.item, []);
  await vi.waitFor(() =>
    expect(runningReports(f.execute).at(-1)).toEqual({
      agentId: 'a'.repeat(64),
      model: 'astra',
      selected: 'astra',
      reason: expect.stringContaining('high effort is not on this plan'),
    }),
  );
  await f.session.dispose();
});

it('exposes command details only while their place prompt is active', async () => {
  const f = await fixture();
  const second = { ...f.item, id: 'second', turnRequestId: 'second' };
  f.prompt.mockImplementationOnce(async () => {
    expect(f.session.command()).toBe(f.item);
    expect(f.session.command(second.turnRequestId)).toBe(second);
    expect(f.session.command('earlier')).toBeUndefined();
    return { agentText: 'Done', stopReason: 'end_turn', updates: [], toolCalls: [] };
  });
  try {
    await f.session.start(f.item);
    await f.session.deliver(f.item, [f.item, second]);
    expect(f.session.command()).toBeUndefined();
    expect(f.session.command(second.turnRequestId)).toBeUndefined();
  } finally {
    await f.session.dispose();
  }
});

it('renders an offline plain join with the current starter persona', async () => {
  const f = await fixture();
  const retired = 'End every turn with the deliverable or a clear status explaining what is finished, what stopped, and the next step.';
  f.config.agentEnv = { BEELINE_FREE_AGENT_ID: f.item.agentId };
  f.session.resources.context.configuration = {
    commands: [], yoloMode: false, isReviewer: false,
    soul: { name: 'Starter', instructions: `Never greet an agent. ${retired} Keep allowance guidance.` },
  };
  const join: AgentCommand = { ...f.item, reason: 'system', offlineSeconds: 3600,
    source: { ...f.item.source, type: 'system', body: '@neon joined · invited by @owner',
      systemEvent: { kind: 'joined', verb: 'joined', subject: { kind: 'agent', name: 'Neon' } } } };
  try {
    await f.session.start(join);
    await f.session.deliver(join, [join]);
    const prompt = f.prompt.mock.calls[0]?.[1];
    expect(prompt).toContain('Never greet an agent. Keep allowance guidance.');
    expect(prompt).toContain('text: @neon joined · invited by @owner');
    expect(prompt).not.toContain(retired);
    expect(prompt).not.toContain('From:');
    expect(prompt).not.toContain('id: message');
  } finally {
    await f.session.dispose();
  }
});

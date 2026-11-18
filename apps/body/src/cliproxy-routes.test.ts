import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  harnessLoginWritablePaths,
  harnessStateDirsFromEnv,
  prepareRoomAgentCredentials,
  prepareRoomAgentHome,
} from './agent-home.js';
import { credentialMaskPaths, wrapAgentCommand } from './bwrap-sandbox.js';
import { cliProxyDir, cliProxyHarnessEnv, machineCliProxy, machineCliProxyEndpoint } from './cliproxy.js';
import { freeAgentPiConfig } from './free-agent-vm.js';

const run = promisify(execFile);
const roots: string[] = [];
const tmpLinks: string[] = [];
afterEach(async () => {
  await Promise.all(tmpLinks.splice(0).map((path) => rm(path, { force: true })));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const proxy = { url: 'http://127.0.0.1:41234', key: 'local-inference-key' };

it('points each proxied harness at the machine proxy with only the local key', async () => {
  expect(await cliProxyHarnessEnv({ kind: 'claude', root: '/r', proxy, env: {} })).toEqual({
    ANTHROPIC_BASE_URL: proxy.url,
    ANTHROPIC_AUTH_TOKEN: proxy.key,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  });
  const codex = await cliProxyHarnessEnv({ kind: 'codex', root: '/r', proxy, env: {} });
  expect(JSON.parse(codex.DEFAULT_AUTH_REQUEST!)).toEqual({
    methodId: 'gateway',
    _meta: {
      gateway: {
        baseUrl: `${proxy.url}/v1`,
        headers: { Authorization: `Bearer ${proxy.key}` },
        providerName: 'Beeline',
      },
    },
  });
  const root = await mkdtemp('/var/tmp/beeline-proxy-grok-');
  roots.push(root);
  expect(await cliProxyHarnessEnv({ kind: 'grok', root, proxy, env: {} })).toEqual({
    GROK_HOME: join(root, 'grok'),
    GROK_MODELS_BASE_URL: `${proxy.url}/v1`,
    XAI_API_KEY: proxy.key,
    GROK_AUTH_PROVIDER_COMMAND: `echo ${proxy.key}`,
  });
  // Grok's stored sign-in holds only the local key.
  expect(
    Object.values(JSON.parse(await readFile(join(root, 'grok', 'auth.json'), 'utf8'))),
  ).toEqual([expect.objectContaining({ key: proxy.key, auth_mode: 'external' })]);
  // Cursor stays on its native login; custom commands are left alone.
  for (const kind of ['cursor', 'custom', 'reference', undefined] as const)
    expect(await cliProxyHarnessEnv({ kind, root: '/r', proxy, env: {} })).toEqual({});
});

it('routes only the subscription providers a multi-provider session holds no key for', async () => {
  const root = await mkdtemp('/var/tmp/beeline-proxy-routes-');
  roots.push(root);
  const opencode = await cliProxyHarnessEnv({
    kind: 'opencode',
    root,
    proxy,
    env: { OPENAI_API_KEY: 'sk-own' },
  });
  expect(JSON.parse(opencode.OPENCODE_CONFIG_CONTENT!).provider).toEqual({
    anthropic: { options: { baseURL: `${proxy.url}/v1`, apiKey: proxy.key } },
    xai: { options: { baseURL: `${proxy.url}/v1`, apiKey: proxy.key } },
  });
  const operatorHome = join(root, 'operator');
  await mkdir(join(operatorHome, '.config/goose'), { recursive: true });
  await writeFile(join(operatorHome, '.config/goose/secrets.yaml'), 'ANTHROPIC_API_KEY: sk-own\n');
  expect(await cliProxyHarnessEnv({ kind: 'goose', root, operatorHome, proxy, env: {} })).toEqual({
    OPENAI_HOST: proxy.url,
    OPENAI_API_KEY: proxy.key,
  });
  // Pi: an API key the operator stored stays on its own provider.
  await mkdir(join(operatorHome, '.pi', 'agent'), { recursive: true });
  await writeFile(
    join(operatorHome, '.pi', 'agent', 'auth.json'),
    JSON.stringify({
      xai: { type: 'api_key', key: 'xai-own' },
      anthropic: { type: 'oauth', refresh: 'operator-refresh' },
    }),
  );
  const env = await prepareRoomAgentCredentials({
    root: join(root, 'pi-home'),
    operatorHome,
    agentKind: 'pi',
    cliProxy: proxy,
  });
  tmpLinks.push(env.TMPDIR!);
  const models = JSON.parse(await readFile(join(root, 'pi-home', 'pi', 'models.json'), 'utf8'));
  expect(models.providers).toEqual({
    anthropic: { baseUrl: proxy.url, apiKey: proxy.key },
    openai: { baseUrl: `${proxy.url}/v1`, apiKey: proxy.key },
    'openai-codex': { baseUrl: `${proxy.url}/v1`, apiKey: proxy.key, models: expect.any(Array) },
  });
  expect(JSON.parse(await readFile(join(root, 'pi-home', 'pi', 'auth.json'), 'utf8'))).toEqual({
    xai: { type: 'api_key', key: 'xai-own' },
  });
});

it.each(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const)(
  'keeps operator %s native in fresh Goose homes and catalog overlays',
  async (key) => {
    const root = await mkdtemp('/var/tmp/beeline-proxy-goose-cold-');
    roots.push(root);
    const operatorHome = join(root, 'operator');
    await mkdir(join(operatorHome, '.config/goose'), { recursive: true });
    await writeFile(join(operatorHome, '.config/goose/secrets.yaml'), `${key}: operator-key\n`);
    const session = await prepareRoomAgentCredentials({
      root: join(root, 'session'),
      operatorHome,
      agentKind: 'goose',
      cliProxy: proxy,
    });
    tmpLinks.push(session.TMPDIR!);
    expect(session).not.toHaveProperty(key);
    const host = key === 'ANTHROPIC_API_KEY' ? 'ANTHROPIC_HOST' : 'OPENAI_HOST';
    expect(session).not.toHaveProperty(host);
    const catalog = await cliProxyHarnessEnv({
      kind: 'goose',
      root: join(root, 'empty-catalog'),
      operatorHome,
      proxy,
      env: {},
    });
    expect(catalog).not.toHaveProperty(key);
    expect(catalog).not.toHaveProperty(host);
    const other = key === 'ANTHROPIC_API_KEY' ? 'OPENAI' : 'ANTHROPIC';
    expect(session[`${other}_API_KEY`]).toBe(proxy.key);
    expect(catalog[`${other}_API_KEY`]).toBe(proxy.key);
  },
);

it('keeps Pi customizations while routing credential-free providers and Codex models', async () => {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const root = await mkdtemp('/var/tmp/beeline-proxy-pi-models-');
  roots.push(root);
  const operatorHome = join(root, 'operator');
  await mkdir(join(operatorHome, '.pi/agent'), { recursive: true });
  await writeFile(
    join(operatorHome, '.pi/agent/models.json'),
    JSON.stringify({
      providers: {
        anthropic: { modelOverrides: { 'claude-sonnet-4-6': { maxTokens: 1234 } } },
        openai: { apiKey: 'own-key', baseUrl: 'https://own.example/v1' },
        'openai-codex': { models: [{ id: 'custom-codex', name: 'Custom Codex' }] },
      },
    }),
  );
  const sessionRoot = join(root, 'home');
  const env = await prepareRoomAgentCredentials({
    root: sessionRoot,
    operatorHome,
    agentKind: 'pi',
    cliProxy: proxy,
  });
  tmpLinks.push(env.TMPDIR!);
  const runtime = await ModelRuntime.create({
    modelsPath: join(sessionRoot, 'pi/models.json'),
    authPath: join(sessionRoot, 'pi/auth.json'),
    modelsStorePath: join(sessionRoot, 'pi/models-store.json'),
    refreshOnCreate: false,
  });
  expect(runtime.getError()).toBeUndefined();
  expect(runtime.getModel('anthropic', 'claude-sonnet-4-6')).toMatchObject({
    baseUrl: proxy.url,
    maxTokens: 1234,
  });
  expect(runtime.getModel('openai', 'gpt-5')).toMatchObject({ baseUrl: 'https://own.example/v1' });
  for (const id of ['gpt-5.4', 'custom-codex']) {
    const model = runtime.getModel('openai-codex', id)!;
    expect(model).toMatchObject({
      id,
      provider: 'openai-codex',
      api: 'openai-responses',
      baseUrl: `${proxy.url}/v1`,
    });
    expect((await runtime.getAuth(model))?.auth.apiKey).toBe(proxy.key);
  }
});

it('removes the login link a home kept from before the proxy', async () => {
  const root = await mkdtemp('/var/tmp/beeline-proxy-upgrade-');
  roots.push(root);
  const operatorHome = join(root, 'operator');
  await mkdir(join(operatorHome, '.claude'), { recursive: true });
  await writeFile(join(operatorHome, '.claude', '.credentials.json'), 'native');
  const home = join(root, 'home');
  await mkdir(join(home, 'claude'), { recursive: true });
  const { symlink, lstat } = await import('node:fs/promises');
  await symlink(
    join(operatorHome, '.claude', '.credentials.json'),
    join(home, 'claude', '.credentials.json'),
  );
  const env = await prepareRoomAgentHome({
    root: home,
    operatorHome,
    agentKind: 'claude',
    cliProxy: proxy,
  });
  tmpLinks.push(env.TMPDIR!);
  await expect(lstat(join(home, 'claude', '.credentials.json'))).rejects.toThrow();
  expect(await readFile(join(operatorHome, '.claude', '.credentials.json'), 'utf8')).toBe('native');
});

it('starts a session with no login at all while the proxy is down', async () => {
  const root = await mkdtemp('/var/tmp/beeline-proxy-down-');
  roots.push(root);
  const env = await prepareRoomAgentCredentials({
    root: join(root, 'home'),
    operatorHome: join(root, 'operator'),
    agentKind: 'claude',
  });
  tmpLinks.push(env.TMPDIR!);
  expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL');
  expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
});

/**
 * Before the proxy, each session held its own copy of the operator's rotating
 * refresh token: one session's refresh replaced its copy and left every
 * other session (and the operator) on a spent token until a watcher copied
 * it back. Now the one login lives in the proxy's masked store. Two sessions
 * on that account, refreshing at once, hold no token to rotate and cannot
 * reach the store, so neither can overwrite the other's login.
 */
it("two concurrent sessions on one account never overwrite each other's login", async () => {
  const root = await mkdtemp('/var/tmp/beeline-proxy-sessions-');
  roots.push(root);
  const operatorHome = join(root, 'operator');
  const login = join(cliProxyDir(operatorHome), 'auth', 'beeline-claude.json');
  await mkdir(join(login, '..'), { recursive: true });
  const stored = JSON.stringify({
    type: 'claude',
    access_token: 'proxy-access',
    refresh_token: 'proxy-refresh',
  });
  await writeFile(login, stored);
  const nativeFiles = [
    '.claude/.credentials.json',
    '.codex/auth.json',
    '.grok/auth.json',
    '.pi/agent/auth.json',
    '.local/share/opencode/auth.json',
  ];
  const native = JSON.stringify({
    claudeAiOauth: { accessToken: 'native', refreshToken: 'native-refresh' },
  });
  for (const file of nativeFiles) {
    await mkdir(join(operatorHome, file, '..'), { recursive: true });
    await writeFile(join(operatorHome, file), native);
  }
  const session = async (name: string) => {
    const env = await prepareRoomAgentCredentials({
      root: join(root, name),
      operatorHome,
      agentKind: 'claude',
      cliProxy: proxy,
    });
    tmpLinks.push(env.TMPDIR!);
    const { stateDirs, tmpDir } = harnessStateDirsFromEnv(env);
    const command = wrapAgentCommand({
      bwrapPath: '/usr/bin/bwrap',
      spec: {
        mode: 'edit',
        cwd: join(root, name),
        harnessStateDirs: stateDirs,
        tmpDir,
        additionalWritablePaths: harnessLoginWritablePaths('claude', operatorHome),
        maskPaths: credentialMaskPaths(undefined, operatorHome),
      },
      command: process.execPath,
      args: [
        '--input-type=module',
        '-e',
        `
        import fs from 'node:fs';
        import assert from 'node:assert/strict';
        const dir = process.env.CLAUDE_CONFIG_DIR;
        assert.equal(fs.existsSync(dir + '/.credentials.json'), false);
        assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, ${JSON.stringify(proxy.key)});
        // The proxy's store is masked: unreadable and unwritable.
        assert.throws(() => fs.readFileSync(${JSON.stringify(login)}, 'utf8'));
        assert.throws(() => fs.writeFileSync(${JSON.stringify(login)}, 'rotated by ${name}'));
        for (const file of ${JSON.stringify(nativeFiles)}) {
          const path = ${JSON.stringify(operatorHome)} + '/' + file;
          // A /dev/null bind on a nodev mount may deny reads instead of
          // returning EOF. Either outcome must hide the host credential.
          let body = '';
          try { body = fs.readFileSync(path, 'utf8'); }
          catch (error) { assert.equal(error.code, 'EACCES'); }
          assert.equal(body, '');
          assert.throws(() => fs.writeFileSync(path, 'rotated by ${name}'));
        }
        // Whatever the harness persists stays in its own private home.
        fs.writeFileSync(dir + '/.credentials.json', 'rotated by ${name}');
      `,
      ],
    });
    await run(command.command, command.args, { env: { ...process.env, ...env } });
    return env;
  };
  const [a, b] = await Promise.all([session('a'), session('b')]);
  expect(await readFile(login, 'utf8')).toBe(stored);
  for (const file of nativeFiles)
    expect(await readFile(join(operatorHome, file), 'utf8')).toBe(native);
  expect(await readFile(join(a.CLAUDE_CONFIG_DIR!, '.credentials.json'), 'utf8')).toBe(
    'rotated by a',
  );
  expect(await readFile(join(b.CLAUDE_CONFIG_DIR!, '.credentials.json'), 'utf8')).toBe(
    'rotated by b',
  );
  expect(JSON.stringify([a, b])).not.toMatch(/refresh/);
  // The next activation's home setup removes whatever login file a session kept.
  const again = await prepareRoomAgentHome({
    root: join(root, 'a'),
    operatorHome,
    agentKind: 'claude',
    cliProxy: proxy,
  });
  expect(again.ANTHROPIC_BASE_URL).toBe(proxy.url);
  await expect(readFile(join(a.CLAUDE_CONFIG_DIR!, '.credentials.json'), 'utf8')).rejects.toThrow();
});

it('scrubs migrated quarantine logins while preserving static keys and Cursor state', async () => {
  const root = await mkdtemp('/var/tmp/beeline-proxy-quarantine-');
  roots.push(root);
  const operatorHome = join(root, 'operator');
  const home = join(root, 'session');
  const files = [
    'claude/.credentials.json',
    'codex/auth.json',
    'grok/auth.json',
    'pi/auth.json',
    'user/.local/share/opencode/auth.json',
  ];
  for (const file of files) {
    await mkdir(join(home, file, '..'), { recursive: true });
    await writeFile(join(home, file + '.beeline-quarantine-old'), 'retired-refresh');
    await writeFile(join(home, file), 'retired-refresh');
  }
  await mkdir(join(home, 'cursor'), { recursive: true });
  await writeFile(
    join(home, 'cursor/agent-cli-state.json.beeline-quarantine-old'),
    'cursor-native',
  );
  await mkdir(join(operatorHome, '.pi/agent'), { recursive: true });
  await mkdir(join(operatorHome, '.local/share/opencode'), { recursive: true });
  await writeFile(
    join(operatorHome, '.pi/agent/auth.json'),
    JSON.stringify({ openrouter: { type: 'api_key', key: 'pi-key' } }),
  );
  await writeFile(
    join(operatorHome, '.local/share/opencode/auth.json'),
    JSON.stringify({ openrouter: { type: 'api', key: 'opencode-key' } }),
  );
  const env = await prepareRoomAgentHome({
    root: home,
    operatorHome,
    agentKind: 'pi',
    cliProxy: proxy,
  });
  tmpLinks.push(env.TMPDIR!);
  for (const file of files)
    await expect(readFile(join(home, file + '.beeline-quarantine-old'))).rejects.toThrow();
  for (const file of files.slice(0, 3)) await expect(readFile(join(home, file))).rejects.toThrow();
  expect(JSON.parse(await readFile(join(home, 'pi/auth.json'), 'utf8'))).toEqual({
    openrouter: { type: 'api_key', key: 'pi-key' },
  });
  expect(
    JSON.parse(await readFile(join(home, 'user/.local/share/opencode/auth.json'), 'utf8')),
  ).toEqual({ openrouter: { type: 'api', key: 'opencode-key' } });
  expect(
    await readFile(join(home, 'cursor/agent-cli-state.json.beeline-quarantine-old'), 'utf8'),
  ).toBe('cursor-native');
});

it.each([
  { existingParents: false, dependencies: false },
  { existingParents: true, dependencies: false },
  { existingParents: false, dependencies: true },
])(
  'hides native logins and proxy stores created after the sandbox starts ($existingParents, dependencies: $dependencies)',
  async ({ existingParents, dependencies }) => {
    const root = await mkdtemp('/var/tmp/beeline-proxy-late-login-');
    roots.push(root);
    const operatorHome = join(root, 'operator');
    const session = join(operatorHome, 'session');
    await mkdir(operatorHome);
    await mkdir(session);
    const state = join(session, 'state');
    await mkdir(state);
    const layer = {
      tree: join(session, 'dependencies'),
      upper: join(state, 'upper'),
      work: join(state, 'work'),
    };
    if (dependencies) {
      for (const path of Object.values(layer)) await mkdir(path);
      await writeFile(join(layer.tree, 'package.json'), 'shared-package');
    }
    const files = [
      '.claude/.credentials.json',
      '.codex/auth.json',
      '.grok/auth.json',
      '.pi/agent/auth.json',
      '.local/share/opencode/auth.json',
      '.config/beeline/cliproxy/config.yaml',
      '.config/beeline/cliproxy/auth/beeline-claude.json',
    ];
    if (existingParents) {
      for (const parent of [
        '.claude',
        '.codex',
        '.grok',
        '.pi/agent',
        '.local/share/opencode',
        '.config',
      ])
        await mkdir(join(operatorHome, parent), { recursive: true });
    }
    await writeFile(join(operatorHome, 'settings.json'), 'operator-settings');
    const command = wrapAgentCommand({
      bwrapPath: '/usr/bin/bwrap',
      spec: {
        mode: 'edit',
        cwd: session,
        harnessStateDirs: [state],
        maskPaths: credentialMaskPaths(undefined, operatorHome),
        ...(dependencies ? { dependencyLayers: [layer] } : {}),
      },
      command: process.execPath,
      args: [
        '--input-type=module',
        '-e',
        `
      import fs from 'node:fs';
      import assert from 'node:assert/strict';
      assert.equal(fs.readFileSync(${JSON.stringify(join(operatorHome, 'settings.json'))}, 'utf8'), 'operator-settings');
      assert.throws(() => fs.writeFileSync(${JSON.stringify(join(operatorHome, 'escape'))}, 'escape'), { code: 'EROFS' });
      assert.equal(fs.existsSync('/dev/shm/beeline-masks'), false);
      fs.writeFileSync(${JSON.stringify(join(state, 'private'))}, 'private-state');
      if (${dependencies}) fs.writeFileSync(${JSON.stringify(join(layer.tree, 'package.json'))}, 'private-package');
      process.stdin.once('data', () => {
        for (const file of ${JSON.stringify(files)}) {
          let body = '';
          try { body = fs.readFileSync(${JSON.stringify(operatorHome)} + '/' + file, 'utf8'); } catch {}
          assert.equal(body, '');
        }
        assert.equal(fs.readFileSync(${JSON.stringify(join(operatorHome, '.cursor/agent-cli-state.json'))}, 'utf8'), 'cursor-native');
        process.stdin.destroy();
      });
      process.stdout.write('ready');
    `,
      ],
    });
    await new Promise<void>((done, fail) => {
      const child = spawn(command.command, command.args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.once('error', fail);
      child.once('exit', (code) =>
        code === 0 ? done() : fail(new Error(stderr || `sandbox exited ${code}`)),
      );
      child.stdout.once('data', () => {
        void (async () => {
          // Namespace mountpoint preparation must not create host stores.
          for (const file of files)
            await expect(readFile(join(operatorHome, file))).rejects.toThrow();
          if (!existingParents)
            await expect(lstat(join(operatorHome, '.claude'))).rejects.toThrow();
          for (const file of [...files, '.cursor/agent-cli-state.json']) {
            await mkdir(join(operatorHome, file, '..'), { recursive: true });
            await writeFile(
              join(operatorHome, file),
              file.startsWith('.cursor/') ? 'cursor-native' : 'host-refresh',
            );
          }
          child.stdin.end('check');
        })().catch(fail);
      });
    });
    for (const file of files)
      expect(await readFile(join(operatorHome, file), 'utf8')).toBe('host-refresh');
    expect(await readFile(join(state, 'private'), 'utf8')).toBe('private-state');
    if (dependencies) {
      expect(await readFile(join(layer.tree, 'package.json'), 'utf8')).toBe('shared-package');
      expect(await readFile(join(layer.upper, 'package.json'), 'utf8')).toBe('private-package');
    }
  },
);

it('a free agent never reaches the proxy: its machine starts none and its hosted model stays its own', async () => {
  // Free-agent helpers never start the machine proxy, so nothing waits on it.
  expect(machineCliProxyEndpoint()).toBeUndefined();
  await expect(machineCliProxy()).resolves.toBeUndefined();
  const root = await mkdtemp('/var/tmp/beeline-proxy-free-');
  roots.push(root);
  const operatorHome = join(root, 'operator');
  const hosted = freeAgentPiConfig({ modelBaseUrl: 'https://beeline.test/v1/free-agents/model', upstreamModel: 'deepseek/deepseek-v4.1-flash' });
  await mkdir(join(operatorHome, '.pi', 'agent'), { recursive: true });
  await writeFile(join(operatorHome, '.pi', 'agent', 'models.json'), hosted);
  const env = await prepareRoomAgentCredentials({
    root: join(root, 'home'), operatorHome, agentKind: 'pi', failClosed: true,
    cliProxy: machineCliProxyEndpoint(), agentEnv: { BEELINE_FREE_AGENT_MODEL_TOKEN: 'free-token' },
  });
  tmpLinks.push(env.TMPDIR!);
  expect(JSON.parse(await readFile(join(root, 'home', 'pi', 'models.json'), 'utf8'))).toEqual(JSON.parse(hosted));
});

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import type { AgentKind } from './agent-command.js';
import { harnessLoginWritablePaths, harnessStateDirsFromEnv, prepareRoomAgentCredentials, prepareRoomAgentHome } from './agent-home.js';
import { writeOpenCodeKey } from './agent-sign-in.js';
import { harnessHomeStateDirs, sessionCredentialMaskPaths, wrapAgentCommand } from './bwrap-sandbox.js';
import { testTmpDir } from '../../../packages/test-helpers/helpers/helper.js';

const run = promisify(execFile);
const roots: string[] = [];
const tmpLinks: string[] = [];
afterEach(async () => {
  await Promise.all(tmpLinks.splice(0).map(path => rm(path, { force: true })));
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const nativeLoginCases: Array<{ kind: AgentKind; source: string; privateFile: string; harness?: string }> = [
  { kind: 'cursor', source: '.config/cursor/auth.json', privateFile: 'user/.config/cursor/auth.json' },
  { kind: 'cursor', source: '.cursor/agent-cli-state.json', privateFile: 'cursor/agent-cli-state.json' },
  {
    kind: 'antigravity',
    source: '.gemini/antigravity-cli/antigravity-oauth-token',
    privateFile: 'user/.gemini/antigravity-cli/antigravity-oauth-token',
    harness: '/usr/local/bin/agy',
  },
];
const proxied: Array<{ kind: AgentKind; source: string; privateFile: string }> = [
  { kind: 'claude', source: '.claude/.credentials.json', privateFile: 'claude/.credentials.json' },
  { kind: 'pi', source: '.pi/agent/auth.json', privateFile: 'pi/auth.json' },
  { kind: 'codex', source: '.codex/auth.json', privateFile: 'codex/auth.json' },
  { kind: 'grok', source: '.grok/auth.json', privateFile: 'grok/auth.json' },
  { kind: 'opencode', source: '.local/share/opencode/auth.json', privateFile: 'user/.local/share/opencode/auth.json' },
];

async function sandboxed(mode: 'readonly' | 'edit', root: string, env: Record<string, string>, kind: AgentKind, operatorHome: string, script: string, opts: { harness?: string; masked?: boolean } = {}) {
  const { stateDirs, tmpDir } = harnessStateDirsFromEnv(env);
  const command = wrapAgentCommand({ bwrapPath: '/usr/bin/bwrap',
    spec: { mode, cwd: root, harnessStateDirs: stateDirs, tmpDir, harnessHomeStateDirs: harnessHomeStateDirs(opts.harness, env.HOME),
      additionalWritablePaths: harnessLoginWritablePaths(kind, operatorHome),
      ...(opts.masked ? { maskPaths: sessionCredentialMaskPaths({ agentKind: kind }, operatorHome) } : {}) },
    command: process.execPath, args: ['--input-type=module', '-e',
      `import fs from 'node:fs';\nimport assert from 'node:assert/strict';\n${script}`] });
  await run(command.command, command.args, { env: { ...process.env, ...env } });
}

for (const mode of ['readonly', 'edit'] as const) {
  it.each(nativeLoginCases)('$kind native login store $source supports refresh in ' + mode + ' mode', async ({ kind, source, privateFile, harness }) => {
    const root = await mkdtemp(`${testTmpDir()}/beeline-login-mounts-`); roots.push(root);
    const operatorHome = join(root, 'operator');
    const shared = join(operatorHome, source);
    await mkdir(dirname(shared), { recursive: true });
    await mkdir(join(operatorHome, '.cursor'), { recursive: true });
    await mkdir(join(operatorHome, '.config', 'cursor'), { recursive: true });
    await writeFile(shared, '{}');
    await writeFile(join(operatorHome, 'unrelated.json'), 'unrelated');
    const privateRoot = join(root, 'private');
    const env = await prepareRoomAgentCredentials({ root: privateRoot, operatorHome, agentKind: kind });
    tmpLinks.push(env.TMPDIR!);
    const credential = join(privateRoot, privateFile);
    await sandboxed(mode, root, env, kind, operatorHome, `
      const target = fs.realpathSync(${JSON.stringify(credential)});
      fs.writeFileSync(target + '.next', JSON.stringify({ refreshed: true }));
      fs.renameSync(target + '.next', target);
      // The harness's own bookkeeping beside the link stays writable too.
      fs.writeFileSync(${JSON.stringify(join(dirname(credential), 'state.next'))}, 'state');
      assert.throws(() => fs.writeFileSync(${JSON.stringify(join(operatorHome, 'unrelated.json'))}, 'escape'), { code: 'EROFS' });`, { harness, masked: true });
    expect(JSON.parse(await readFile(shared, 'utf8'))).toEqual({ refreshed: true });
    expect(await readFile(join(operatorHome, 'unrelated.json'), 'utf8')).toBe('unrelated');
  });

  it.each(proxied)('$kind session holds no provider login and cannot write the operator store in ' + mode + ' mode', async ({ kind, source, privateFile }) => {
    const root = await mkdtemp(`${testTmpDir()}/beeline-login-mounts-`); roots.push(root);
    const operatorHome = join(root, 'operator');
    const shared = join(operatorHome, source);
    await mkdir(dirname(shared), { recursive: true });
    const oauth = JSON.stringify({ native: { type: 'oauth', refresh: 'operator-refresh' } });
    await writeFile(shared, oauth);
    const privateRoot = join(root, 'private');
    const env = await prepareRoomAgentCredentials({ root: privateRoot, operatorHome, agentKind: kind,
      cliProxy: { url: 'http://127.0.0.1:9', key: 'local-key' } });
    tmpLinks.push(env.TMPDIR!);
    expect(harnessLoginWritablePaths(kind, operatorHome)).toEqual([]);
    // Grok's private sign-in record holds only the local inference key.
    const privateLogin = join(privateRoot, privateFile);
    await sandboxed(mode, root, env, kind, operatorHome, `
      const login = ${JSON.stringify(privateLogin)};
      assert.ok(!fs.existsSync(login) || !fs.readFileSync(login, 'utf8').includes('operator-refresh'));
      assert.equal(fs.existsSync(login), ${JSON.stringify(kind === 'grok')});
      assert.throws(() => fs.writeFileSync(${JSON.stringify(shared)}, 'escape'), { code: 'EROFS' });`);
    expect(await readFile(shared, 'utf8')).toBe(oauth);
    expect(JSON.stringify(env)).not.toContain('operator-refresh');
  });

  it.each([
    ...(['codex', 'cursor', undefined] as const).map((kind) => ({ kind, linked: false })),
    { kind: 'codex' as const, linked: true },
  ])('$kind session cannot see the Antigravity sign-in (symlinked cache: $linked) in ' + mode + ' mode', async ({ kind, linked }) => {
    const root = await mkdtemp(`${testTmpDir()}/beeline-login-mounts-`); roots.push(root);
    const operatorHome = join(root, 'operator');
    const cache = join(operatorHome, '.gemini/antigravity-cli');
    if (linked) {
      // The operator keeps the real cache elsewhere and links it into place.
      await mkdir(join(root, 'elsewhere/agy'), { recursive: true });
      await mkdir(dirname(cache), { recursive: true });
      await symlink(join(root, 'elsewhere/agy'), cache);
    } else await mkdir(cache, { recursive: true });
    await writeFile(join(cache, 'antigravity-oauth-token'), 'operator-agy-token');
    const privateRoot = join(root, 'private');
    // A home that served Antigravity before keeps a stale link until repaired.
    await prepareRoomAgentCredentials({ root: privateRoot, operatorHome, agentKind: 'antigravity' }).then(env => tmpLinks.push(env.TMPDIR!));
    const privateLogin = join(privateRoot, 'user/.gemini/antigravity-cli/antigravity-oauth-token');
    expect(await readFile(privateLogin, 'utf8')).toBe('operator-agy-token');
    const env = await prepareRoomAgentCredentials({ root: privateRoot, operatorHome, agentKind: kind });
    await sandboxed(mode, root, env, kind as AgentKind, operatorHome, `
      assert.equal(fs.existsSync(${JSON.stringify(privateLogin)}), false);
      assert.deepEqual(fs.readdirSync(${JSON.stringify(cache)}), []);
      if (${linked}) assert.deepEqual(fs.readdirSync(${JSON.stringify(join(root, 'elsewhere/agy'))}), []);`, { masked: true });
    expect(await readFile(join(cache, 'antigravity-oauth-token'), 'utf8')).toBe('operator-agy-token');
  });
}

it.each([
  { kind: 'pi' as const, source: '.pi/agent/auth.json', target: 'pi/auth.json', key: { type: 'api_key', key: 'sk-pi' } },
  { kind: 'opencode' as const, source: '.local/share/opencode/auth.json', target: 'user/.local/share/opencode/auth.json', key: { type: 'api', key: 'sk-oc' } },
])('$kind keeps its API keys and drops OAuth entries', async ({ kind, source, target, key }) => {
  const root = await mkdtemp(`${testTmpDir()}/beeline-login-keys-`); roots.push(root);
  const operatorHome = join(root, 'operator');
  await mkdir(dirname(join(operatorHome, source)), { recursive: true });
  await writeFile(join(operatorHome, source), JSON.stringify({ openrouter: key, anthropic: { type: 'oauth', refresh: 'r' } }));
  if (kind === 'opencode') await writeOpenCodeKey(operatorHome, 'openai', 'sk-openai');
  const env = await prepareRoomAgentCredentials({ root: join(root, 'private'), operatorHome, agentKind: kind });
  tmpLinks.push(env.TMPDIR!);
  const copy = JSON.parse(await readFile(join(root, 'private', target), 'utf8'));
  expect(copy.openrouter).toEqual(key);
  expect(copy.anthropic).toBeUndefined();
  if (kind === 'opencode') expect(copy.openai).toEqual({ type: 'api', key: 'sk-openai' });
});

for (const mode of ['readonly', 'edit'] as const) {
  it('keeps Goose operator config read-only and private login files writable in ' + mode + ' mode', async () => {
    const root = await mkdtemp(`${testTmpDir()}/beeline-goose-login-`); roots.push(root);
    const operatorHome = join(root, 'operator');
    const configDir = join(operatorHome, '.config', 'goose');
    await mkdir(configDir, { recursive: true });
    const config = 'GOOSE_PROVIDER: anthropic\nGOOSE_MODEL: test\n';
    const secrets = 'ANTHROPIC_API_KEY: login\n';
    await writeFile(join(configDir, 'config.yaml'), config);
    await writeFile(join(configDir, 'secrets.yaml'), secrets);
    const env = await prepareRoomAgentHome({ root: join(root, 'private'), operatorHome, agentKind: 'goose' });
    tmpLinks.push(env.TMPDIR!);
    const { stateDirs, tmpDir } = harnessStateDirsFromEnv(env);
    const command = wrapAgentCommand({ bwrapPath: '/usr/bin/bwrap',
      spec: { mode, cwd: root, harnessStateDirs: stateDirs, tmpDir,
        additionalWritablePaths: harnessLoginWritablePaths('goose', operatorHome) },
      command: process.execPath, args: ['-e', `
        const fs = require('node:fs');
        const assert = require('node:assert/strict');
        for (const name of ['config.yaml', 'secrets.yaml']) {
          const path = process.env.GOOSE_PATH_ROOT + '/config/' + name;
          assert.equal(fs.lstatSync(path).isSymbolicLink(), false);
          fs.writeFileSync(path + '.next', 'private login or refresh');
          fs.renameSync(path + '.next', path);
          assert.throws(() => fs.writeFileSync(${JSON.stringify(configDir)} + '/' + name, 'escape'), { code: 'EROFS' });
        }
      `] });
    await run(command.command, command.args, { env: { ...process.env, ...env } });
    expect(await readFile(join(configDir, 'config.yaml'), 'utf8')).toBe(config);
    expect(await readFile(join(configDir, 'secrets.yaml'), 'utf8')).toBe(secrets);
  });
}

it('does not mount absent or unrelated operator stores writable', async () => {
  const root = await mkdtemp(`${testTmpDir()}/beeline-login-missing-`); roots.push(root);
  for (const kind of ['claude', 'codex', 'pi', 'cursor', 'opencode', 'grok', 'goose', 'custom', 'reference', undefined] as const)
    expect(harnessLoginWritablePaths(kind, root)).toEqual([]);
});

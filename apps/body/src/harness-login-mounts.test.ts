import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import type { AgentKind } from './agent-command.js';
import { harnessStateDirsFromEnv, prepareRoomAgentCredentials, prepareRoomAgentHome, writeBackRoomClaudeLogin } from './agent-home.js';
import { writeClaudeCredentials } from './claude-sign-in.js';
import { writeOpenCodeKey } from './agent-sign-in.js';
import { wrapAgentCommand } from './bwrap-sandbox.js';
import { harnessLoginWritablePaths } from './harness-login-mounts.js';

const run = promisify(execFile);
const roots: string[] = [];
const tmpLinks: string[] = [];
afterEach(async () => {
  await Promise.all(tmpLinks.splice(0).map(path => rm(path, { force: true })));
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const cases: Array<{ kind: AgentKind; source: string; privateFile: string; fallback?: boolean }> = [
  { kind: 'claude', source: '.claude/.credentials.json', privateFile: 'claude/.credentials.json' },
  { kind: 'pi', source: '.pi/agent/auth.json', privateFile: 'pi/auth.json', fallback: true },
  { kind: 'codex', source: '.codex/auth.json', privateFile: 'codex/auth.json', fallback: true },
  { kind: 'grok', source: '.grok/auth.json', privateFile: 'grok/auth.json', fallback: true },
  { kind: 'cursor', source: '.config/cursor/auth.json', privateFile: 'user/.config/cursor/auth.json', fallback: true },
  { kind: 'cursor', source: '.cursor/agent-cli-state.json', privateFile: 'cursor/agent-cli-state.json', fallback: true },
  { kind: 'opencode', source: '.local/share/opencode/auth.json', privateFile: 'user/.local/share/opencode/auth.json', fallback: true },
];

for (const mode of ['readonly', 'edit'] as const) {
  it.each(cases)('$kind login store supports refresh in ' + mode + ' mode', async ({ kind, source, privateFile, fallback }) => {
    const root = await mkdtemp('/var/tmp/beeline-login-mounts-'); roots.push(root);
    const operatorHome = join(root, 'operator');
    const shared = join(operatorHome, source);
    const operatorSettings = join(dirname(shared), 'settings.json');
    const outside = join(operatorHome, 'unrelated.json');
    await mkdir(dirname(shared), { recursive: true });
    await writeFile(operatorSettings, 'operator settings');
    await writeFile(outside, 'unrelated');
    // The card dispatcher runs in the unsandboxed helper. These are the real
    // helper writers for Claude/OpenCode. Native CLI login is deliberately NOT
    // claimed proved by this test: its complete directory stays writable.
    if (kind === 'claude') await writeClaudeCredentials(operatorHome, {
      accessToken: 'login', refreshToken: 'login', expiresAt: 1000,
      scopes: ['user:inference'], subscriptionType: null, rateLimitTier: null,
    });
    else if (kind === 'opencode') await writeOpenCodeKey(operatorHome, 'openai', 'login');
    else await writeFile(shared, '{}');
    if (kind === 'cursor') {
      await mkdir(join(operatorHome, '.cursor'), { recursive: true });
      await writeFile(join(operatorHome, '.cursor', 'agent-cli-state.json'), '{}');
    }
    const privateRoot = join(root, 'private');
    const env = await prepareRoomAgentCredentials({ root: privateRoot, operatorHome, agentKind: kind });
    tmpLinks.push(env.TMPDIR!);
    const { stateDirs, tmpDir } = harnessStateDirsFromEnv(env);
    const credential = join(privateRoot, privateFile);
    const command = wrapAgentCommand({ bwrapPath: '/usr/bin/bwrap',
      spec: { mode, cwd: root, harnessStateDirs: stateDirs, tmpDir,
        additionalWritablePaths: harnessLoginWritablePaths(kind, operatorHome) },
      command: process.execPath, args: ['--input-type=module', '-e', `
        import fs from 'node:fs';
        import assert from 'node:assert/strict';
        const credential = ${JSON.stringify(credential)};
        assert.ok(fs.existsSync(credential));
        // Prove rename and lock availability, including writers that resolve
        // the credential link before staging. This is a filesystem contract,
        // not a claim to have authenticated against a native provider.
        const target = ${JSON.stringify(kind)} === 'claude' ? credential : fs.realpathSync(credential);
        fs.writeFileSync(target + '.lock', 'lock');
        fs.writeFileSync(target + '.next', JSON.stringify({ claudeAiOauth: { accessToken: 'refresh', expiresAt: 2000 } }));
        fs.renameSync(target + '.next', target);
        fs.unlinkSync(target + '.lock');
        const settings = ${JSON.stringify(operatorSettings)};
        if (${Boolean(fallback)}) fs.writeFileSync(settings, 'writable fallback');
        else assert.throws(() => fs.writeFileSync(settings, 'escape'), { code: 'EROFS' });
        assert.throws(() => fs.writeFileSync(${JSON.stringify(outside)}, 'escape'), { code: 'EROFS' });
      `] });
    await run(command.command, command.args, { env: { ...process.env, ...env } });
    if (kind === 'claude') await writeBackRoomClaudeLogin({ root: privateRoot, operatorHome });
    const refreshed = JSON.parse(await readFile(shared, 'utf8'));
    expect(refreshed.claudeAiOauth.accessToken).toBe('refresh');
    expect(await readFile(operatorSettings, 'utf8')).toBe(fallback ? 'writable fallback' : 'operator settings');
    expect(await readFile(outside, 'utf8')).toBe('unrelated');
  });

  it('keeps Goose operator config read-only and private login files writable in ' + mode + ' mode', async () => {
    const root = await mkdtemp('/var/tmp/beeline-goose-login-'); roots.push(root);
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
  const root = await mkdtemp('/var/tmp/beeline-login-missing-'); roots.push(root);
  for (const kind of ['claude', 'codex', 'pi', 'cursor', 'opencode', 'grok', 'goose', 'custom', 'reference', undefined] as const)
    expect(harnessLoginWritablePaths(kind, root)).toEqual([]);
});

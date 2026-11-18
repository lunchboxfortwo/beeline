import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentSignIn,
  agentSignInFrame,
  answerAgentSignInFrame,
  reportAgentSignInResult,
  type AgentSignInOptions,
} from './agent-sign-in.js';
import { HarnessQuotaReader, invalidateQuotaReads } from './harness-quota.js';
import { CODEX_DEVICE_OUTPUT, CURSOR_LOGIN_OUTPUT, GROK_DEVICE_OUTPUT } from '../../../packages/test-helpers/helpers/helper.js';

const ATTEMPT = '00000000-0000-4000-8000-000000000001';
const CARD = 'c'.repeat(64);

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed: string | undefined;
  kill(signal: string) {
    this.killed = signal;
    this.emit('exit', null, signal);
    this.emit('close', null, signal);
    return true;
  }
  print(text: string) {
    this.stdout.write(text);
  }
  finish(code: number) {
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }
}

describe('@agent login on the agent machine', () => {
  let home: string;
  let children: FakeChild[];
  let spawnCalls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }>;
  let results: Array<{ attemptId: string; result: unknown }>;
  let saved: Array<{ provider: string; login: Record<string, unknown> }>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'agent-sign-in-'));
    children = [];
    spawnCalls = [];
    results = [];
    saved = [];
  });
  const spawned = async (index: number) => {
    await vi.waitFor(() => expect(children[index]).toBeDefined());
    return children[index]!;
  };
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function signIn(overrides: Partial<AgentSignInOptions>) {
    return new AgentSignIn({
      harness: 'codex',
      operatorHome: home,
      agentEnv: { PATH: '/agent/bin' },
      onResult: (attemptId, result) => results.push({ attemptId, result }),
      spawn: ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        spawnCalls.push({ command, args, env: options.env });
        const child = new FakeChild();
        children.push(child);
        return child;
      }) as never,
      now: () => 1_800_000_000_000,
      proxy: async () => ({
        saveLogin: async (provider, login) => { saved.push({ provider, login }); },
        login: (flag) => ({ command: '/proxy/cli-proxy-api', args: [flag, '-no-browser', '-config', '/proxy/config.yaml'], env: { HOME: '/proxy' } }),
      }),
      ...overrides,
    });
  }

  it.each(['pi', 'opencode'] as const)('reads the current async model for each %s login', async harness => {
    let selected = 'anthropic/claude-sonnet-4-6';
    const model = vi.fn(async () => selected);
    const login = signIn({ harness, model });
    await expect(login.start('claude-attempt')).resolves.toMatchObject({ kind: 'paste-code' });
    selected = harness === 'pi' ? 'openai-codex/gpt-5.4' : 'openai/gpt-5.4';
    const next = login.start(ATTEMPT);
    (await spawned(0)).print(CODEX_DEVICE_OUTPUT);
    await expect(next).resolves.toMatchObject({ kind: 'device-code' });
    expect(spawnCalls[0]!.args[0]).toBe('-codex-device-login');
    expect(model).toHaveBeenCalledTimes(2);
    login.stop();
  });

  it('uses one resolved model for the OpenCode key fallback', async () => {
    const model = vi.fn().mockResolvedValueOnce('openrouter/example/model').mockResolvedValueOnce('google/example');
    await expect(signIn({ harness: 'opencode', model }).start(ATTEMPT)).resolves.toEqual({ kind: 'api-key', provider: 'openrouter' });
    expect(model).toHaveBeenCalledOnce();
  });

  it.each(['claude', 'codex', 'grok', 'cursor'] as const)('invalidates cached quota after successful %s sign-in', async harness => {
    invalidateQuotaReads();
    const run = vi.fn().mockResolvedValueOnce(JSON.stringify({ providers: [{ provider: harness, state: { status: 'auth_required' } }] }))
      .mockResolvedValueOnce(JSON.stringify({ providers: [{ provider: harness, state: { status: 'fresh' }, windows: [{ id: 'weekly', percentRemaining: 90 }] }] }));
    const reader = new HarnessQuotaReader({ agentId: 'login-test', run, post: async () => {}, now: () => 0,
      launch: () => ({ command: 'quota', args: [] }), proxy: async () => ({ readLogin: async () => ({ access_token: 'quota-access' }) }),
    });
    await reader.publish(harness, { HOME: home });
    const login = signIn({ harness, fetch: vi.fn(async () => Response.json({
      access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: 'user:inference',
    })) as never });
    const started = login.start(ATTEMPT);
    if (harness === 'claude') {
      const link = await started;
      const state = new URL(link.kind === 'paste-code' ? link.authorizeUrl : '').searchParams.get('state');
      await login.submit(ATTEMPT, `code#${state}`);
    } else {
      (await spawned(0)).print(harness === 'cursor' ? CURSOR_LOGIN_OUTPUT : harness === 'grok' ? GROK_DEVICE_OUTPUT : CODEX_DEVICE_OUTPUT);
      await started;
      children[0]!.print(harness === 'cursor' ? '' : harness === 'grok' ? 'Authentication saved to /proxy/auth/xai-owner.json\nxAI authentication successful!\n' : 'Authentication saved to /proxy/auth/codex-owner.json\nCodex device authentication successful!\n');
      children[0]!.finish(0);
    }
    await expect(reader.publish(harness, { HOME: home }, true)).resolves.toEqual({ status: 'fresh' });
    expect(run).toHaveBeenCalledTimes(2);
    invalidateQuotaReads();
  });

  it("runs the proxy's own Codex device login and reports when it saved the login", async () => {
    const signedIn = vi.fn();
    const codex = signIn({ harness: 'codex', onSignedIn: signedIn });
    const started = codex.start(ATTEMPT);
    (await spawned(0)).print(CODEX_DEVICE_OUTPUT);
    await expect(started).resolves.toEqual({
      kind: 'device-code',
      authorizeUrl: 'https://auth.openai.com/codex/device',
      userCode: 'O55M-GK99G',
      expiresAt: 1_800_000_000_000 + 15 * 60_000,
    });
    expect(spawnCalls[0]).toEqual({ command: '/proxy/cli-proxy-api',
      args: ['-codex-device-login', '-no-browser', '-config', '/proxy/config.yaml'], env: { HOME: '/proxy' } });
    children[0]!.emit('exit', 0, null);
    expect(results).toEqual([]);
    children[0]!.print('Authentication saved to /proxy/auth/codex-owner@example.com-pro.json\nCodex device authentication successful!\n');
    children[0]!.emit('close', 0, null);
    expect(results).toEqual([{ attemptId: ATTEMPT, result: { ok: true } }]);
    expect(signedIn).toHaveBeenCalledTimes(1);
    // The proxy saved it; Beeline writes no login anywhere.
    expect(saved).toEqual([]);
    expect(await stat(join(home, '.codex')).catch(() => undefined)).toBeUndefined();
  });

  it("runs the proxy's own xAI device login for Grok", async () => {
    const grok = signIn({ harness: 'grok' });
    const started = grok.start(ATTEMPT);
    (await spawned(0)).print(GROK_DEVICE_OUTPUT);
    await expect(started).resolves.toMatchObject({ kind: 'device-code', userCode: 'DC7F-7GCV',
      authorizeUrl: 'https://accounts.x.ai/oauth2/device?user_code=DC7F-7GCV' });
    expect(spawnCalls[0]!.args[0]).toBe('-xai-login');
  });

  it.each([
    ['pi', 'openai-codex', '-codex-device-login'],
    ['pi', 'openai', '-codex-device-login'],
    ['pi', 'xai', '-xai-login'],
    ['goose', 'openai', '-codex-device-login'],
    ['opencode', 'openai', '-codex-device-login'],
    ['opencode', 'xai', '-xai-login'],
  ] as const)('uses the proxy login for %s on %s', async (harness, provider, flag) => {
    const sign = signIn({ harness, model: () => `${provider}/selected-model`, agentEnv: { GOOSE_PROVIDER: provider } });
    const started = sign.start(ATTEMPT);
    (await spawned(0)).print(provider === 'xai' ? GROK_DEVICE_OUTPUT : CODEX_DEVICE_OUTPUT);
    await expect(started).resolves.toMatchObject({ kind: 'device-code' });
    expect(spawnCalls[0]!.args[0]).toBe(flag);
    children[0]!.print(provider === 'xai' ? 'Authentication saved to /proxy/auth/xai-owner.json\nxAI authentication successful!\n' : 'Authentication saved to /proxy/auth/codex-owner.json\nCodex device authentication successful!\n');
    children[0]!.finish(0);
    expect(results).toEqual([{ attemptId: ATTEMPT, result: { ok: true } }]);
  });

  it('uses the provider saved in Goose configuration for subscription login', async () => {
    await mkdir(join(home, '.config/goose'), { recursive: true });
    await writeFile(join(home, '.config/goose/config.yaml'), 'GOOSE_PROVIDER: openai\n');
    const started = signIn({ harness: 'goose' }).start(ATTEMPT);
    (await spawned(0)).print(CODEX_DEVICE_OUTPUT);
    await expect(started).resolves.toMatchObject({ kind: 'device-code' });
    expect(spawnCalls[0]!.args[0]).toBe('-codex-device-login');
  });

  it('keeps the OpenCode API-key card for a stored provider key', async () => {
    await mkdir(join(home, '.local/share/opencode'), { recursive: true });
    await writeFile(join(home, '.local/share/opencode/auth.json'), JSON.stringify({ anthropic: { type: 'api', key: 'own' } }));
    await expect(signIn({ harness: 'opencode', model: () => 'anthropic/claude-sonnet-4-6' }).start(ATTEMPT))
      .resolves.toEqual({ kind: 'api-key', provider: 'anthropic' });
    expect(spawnCalls).toEqual([]);
  });

  it.each(['codex', 'grok'] as const)('fails %s login when authentication succeeds but saving fails', async harness => {
    const signedIn = vi.fn();
    const codex = signIn({ harness, onSignedIn: signedIn });
    const started = codex.start(ATTEMPT);
    (await spawned(0)).print(harness === 'grok' ? GROK_DEVICE_OUTPUT : CODEX_DEVICE_OUTPUT);
    await started;
    children[0]!.print('Authentication successful\n');
    children[0]!.print(`${harness === 'grok' ? 'xAI' : 'Codex device'} authentication failed: permission denied\n`);
    children[0]!.finish(0);
    expect(results).toEqual([{ attemptId: ATTEMPT,
      result: { ok: false, error: `\`${harness} login\` stopped: ${harness === 'grok' ? 'xAI' : 'Codex device'} authentication failed: permission denied` } }]);
    expect(signedIn).not.toHaveBeenCalled();
  });

  it('says the proxy is not running instead of starting a login', async () => {
    await expect(signIn({ harness: 'codex', proxy: async () => undefined }).start(ATTEMPT))
      .rejects.toThrow('CLIProxyAPI is not running');
    expect(spawnCalls).toEqual([]);
  });

  it.each(['claude', 'pi', 'goose', 'opencode'] as const)('exchanges a pasted Claude code for %s and hands the login to the proxy', async harness => {
    const signedIn = vi.fn();
    const fetchMock = vi.fn(async () => Response.json({
      access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: 'user:inference user:profile',
      account: { email_address: 'owner@example.com' },
    }));
    const claude = signIn({ harness, model: () => 'anthropic/claude-sonnet-4-6',
      agentEnv: { GOOSE_PROVIDER: 'anthropic' }, onSignedIn: signedIn, fetch: fetchMock as never });
    const link = await claude.start(ATTEMPT);
    const state = new URL(link.kind === 'paste-code' ? link.authorizeUrl : '').searchParams.get('state');
    await claude.submit(ATTEMPT, `code#${state}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(saved).toEqual([{ provider: 'claude', login: {
      access_token: 'access', refresh_token: 'refresh', email: 'owner@example.com',
      expired: new Date(1_800_000_000_000 + 3_600_000).toISOString(),
      last_refresh: new Date(1_800_000_000_000).toISOString(),
    } }]);
    expect(signedIn).toHaveBeenCalledTimes(1);
    expect(await stat(join(home, '.claude')).catch(() => undefined)).toBeUndefined();
    await expect(claude.submit(ATTEMPT, `code#${state}`)).rejects.toThrow('expired or was already used');
  });

  it('reports a device-code login the proxy refused with its own last line', async () => {
    const grok = signIn({ harness: 'grok' });
    const started = grok.start(ATTEMPT);
    (await spawned(0)).print(GROK_DEVICE_OUTPUT);
    await expect(started).resolves.toMatchObject({ kind: 'device-code', userCode: 'DC7F-7GCV' });
    children[0]!.print('Error: authorization denied\n');
    children[0]!.finish(1);
    await vi.waitFor(() => expect(results).toEqual([
      {
        attemptId: ATTEMPT,
        result: { ok: false, error: '`grok login` stopped: Error: authorization denied' },
      },
    ]));
    expect(saved).toEqual([]);
  });

  it('runs Cursor approve-and-wait login headless', async () => {
    const cursor = signIn({ harness: 'cursor' });
    const started = cursor.start(ATTEMPT);
    (await spawned(0)).print(CURSOR_LOGIN_OUTPUT);
    await expect(started).resolves.toEqual({
      kind: 'approve-wait',
      authorizeUrl: expect.stringMatching(/^https:\/\/cursor\.com\/loginDeepControl\?challenge=/),
    });
    expect(spawnCalls[0]).toMatchObject({ command: 'cursor-agent', args: ['login'] });
    expect(spawnCalls[0]!.env.NO_OPEN_BROWSER).toBe('1');
    expect(spawnCalls[0]!.env.HOME).toBe(home);
  });

  it('says the CLI is missing instead of hanging', async () => {
    const codex = signIn({ harness: 'codex' });
    const started = codex.start(ATTEMPT);
    (await spawned(0)).emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }));
    await expect(started).rejects.toThrow("`codex` is not installed on the agent's machine.");
  });

  it('fails a login that exits before printing its link', async () => {
    const codex = signIn({ harness: 'codex' });
    const started = codex.start(ATTEMPT);
    (await spawned(0)).print('device code login is not enabled for this Codex server.\n');
    children[0]!.finish(1);
    await expect(started).rejects.toThrow(
      '`codex login` stopped: device code login is not enabled for this Codex server.',
    );
    expect(results).toEqual([]);
  });

  it('cancels an unfinished login when a new one starts', async () => {
    const codex = signIn({ harness: 'codex' });
    const first = codex.start(ATTEMPT);
    (await spawned(0)).print(CODEX_DEVICE_OUTPUT);
    await first;
    const second = codex.start('00000000-0000-4000-8000-000000000002');
    await vi.waitFor(() => expect(children[0]!.killed).toBe('SIGTERM'));
    (await spawned(1)).print(CODEX_DEVICE_OUTPUT);
    await second;
    expect(results).toEqual([]);
  });

  it.each(['pi', 'goose'] as const)('verifies and saves a %s provider key into its env file, live env and sessions', async harness => {
    const envFile = join(home, 'connect', 'agent.env');
    await mkdir(join(home, 'connect'), { recursive: true });
    await writeFile(envFile, 'OPENROUTER_API_KEY="sk-or-old"\nOTHER="kept"\n', { mode: 0o600 });
    const agentEnv: Record<string, string> = { PATH: '/agent/bin', OPENROUTER_API_KEY: 'sk-or-old' };
    const saved = vi.fn();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    const pi = signIn({
      harness,
      agentEnv,
      llmEnvFile: envFile,
      onSignedIn: saved,
      fetch: fetchMock as never,
    });
    await expect(pi.start(ATTEMPT)).resolves.toEqual({ kind: 'api-key', provider: 'openrouter' });
    await pi.submit(ATTEMPT, '  sk-or-new  ');
    expect(fetchMock).toHaveBeenCalledWith('https://openrouter.ai/api/v1/key', expect.anything());
    expect(await readFile(envFile, 'utf8')).toBe('OPENROUTER_API_KEY="sk-or-new"\nOTHER="kept"\n');
    expect((await stat(envFile)).mode & 0o777).toBe(0o600);
    expect(agentEnv.OPENROUTER_API_KEY).toBe('sk-or-new');
    expect(saved).toHaveBeenCalledTimes(1);
    await expect(pi.submit(ATTEMPT, 'again')).rejects.toThrow('expired or was already used');
  });

  it.each(['pi', 'goose'] as const)('keeps the API-key card for a keyed %s provider', async harness => {
    const envFile = join(home, 'agent.env');
    await writeFile(envFile, 'GOOSE_PROVIDER="anthropic"\nANTHROPIC_API_KEY="sk-ant-old"\n');
    const goose = signIn({
      harness, model: () => 'anthropic/claude-sonnet-4-6',
      llmEnvFile: envFile,
      fetch: vi.fn(async () => new Response('{}', { status: 401 })) as never,
    });
    await expect(goose.start(ATTEMPT)).resolves.toEqual({ kind: 'api-key', provider: 'anthropic' });
    await expect(goose.submit(ATTEMPT, 'sk-ant-bad')).rejects.toThrow('Anthropic rejected the key (401).');
    expect(await readFile(envFile, 'utf8')).toContain('sk-ant-old');
    // A rejected key keeps the card open for another paste.
    await expect(goose.start(ATTEMPT)).resolves.toMatchObject({ kind: 'api-key' });
  });

  it("writes an OpenCode key into OpenCode's own store, keeping other providers", async () => {
    const store = join(home, '.local', 'share', 'opencode', 'auth.json');
    await mkdir(join(home, '.local', 'share', 'opencode'), { recursive: true });
    await writeFile(store, JSON.stringify({ anthropic: { type: 'oauth', refresh: 'r', access: 'a', expires: 1 } }));
    const opencode = signIn({
      harness: 'opencode',
      model: () => 'openrouter/z-ai/glm-5.3-flash',
      fetch: vi.fn(async () => new Response('{}', { status: 200 })) as never,
    });
    await expect(opencode.start(ATTEMPT)).resolves.toEqual({ kind: 'api-key', provider: 'openrouter' });
    await opencode.submit(ATTEMPT, 'sk-or-new');
    expect(JSON.parse(await readFile(store, 'utf8'))).toEqual({
      anthropic: { type: 'oauth', refresh: 'r', access: 'a', expires: 1 },
      openrouter: { type: 'api', key: 'sk-or-new' },
    });
    expect((await stat(store)).mode & 0o777).toBe(0o600);
  });

  it("sends an OpenCode agent on OpenCode's own models back to its machine", async () => {
    const opencode = signIn({ harness: 'opencode', model: () => 'opencode/big-pickle' });
    await expect(opencode.start(ATTEMPT)).rejects.toThrow('Run `opencode auth login` on its machine.');
  });

  it('says a Pi agent with no provider key needs beeline connect', async () => {
    await expect(signIn({ harness: 'pi' }).start(ATTEMPT)).rejects.toThrow(
      'This agent has no provider key to replace. Run `beeline connect` on its machine.',
    );
  });

  it('reports each step with its card and never logs or reports a key', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const logs: string[] = [];
    const cards = new Map<string, string>();
    const envFile = join(home, 'agent.env');
    await writeFile(envFile, 'XAI_API_KEY="xai-old"\n');
    const pi = signIn({
      harness: 'pi',
      llmEnvFile: envFile,
      fetch: vi.fn(async () => new Response('{}', { status: 403 })) as never,
    });
    const log = (line: string) => logs.push(line);
    await answerAgentSignInFrame({ execute }, 'agent', pi, agentSignInFrame({
      type: 'agent-sign-in', step: 'start', attemptId: ATTEMPT, cardId: CARD,
    })!, cards, log);
    expect(execute).toHaveBeenLastCalledWith('reportAgentSignIn', {
      agentId: 'agent', attemptId: ATTEMPT, kind: 'api-key', provider: 'xai',
    });
    await answerAgentSignInFrame({ execute }, 'agent', pi, {
      type: 'agent-sign-in', step: 'code', attemptId: ATTEMPT, code: 'xai-secret-pasted-key',
    }, cards, log);
    expect(execute).toHaveBeenLastCalledWith('reportAgentSignIn', {
      agentId: 'agent', attemptId: ATTEMPT, cardId: CARD, outcome: 'failed',
      error: 'xAI rejected the key (403).',
    });
    await reportAgentSignInResult({ execute }, 'agent', ATTEMPT, cards, { ok: true }, log);
    expect(execute).toHaveBeenLastCalledWith('reportAgentSignIn', {
      agentId: 'agent', attemptId: ATTEMPT, cardId: CARD, outcome: 'signed-in',
    });
    expect(JSON.stringify([execute.mock.calls, logs])).not.toContain('xai-secret-pasted-key');
  });

  it('drops malformed frames', () => {
    expect(agentSignInFrame({ type: 'agent-sign-in', step: 'start', attemptId: ATTEMPT })).toBeUndefined();
    expect(agentSignInFrame({ type: 'agent-sign-in', step: 'code', attemptId: ATTEMPT })).toBeUndefined();
    expect(agentSignInFrame({ type: 'other', step: 'start', attemptId: ATTEMPT, cardId: CARD }))
      .toBeUndefined();
  });
});

/**
 * Contract for the harness logins `@agent /login` drives. Their headless
 * output is not a public API: these tests pin the exact text each CLI printed
 * (fixtures) and, where a CLI is installed on this machine, re-read its help
 * so a renamed flag fails here before it reaches an owner.
 */
import { execFileSync as m12_execFileSync } from 'node:child_process';

import { describe as m12_describe, expect as m12_expect, it as m12_it } from 'vitest';

import {
  CLI_SIGN_INS as m12_CLI_SIGN_INS,
  parseCursorLogin as m12_parseCursorLogin,
  parseProxyDeviceLogin as m12_parseProxyDeviceLogin,
} from "./agent-sign-in.js";

import { CODEX_DEVICE_OUTPUT as m12_CODEX_DEVICE_OUTPUT, CURSOR_LOGIN_OUTPUT as m12_CURSOR_LOGIN_OUTPUT, GROK_DEVICE_OUTPUT as m12_GROK_DEVICE_OUTPUT } from "../../../packages/test-helpers/helpers/helper.js";
import { describe as mergedDescribe12 } from 'vitest';
mergedDescribe12("agent-sign-in.contract.test.ts", () => {


const NOW = 1_800_000_000_000;


function installed(command: string): boolean {
  try {
    m12_execFileSync('which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}


function help(command: string, args: string[]): string {
  return m12_execFileSync(command, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
}


m12_describe('harness login contract', () => {
  m12_it("reads the link and code CLIProxyAPI's device logins print", () => {
    m12_expect(m12_parseProxyDeviceLogin(m12_CODEX_DEVICE_OUTPUT, NOW)).toEqual({
      kind: 'device-code', authorizeUrl: 'https://auth.openai.com/codex/device', userCode: 'O55M-GK99G', expiresAt: NOW + 15 * 60_000,
    });
    m12_expect(m12_parseProxyDeviceLogin(m12_GROK_DEVICE_OUTPUT, NOW)).toMatchObject({
      authorizeUrl: 'https://accounts.x.ai/oauth2/device?user_code=DC7F-7GCV', userCode: 'DC7F-7GCV',
    });
  });

  m12_it('reads the link Cursor prints', () => {
    m12_expect(m12_parseCursorLogin(m12_CURSOR_LOGIN_OUTPUT)).toEqual({
      kind: 'approve-wait',
      authorizeUrl: m12_expect.stringMatching(/^https:\/\/cursor\.com\/loginDeepControl\?challenge=[\w-]+&uuid=/),
    });
  });

  m12_it('waits rather than guessing while the output is incomplete', () => {
    m12_expect(m12_parseProxyDeviceLogin(m12_CODEX_DEVICE_OUTPUT.split('Codex device code')[0]!, NOW)).toBeUndefined();
    m12_expect(m12_parseProxyDeviceLogin(m12_GROK_DEVICE_OUTPUT.split('Then enter')[0]!, NOW)).toBeUndefined();
    m12_expect(m12_parseCursorLogin('Starting login process...\n')).toBeUndefined();
  });

  m12_it("runs the proxy's device logins and Cursor's own headless login", () => {
    m12_expect(m12_CLI_SIGN_INS.codex).toMatchObject({ proxyFlag: '-codex-device-login' });
    m12_expect(m12_CLI_SIGN_INS.grok).toMatchObject({ proxyFlag: '-xai-login' });
    m12_expect(m12_CLI_SIGN_INS.cursor).toMatchObject({
      command: 'cursor-agent',
      args: ['login'],
      env: { NO_OPEN_BROWSER: '1' },
    });
  });

  m12_it.skipIf(!installed('cursor-agent'))('matches the installed Cursor login command', () => {
    m12_expect(help('cursor-agent', ['--help'])).toContain('login');
  });
});
});

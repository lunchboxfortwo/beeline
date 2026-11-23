import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeAdapterCandidate, useAdapterCommand, withIdleAdapterCandidate, withAdapterCandidateLock, withAdapterInstallLock } from './adapter-install-lock.js';
import { adapterStatePath, readAdapterState } from './adapter-store.js';
import { updateAgentAdapter, type AdapterUpdateOptions } from './adapter-update.js';
import type { AdapterInstallCommand } from './agent-command.js';

const here = dirname(fileURLToPath(import.meta.url));
const registry = async () => ({
  'dist-tags': { latest: '1.0.0' },
  time: { '1.0.0': '2000-01-01T00:00:00Z' },
});

// The audit's hung candidate: it answers ACP initialize, never session/new.
const hungAdapter = (pidFile: string) => `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stderr.write('fake adapter pid ' + process.pid + ' waiting on its backend\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } }) + '\\n');
});
`;

const roots: string[] = [];
const pids: number[] = [];
afterEach(async () => {
  for (const pid of pids.splice(0))
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch() {
  const home = await mkdtemp(join(tmpdir(), 'beeline-adapter-update-'));
  roots.push(home);
  // No `claude` on PATH: the candidate gets no CLAUDE_CODE_EXECUTABLE.
  const env = { HOME: home, XDG_DATA_HOME: join(home, 'data'), PATH: '/usr/bin:/bin' };
  return { home, env, store: join(home, 'data/beeline/adapters/claude') };
}

const installAdapter = (body: string) => async (install: AdapterInstallCommand) => {
  const prefix = install.args[install.args.indexOf('--prefix') + 1]!;
  const bin = join(prefix, 'node_modules/.bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'claude-agent-acp'), body);
  await chmod(join(bin, 'claude-agent-acp'), 0o755);
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('adapter refresh', () => {
  it('runs the session check without the adapter lock, names its stage, and a leaving caller kills the candidate unpromoted', async () => {
    const { home, env, store } = await scratch();
    const pidFile = join(home, 'adapter.pid');
    const lines: string[] = [];
    let reached!: () => void;
    const sessionNew = new Promise<void>((done) => {
      reached = done;
    });
    const caller = new AbortController();
    const work = updateAgentAdapter('claude', {
      env,
      readRegistry: registry,
      install: installAdapter(hungAdapter(pidFile)),
      alert: async () => {
        throw new Error('no alert expected');
      },
      signal: caller.signal,
      log: (line) => {
        lines.push(line);
        if (line.endsWith('checking claude-agent-acp@1.0.0: session/new')) reached();
      },
    });
    await sessionNew;
    // Before: the lock was held through the whole check, so this waited.
    await expect(withAdapterInstallLock(() => 'free', env)).resolves.toBe('free');
    const pid = Number(await readFile(pidFile, 'utf8'));
    pids.push(pid);
    expect(alive(pid)).toBe(true);
    caller.abort();
    await expect(work).rejects.toThrow(
      'claude adapter refresh cancelled; @agentclientprotocol/claude-agent-acp@1.0.0 was not promoted',
    );
    expect(alive(pid)).toBe(false);
    expect(lines).toContain('[beeline] checking claude-agent-acp@1.0.0: initialize');
    expect(lines).toContain(
      `[beeline] claude-agent-acp@1.0.0: fake adapter pid ${pid} waiting on its backend`,
    );
    // Unpromoted, not rejected, and its prefix is gone.
    expect(readAdapterState('claude', env)).toEqual({});
    expect((await readdir(store)).filter((name) => name.startsWith('candidate-'))).toEqual([]);
  });

  it('fails at once with the holder when another refresh holds the adapter lock', async () => {
    const { env } = await scratch();
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((done) => {
      entered = done;
    });
    const holder = withAdapterInstallLock(
      () =>
        new Promise<void>((done) => {
          entered();
          release = done;
        }),
      env,
    );
    await inside;
    try {
      await expect(
        updateAgentAdapter('claude', { env, readRegistry: registry, log: () => undefined }),
      ).rejects.toThrow(`adapter refresh already running as pid ${process.pid}`);
    } finally {
      release();
      await holder;
    }
  });

  it('prunes superseded prefixes at promotion, keeping the new, the previous and live installs', async () => {
    const { env, store } = await scratch();
    for (const name of [
      'candidate-old',
      'candidate-prev',
      'candidate-live',
      'superseded-candidate-left',
    ]) {
      await mkdir(join(store, name, 'node_modules/.bin'), { recursive: true });
      initializeAdapterCandidate(join(store, name));
    }
    await writeFile(
      adapterStatePath('claude', env),
      JSON.stringify({
        active: {
          version: '0.9.0',
          command: join(store, 'candidate-prev/node_modules/.bin/claude-agent-acp'),
        },
      }),
    );
    const lines: string[] = [];
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((done) => {
      entered = done;
    });
    const live = withAdapterCandidateLock(
      join(store, 'candidate-live'),
      () =>
        new Promise<void>((done) => {
          entered();
          release = done;
        }),
    );
    await inside;
    try {
      const options: AdapterUpdateOptions = {
        env,
        readRegistry: registry,
        install: installAdapter('#!/bin/sh\n'),
        log: (line) => lines.push(line),
        checkSession: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
      };
      await expect(updateAgentAdapter('claude', options)).resolves.toBe(true);
    } finally {
      release();
      await live;
    }
    const active = readAdapterState('claude', env).active!;
    const promoted = resolve(active.command, '../../..');
    expect(active.version).toBe('1.0.0');
    expect((await readdir(store)).sort()).toEqual(
      ['candidate-live', 'candidate-prev', promoted.split('/').at(-1)!, 'state.json'].sort(),
    );
    expect(lines).toContain('[beeline] claude adapter promoted to 1.0.0 (was 0.9.0)');
    expect(lines).toContain('[beeline] removed 2 superseded claude adapter prefixes');
  });

  it('a killed caller holds no lock, and its leaked candidate prefix is pruned at the next promotion', async () => {
    const { home, env, store } = await scratch();
    const pidFile = join(home, 'adapter.pid');
    const script = join(home, 'caller.mts');
    await writeFile(
      script,
      `import { updateAgentAdapter } from ${JSON.stringify(join(here, 'adapter-update.ts'))};
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
await updateAgentAdapter('claude', { env: ${JSON.stringify(env)},
  readRegistry: async () => ({ 'dist-tags': { latest: '1.0.0' }, time: { '1.0.0': '2000-01-01T00:00:00Z' } }),
  install: async (install) => { const bin = join(install.args[2], 'node_modules/.bin'); mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'claude-agent-acp'), ${JSON.stringify(hungAdapter(pidFile))}); chmodSync(join(bin, 'claude-agent-acp'), 0o755); },
  log: (line) => process.stderr.write(line + '\\n') });
`,
    );
    // Run tsx's CLI on this Node, not whichever `node` PATH names.
    const tsx = resolve(here, '../../../node_modules/tsx/dist/cli.mjs');
    const child = spawn(process.execPath, [tsx, script], {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ...env },
    });
    pids.push(child.pid!);
    let stderr = '';
    await new Promise<void>((done, fail) => {
      child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.includes('checking claude-agent-acp@1.0.0: session/new')) done();
      });
      child.once('exit', () => fail(new Error(`caller exited early: ${stderr}`)));
    });
    const adapterPid = Number(await readFile(pidFile, 'utf8'));
    pids.push(adapterPid);
    const exited = new Promise((done) => child.once('exit', done));
    process.kill(-child.pid!, 'SIGKILL');
    await exited;
    // The kernel released the caller's locks with it; nothing queues behind a dead caller.
    await expect(withAdapterInstallLock(() => 'free', env)).resolves.toBe('free');
    expect((await readdir(store)).filter((name) => name.startsWith('candidate-'))).toHaveLength(1);
    await expect(
      updateAgentAdapter('claude', {
        env,
        readRegistry: registry,
        install: installAdapter('#!/bin/sh\n'),
        log: () => undefined,
        checkSession: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
      }),
    ).resolves.toBe(true);
    const active = readAdapterState('claude', env).active!;
    expect((await readdir(store)).sort()).toEqual(
      [resolve(active.command, '../../..').split('/').at(-1)!, 'state.json'].sort(),
    );
  }, 30_000);
});

it.each(['active', 'rejected'] as const)('does not promote over a concurrent %s decision', async change => {
  const { env } = await scratch();
  const options: AdapterUpdateOptions = {
    env, readRegistry: registry, install: installAdapter('#!/bin/sh\n'), log: () => undefined,
    alert: async () => {},
    checkSession: async () => {
      await updateAgentAdapter('claude', {
        env, install: installAdapter('#!/bin/sh\n'), log: () => undefined, alert: async () => {},
        readRegistry: async () => ({ 'dist-tags': { latest: change === 'active' ? '2.0.0' : '1.0.0' },
          time: { '1.0.0': '2000-01-01T00:00:00Z', '2.0.0': '2000-01-01T00:00:00Z' } }),
        checkSession: async () => {
          if (change === 'rejected') throw new Error('protocol refused');
          return { protocolVersion: 1, agentCapabilities: {} };
        },
      });
      return { protocolVersion: 1, agentCapabilities: {} };
    },
  };
  await expect(updateAgentAdapter('claude', options)).resolves.toBe(false);
  const state = readAdapterState('claude', env);
  if (change === 'active') expect(state.active?.version).toBe('2.0.0');
  else { expect(state.active).toBeUndefined(); expect(state.rejected?.['1.0.0']).toEqual({ error: 'protocol refused' }); }
});

it('leaves a successfully checked candidate unpromoted when its caller cancels', async () => {
  const { env } = await scratch();
  const caller = new AbortController();
  await expect(updateAgentAdapter('claude', {
    env, readRegistry: registry, install: installAdapter('#!/bin/sh\n'), log: () => undefined,
    signal: caller.signal,
    checkSession: async () => { caller.abort(); return { protocolVersion: 1, agentCapabilities: {} }; },
  })).rejects.toThrow('cancelled');
  expect(readAdapterState('claude', env)).toEqual({});
});

it('retains an old prefix across promotions until every ACP session exits', async () => {
  const { env, store } = await scratch();
  const body = `#!${process.execPath}
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const r=JSON.parse(line); if(r.id!==undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{protocolVersion:1,agentCapabilities:{}}})+'\\n');
});`;
  const promote = (version: string) => updateAgentAdapter('claude', {
    env, readRegistry: async () => ({ 'dist-tags': { latest: version }, time: { [version]: '2000-01-01T00:00:00Z' } }),
    install: installAdapter(body), log: () => undefined,
    checkSession: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
  });
  await promote('1.0.0');
  const command = readAdapterState('claude', env).active!.command;
  const prefix = resolve(command, '../../..');
  const { AcpClient } = await import('./acp.js');
  const { startAgentProcess, stopAgentProcess } = await import('./agent-process.js');
  const clients = Array.from({ length: 2 }, () => new AcpClient({ agentCommand: command, agentEnv: env, resourceScope: 'none' }));
  try {
    await withAdapterInstallLock(() => Promise.all(clients.map(client => startAgentProcess(client))), env);
    await promote('2.0.0'); await promote('3.0.0');
    expect(await readFile(command, 'utf8')).toBe(body);
    await stopAgentProcess(clients[0]!);
    await promote('4.0.0');
    expect(await readFile(command, 'utf8')).toBe(body);
    await stopAgentProcess(clients[1]!);
    await promote('5.0.0');
    expect(await readdir(store)).not.toContain(prefix.split('/').at(-1));
  } finally { for (const client of clients) await stopAgentProcess(client); }
});

it('cannot admit a new user after pruning atomically retires an empty usage directory', async () => {
  const { store } = await scratch();
  const prefix = join(store, 'candidate-retired');
  await mkdir(prefix, { recursive: true });
  initializeAdapterCandidate(prefix);
  const command = join(prefix, 'node_modules/.bin/claude-agent-acp');
  await expect(withIdleAdapterCandidate(prefix, async () => {
    expect(() => useAdapterCommand(command)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  })).resolves.toBe(true);
  await expect(withIdleAdapterCandidate(prefix, async () => {})).resolves.toBe(true);
});

it('preserves untracked legacy prefixes during pruning', async () => {
  const { store } = await scratch();
  const prefix = join(store, 'candidate-legacy');
  await mkdir(prefix, { recursive: true });
  let pruned = false;
  await expect(withIdleAdapterCandidate(prefix, async () => { pruned = true; })).resolves.toBe(false);
  expect(pruned).toBe(false);
});

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { reportHelperStartup } from './machine-control.js';
import { convergeNativeHelper, nativeHelperPlist, startNativeHelper } from './native-helper.js';

const status = {
  pid: process.pid,
  generation: 'successor',
  processState: 'serving' as const,
  updatedAt: '',
  agents: {},
};

async function fixture(version: string) {
  const root = await mkdtemp(join(tmpdir(), 'beeline-launchd-start-'));
  const libDir = join(root, '.local/lib/beeline');
  await mkdir(libDir, { recursive: true });
  await writeFile(join(libDir, 'bundle.json'), JSON.stringify({ version }));
  return { root, env: { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state') } };
}

it.each(['before', 'after'] as const)(
  'accepts the RunAtLoad helper acknowledgment %s bootstrap returns without kickstart',
  async timing => {
    const { root, env } = await fixture('v0.1.245-rc.1');
    const commands: string[][] = [];
    let loaded = false;
    let launched!: () => void;
    const launch = new Promise<void>(done => { launched = done; });
    const run = async (args: string[]) => {
      commands.push(args);
      if (args[0] === 'bootstrap') {
        loaded = true;
        if (timing === 'before') await reportHelperStartup(env.XDG_STATE_HOME, status);
      }
      if (args[0] === 'print' && loaded) {
        launched();
        return { stdout: `pid = ${process.pid}\n` };
      }
      return { stdout: '' };
    };
    let settled = false;
    const work = convergeNativeHelper({ env, platform: 'launchd', run }).finally(() => { settled = true; });
    const answer = work.then(value => ({ value }), error => ({ error }));
    try {
      await launch;
      if (timing === 'after') {
        for (let i = 0; i < 8; i++) await new Promise<void>(done => setImmediate(done));
        expect(settled).toBe(false);
        await reportHelperStartup(env.XDG_STATE_HOME, status);
      }
      expect(await answer).toEqual({ value: process.pid });
      expect(commands.filter(args => args[0] === 'bootstrap')).toHaveLength(1);
      expect(commands.filter(args => args[0] === 'kickstart')).toEqual([]);
    } finally {
      if (!settled) await reportHelperStartup(env.XDG_STATE_HOME, { error: 'test cleanup' });
      await answer;
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([false, true])('preserves the current helper before its update request when the plist changed: %s', async changed => {
  const { root, env } = await fixture('v0.1.245');
  const directory = join(root, 'Library/LaunchAgents');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'app.usebeeline.helper.plist'), changed ? 'previous configuration' : nativeHelperPlist(env));
  const commands: string[][] = [];
  try {
    const result = await convergeNativeHelper({ env, platform: 'launchd', restart: false,
      run: async args => {
        commands.push(args);
        return { stdout: args[0] === 'print' ? `pid = ${process.pid}\n` : '' };
      },
    });
    expect(result).toBe(process.pid);
    expect(commands.map(args => args[0])).toEqual(['print', 'enable']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([false, true])('matches the replacement job PID on deliberate restart with changed plist: %s', async changed => {
  const { root, env } = await fixture('v0.1.245');
  const directory = join(root, 'Library/LaunchAgents');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'app.usebeeline.helper.plist'), changed ? 'previous configuration' : nativeHelperPlist(env));
  const commands: string[][] = [];
  let bootstrapped = false;
  try {
    const result = await convergeNativeHelper({ env, platform: 'launchd', restart: true,
      run: async args => {
        commands.push(args);
        if (args[0] === 'print') return { stdout: `pid = ${bootstrapped ? process.pid : process.pid + 1000}\n` };
        if (args[0] === 'bootstrap') {
          bootstrapped = true;
          await reportHelperStartup(env.XDG_STATE_HOME, status);
        }
        if (args[0] === 'kickstart') {
          await reportHelperStartup(env.XDG_STATE_HOME, status);
          return { stdout: String(process.pid) };
        }
        return { stdout: '' };
      },
    });
    expect(result).toBe(process.pid);
    expect(commands.filter(args => args[0] === 'kickstart')).toEqual(changed ? [] : [
      ['kickstart', '-k', '-p', `gui/${process.getuid!()}/app.usebeeline.helper`],
    ]);
    expect(commands.filter(args => args[0] === 'bootstrap')).toHaveLength(changed ? 1 : 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('leaves an automatically started successor running without kickstart', async () => {
  const { root, env } = await fixture('v0.1.245');
  const commands: string[][] = [];
  try {
    await startNativeHelper(env, { platform: 'launchd', run: async args => {
      commands.push(args);
      return { stdout: `pid = ${process.pid}\n` };
    } });
    expect(commands).toEqual([['print', `gui/${process.getuid!()}/app.usebeeline.helper`]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('waits for a successor acknowledgment after a non-replacing kickstart', async () => {
  const { root, env } = await fixture('v0.1.245');
  const commands: string[][] = [];
  let launched!: () => void;
  const launch = new Promise<void>(done => { launched = done; });
  let settled = false;
  const work = startNativeHelper(env, { platform: 'launchd', run: async args => {
    commands.push(args);
    if (args[0] === 'kickstart') { launched(); return { stdout: String(process.pid) }; }
    return { stdout: '' };
  } }).finally(() => { settled = true; });
  const answer = work.then(value => ({ value }), error => ({ error }));
  try {
    await launch;
    for (let i = 0; i < 8; i++) await new Promise<void>(done => setImmediate(done));
    expect(settled).toBe(false);
    await reportHelperStartup(env.XDG_STATE_HOME, status);
    expect(await answer).toEqual({ value: undefined });
    expect(commands.filter(args => args[0] === 'kickstart')).toEqual([
      ['kickstart', '-p', `gui/${process.getuid!()}/app.usebeeline.helper`],
    ]);
  } finally {
    if (!settled) await reportHelperStartup(env.XDG_STATE_HOME, { error: 'test cleanup' });
    await answer;
    await rm(root, { recursive: true, force: true });
  }
});

it('ends supported startup on the successor explicit failure reply', async () => {
  const { root, env } = await fixture('v0.1.245');
  try {
    await expect(startNativeHelper(env, {
      platform: 'launchd',
      run: async args => {
        if (args[0] !== 'kickstart') return { stdout: '' };
        await reportHelperStartup(env.XDG_STATE_HOME, { error: 'successor configuration failed' });
        return { stdout: String(process.pid) };
      },
    })).rejects.toThrow('successor configuration failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('ends supported startup when the successor exits before acknowledging', async () => {
  const { root, env } = await fixture('v0.1.245');
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume();'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const ended = once(child, 'exit');
  await once(child, 'spawn');
  let launched!: () => void;
  const launch = new Promise<void>(done => { launched = done; });
  const work = startNativeHelper(env, {
    platform: 'launchd', run: async args => {
      if (args[0] !== 'kickstart') return { stdout: '' };
      launched(); return { stdout: String(child.pid) };
    },
  });
  const answer = work.catch(error => error);
  try {
    await launch;
    child.kill('SIGKILL');
    await ended;
    expect(String(await answer)).toContain('exited before its startup acknowledgment');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await ended;
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['cold', 'restart'] as const)('starts an older bundle without waiting for any acknowledgment (%s)', async mode => {
  const { root, env } = await fixture('v0.1.244');
  const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  let loaded = false;
  const run = async (args: string[]) => {
    if (args[0] === 'bootstrap') loaded = true;
    return { stdout: args[0] === 'print' && loaded ? `pid = ${process.pid}\n` : args[0] === 'kickstart' ? String(process.pid) : '' };
  };
  try {
    const result = mode === 'cold'
      ? await convergeNativeHelper({ env, platform: 'launchd', run })
      : await startNativeHelper(env, { platform: 'launchd', run });
    expect(result).toEqual({ pid: process.pid, older: true });
    expect(writes).toHaveBeenCalledWith(`started older helper pid ${process.pid}\n`);
    expect(writes.mock.calls.some(([line]) => String(line).includes('startup acknowledgment'))).toBe(false);
  } finally {
    writes.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('uses the verified staged release version rather than the older active anchor', async () => {
  const { root, env } = await fixture('v0.1.244');
  const staged = join(root, '.local/lib/beeline-releases/successor');
  await mkdir(join(staged, 'lib/beeline'), { recursive: true });
  await writeFile(join(staged, '.stage-ok'), 'a'.repeat(64));
  await writeFile(join(staged, 'lib/beeline/beeline-cli.mjs'), '');
  await writeFile(join(staged, 'lib/beeline/bundle.json'), JSON.stringify({ version: 'v0.1.245' }));
  const { writeUpdateState } = await import('./self-update.js');
  await writeUpdateState({ libDir: join(root, '.local/lib/beeline'), binDir: join(root, '.local/bin'),
    releasesRoot: join(root, '.local/lib/beeline-releases') }, { stagedReleaseId: 'successor' });
  try {
    await expect(startNativeHelper(env, {
      platform: 'launchd', run: async args => {
        if (args[0] !== 'kickstart') return { stdout: '' };
        await reportHelperStartup(env.XDG_STATE_HOME, { error: 'staged helper answered' });
        return { stdout: String(process.pid) };
      },
    })).rejects.toThrow('staged helper answered');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

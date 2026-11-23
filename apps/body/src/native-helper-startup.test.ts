import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { reportHelperStartup } from './machine-control.js';
import { convergeNativeHelper, startNativeHelper } from './native-helper.js';

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

it.each(['cold', 'restart'] as const)(
  'accepts a supported successor acknowledgment after kickstart returns without control (%s)',
  async (mode) => {
    const { root, env } = await fixture('v0.1.245-rc.1');
    const commands: string[][] = [];
    let launched!: () => void;
    const launch = new Promise<void>(done => { launched = done; });
    const run = async (args: string[]) => {
      commands.push(args);
      if (args[0] === 'kickstart') {
        launched();
        return { stdout: String(process.pid) };
      }
      return { stdout: '' };
    };
    let settled = false;
    const work = (mode === 'cold'
      ? convergeNativeHelper({ env, platform: 'launchd', run })
      : startNativeHelper(env, { platform: 'launchd', run })).finally(() => { settled = true; });
    const answer = work.then(value => ({ value }), error => ({ error }));
    try {
      await launch;
      for (let i = 0; i < 8; i++) await new Promise<void>(done => setImmediate(done));
      expect(settled).toBe(false);
      await reportHelperStartup(env.XDG_STATE_HOME, status);
      expect(await answer).toEqual({ value: mode === 'cold' ? process.pid : undefined });
      expect(commands.filter(args => args[0] === 'kickstart')).toEqual([
        ['kickstart', '-k', '-p', `gui/${process.getuid!()}/app.usebeeline.helper`],
      ]);
    } finally {
      if (!settled) await reportHelperStartup(env.XDG_STATE_HOME, { error: 'test cleanup' });
      await answer;
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('ends supported startup on the successor explicit failure reply', async () => {
  const { root, env } = await fixture('v0.1.245');
  try {
    await expect(startNativeHelper(env, {
      platform: 'launchd',
      run: async () => {
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
    platform: 'launchd', run: async () => { launched(); return { stdout: String(child.pid) }; },
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
  const run = async (args: string[]) => ({ stdout: args[0] === 'kickstart' ? String(process.pid) : '' });
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
      platform: 'launchd', run: async () => {
        await reportHelperStartup(env.XDG_STATE_HOME, { error: 'staged helper answered' });
        return { stdout: String(process.pid) };
      },
    })).rejects.toThrow('staged helper answered');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

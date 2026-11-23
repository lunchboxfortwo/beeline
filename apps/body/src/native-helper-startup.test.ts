import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { reportHelperStartup, MachineControl, machineControlPath } from './machine-control.js';
import { convergeNativeHelper, startNativeHelper } from './native-helper.js';

const status = { pid: process.pid, generation: 'successor', processState: 'serving' as const, updatedAt: '', agents: {} };

it.each(['cold', 'restart'] as const)('awaits the successor startup reply through a launchd throttle window (%s)', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-launchd-start-'));
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state') };
  const commands: string[][] = [];
  let launched!: () => void;
  const launch = new Promise<void>(done => { launched = done; });
  const run = async (args: string[]) => {
    commands.push(args);
    if (args[0] === 'kickstart') { launched(); return { stdout: String(process.pid) }; }
    return { stdout: '' };
  };
  let settled = false;
  const work = (mode === 'cold'
    ? convergeNativeHelper({ env, platform: 'launchd', run })
    : startNativeHelper(env, { platform: 'launchd', run })).then(value => { settled = true; return value; });
  try {
    await launch;
    for (let i = 0; i < 8; i++) await new Promise<void>(done => setImmediate(done));
    expect(settled).toBe(false);
    reportHelperStartup(env.XDG_STATE_HOME, status);
    await work;
    expect(settled).toBe(true);
    expect(commands.filter(args => args[0] === 'kickstart')).toHaveLength(1);
    expect(commands.filter(args => args[0] === 'print')).toHaveLength(mode === 'cold' ? 1 : 0);
  } finally { reportHelperStartup(env.XDG_STATE_HOME, status); await work.catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

it('ends launchd startup on the successor explicit failure reply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-launchd-failed-'));
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state') };
  let launched!: () => void;
  const launch = new Promise<void>(done => { launched = done; });
  const work = startNativeHelper(env, { platform: 'launchd', run: async () => { launched(); return { stdout: String(process.pid) }; } });
  const answer = work.catch(error => error);
  try {
    await launch;
    reportHelperStartup(env.XDG_STATE_HOME, { error: 'successor configuration failed' });
    expect(String(await answer)).toContain('successor configuration failed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('acknowledges an already-running launchd helper without waiting for a startup event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-launchd-current-'));
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state') };
  const control = new MachineControl(machineControlPath(env.XDG_STATE_HOME), async () => status);
  await control.start();
  try {
    await startNativeHelper(env, { platform: 'launchd', run: async () => ({ stdout: String(process.pid) }) });
  } finally { await control.stop(); await rm(root, { recursive: true, force: true }); }
});

it('ends startup when the successor exits without sending a reply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-launchd-exit-'));
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state') };
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume();'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const ended = once(child, 'exit');
  await once(child, 'spawn');
  let launched!: () => void;
  const launch = new Promise<void>(done => { launched = done; });
  const work = startNativeHelper(env, { platform: 'launchd', run: async () => { launched(); return { stdout: String(child.pid) }; } });
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

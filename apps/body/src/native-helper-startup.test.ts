import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { reportHelperStartup, MachineControl, machineControlPath } from './machine-control.js';
import { convergeNativeHelper, startNativeHelper } from './native-helper.js';

const status = {
  pid: process.pid,
  generation: 'successor',
  processState: 'serving' as const,
  updatedAt: '',
  agents: {},
};

it.each(['cold', 'restart'] as const)(
  'accepts the successor startup acknowledgment (%s)',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-launchd-start-'));
    const env = { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state') };
    const commands: string[][] = [];
    const run = async (args: string[]) => {
      commands.push(args);
      if (args[0] === 'kickstart') {
        await reportHelperStartup(env.XDG_STATE_HOME, status);
        return { stdout: String(process.pid) };
      }
      return { stdout: '' };
    };
    try {
      if (mode === 'cold') await convergeNativeHelper({ env, platform: 'launchd', run });
      else await startNativeHelper(env, { platform: 'launchd', run });
      expect(commands.filter((args) => args[0] === 'kickstart')).toHaveLength(1);
      expect(commands.filter((args) => args[0] === 'print')).toHaveLength(mode === 'cold' ? 1 : 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('ends launchd startup on the successor explicit failure reply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-launchd-failed-'));
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state') };
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

it('acknowledges an already-running launchd helper without waiting for a startup event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-launchd-current-'));
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'),
  };
  const control = new MachineControl(machineControlPath(env.XDG_STATE_HOME), async () => status);
  await control.start();
  try {
    await startNativeHelper(env, {
      platform: 'launchd',
      run: async () => ({ stdout: String(process.pid) }),
    });
  } finally {
    await control.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['absent', 'starting'] as const)('refuses a live pre-acknowledgment helper with %s control', async (controlState) => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-launchd-legacy-'));
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state') };
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume();'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const ended = once(child, 'exit');
  await once(child, 'spawn');
  const control = controlState === 'starting'
    ? new MachineControl(machineControlPath(env.XDG_STATE_HOME), async () => ({ ...status, pid: child.pid!, processState: 'starting' }))
    : undefined;
  try {
    await control?.start();
    await expect(startNativeHelper(env, {
      platform: 'launchd', run: async () => ({ stdout: String(child.pid) }),
    })).rejects.toThrow('helper startup was not acknowledged');
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  } finally {
    child.kill('SIGKILL');
    await ended;
    await control?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

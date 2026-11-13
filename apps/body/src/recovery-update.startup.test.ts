import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { requestMachine } from './machine-control.js';
import { prepareMachineRelease } from './recovery.js';

vi.mock('./machine-control.js', () => ({ requestMachine: vi.fn() }));
vi.mock('./native-helper.js', async original => ({
  ...await original<typeof import('./native-helper.js')>(),
  convergeNativeHelper: vi.fn(async () => process.pid),
}));
vi.mock('./recovery.js', async original => ({
  ...await original<typeof import('./recovery.js')>(),
  prepareMachineRelease: vi.fn(async () => ({ releaseId: 'new', identity: {} })),
  convergeMachine: (options: Parameters<typeof import('./recovery.js').convergeMachine>[0]) =>
    original<typeof import('./recovery.js')>().then(module => module.convergeMachine({ ...options, run: async () => ({ stdout: '' }) })),
}));
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: vi.fn(() => {
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', 0));
    return child;
  }),
}));

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it.each([false, true])('carries CLI force=%s through convergence to the live helper request', async force => {
  vi.resetModules();
  const home = await mkdtemp(join(tmpdir(), 'beeline-update-entry-'));
  const lib = join(home, 'lib/beeline');
  await mkdir(join(lib, 'lib/beeline'), { recursive: true });
  await writeFile(join(lib, 'lib/beeline/beeline-cli.mjs'), '');
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, 'config'));
  vi.stubEnv('XDG_STATE_HOME', join(home, 'state'));
  vi.stubEnv('BEELINE_LIB_DIR', lib);
  vi.mocked(requestMachine).mockImplementation(async (_root, request, accept) => {
    const status = { pid: process.pid, generation: 'current', processState: 'serving' as const,
      loadedRelease: request.operation === 'update' ? 'new' : 'old', updatedAt: '', agents: {} };
    expect(accept(status)).toBe(true);
    return status;
  });
  const previousArgs = process.argv;
  const previousExit = process.exitCode;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.argv = [process.execPath, 'recovery.mjs', 'update', ...(force ? ['--force'] : [])];
  try {
    await import('./recovery-cli.js');
    await vi.waitFor(() => expect(log.mock.calls.length + error.mock.calls.length).toBeGreaterThan(0));
    expect(error).not.toHaveBeenCalled();
    expect(prepareMachineRelease).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ force }));
    const request = vi.mocked(requestMachine).mock.calls.find(([, request]) => request.operation === 'update')?.[1];
    expect(request).toEqual({ operation: 'update', releaseId: 'new', sourceGeneration: 'current',
      ...(force ? { force: true } : {}) });
  } finally {
    process.argv = previousArgs;
    process.exitCode = previousExit;
    await rm(home, { recursive: true, force: true });
  }
});

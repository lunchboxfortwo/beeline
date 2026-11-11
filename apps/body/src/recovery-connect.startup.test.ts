import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { prepareMachineRelease, convergeMachine } from './recovery.js';

vi.mock('./recovery.js', () => ({
  prepareMachineRelease: vi.fn(async () => { throw new Error('connect tried to stage a helper release'); }),
  convergeMachine: vi.fn(),
  bootstrapMachine: vi.fn(),
}));
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: vi.fn(() => {
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', 0));
    return child;
  }),
}));

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('opens the installed connect wizard without staging or converging a release first', async () => {
  const home = await mkdtemp(join(tmpdir(), 'beeline-connect-entry-'));
  const lib = join(home, '.local/lib/beeline');
  await mkdir(lib, { recursive: true });
  const entry = join(lib, 'lib/beeline/beeline-cli.mjs');
  await mkdir(join(lib, 'lib/beeline'), { recursive: true });
  await writeFile(entry, '');
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, 'config'));
  vi.stubEnv('XDG_STATE_HOME', join(home, 'state'));
  vi.stubEnv('BEELINE_LIB_DIR', lib);
  const previousArgs = process.argv;
  const previousExit = process.exitCode;
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.argv = [process.execPath, 'npm-latest.mjs', 'connect', 'pairing-code'];
  try {
    await import('./recovery-cli.js');
    await vi.waitFor(() => expect(vi.mocked(spawn).mock.calls.length + error.mock.calls.length).toBeGreaterThan(0));
    expect(prepareMachineRelease).not.toHaveBeenCalled();
    expect(convergeMachine).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith(process.execPath, [entry, 'connect', 'pairing-code'], expect.objectContaining({ stdio: 'inherit' }));
    expect(error).not.toHaveBeenCalled();
    await new Promise<void>(done => setImmediate(done));
  } finally {
    process.argv = previousArgs;
    process.exitCode = previousExit;
    await rm(home, { recursive: true, force: true });
  }
});

import { afterEach, expect, it, vi } from 'vitest';
import { runUpdateCommand } from './self-update-cli.js';
import { convergeMachine, prepareMachineRelease } from './recovery.js';
import { convergeDependencies } from './recovery-dependencies.js';
vi.mock('./recovery.js', () => ({ prepareMachineRelease: vi.fn(), convergeMachine: vi.fn() }));
vi.mock('./recovery-dependencies.js', () => ({ convergeDependencies: vi.fn(async () => {}) }));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it('uses the target gate and reports a stuck agent on the direct body CLI', async () => {
  vi.stubEnv('BEELINE_LIB_DIR', '/tmp/beeline-direct-cli/lib/beeline');
  vi.mocked(prepareMachineRelease).mockResolvedValue({ releaseId: 'target', identity: { version: 'v1.2.3' } });
  vi.mocked(convergeMachine).mockResolvedValue({ pid: 123, generation: 'new', loadedRelease: 'target',
    processState: 'serving', updatedAt: 'snapshot-time', agents: { sleepy: {
      state: 'starting', status: 'discovery pending', since: 'startup-time',
    } } });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  await runUpdateCommand(['update', '--force']);
  expect(convergeDependencies).toHaveBeenCalledWith(expect.anything(), 'target', undefined, expect.any(AbortSignal));
  expect(convergeMachine).toHaveBeenCalledWith(expect.objectContaining({ releaseId: 'target', reportAgentsOnly: true, force: true }));
  expect(stderr.mock.calls.flat().join('')).toContain('sleepy: starting since startup-time; discovery pending; snapshot snapshot-time');
  expect(stdout.mock.calls.flat().join('')).toContain('helper pid 123 serving');
});

it('repairs the installed helper after a freshness failure on the direct CLI', async () => {
  vi.stubEnv('BEELINE_LIB_DIR', '/tmp/beeline-direct-cli/lib/beeline');
  vi.mocked(prepareMachineRelease).mockRejectedValue(new Error('network stalled'));
  vi.mocked(convergeMachine).mockResolvedValue({} as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await expect(runUpdateCommand(['update'])).rejects.toThrow('freshness unconfirmed');
  expect(convergeMachine).toHaveBeenCalledWith(expect.objectContaining({ reportAgentsOnly: true }));
  expect(convergeDependencies).not.toHaveBeenCalled();
});

it('returns successfully after recovering an older installed helper without claiming readiness', async () => {
  vi.stubEnv('BEELINE_LIB_DIR', '/tmp/beeline-direct-cli/lib/beeline');
  vi.mocked(prepareMachineRelease).mockRejectedValue(new Error('publication unavailable'));
  vi.mocked(convergeMachine).mockResolvedValue({ pid: 321, older: true });
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  await expect(runUpdateCommand(['update'])).resolves.toBeUndefined();
  expect(convergeDependencies).not.toHaveBeenCalled();
  expect(stdout.mock.calls.flat().join('')).not.toContain('executing release');
});

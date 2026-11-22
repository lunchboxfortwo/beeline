import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { requestMachine } from './machine-control.js';
import { convergeNativeHelper } from './native-helper.js';
import { convergeMachine } from './recovery.js';
import type { HelperStatusFile } from './helper-status.js';

vi.mock('./machine-control.js', async original => ({
  ...await original<typeof import('./machine-control.js')>(), requestMachine: vi.fn(),
}));
vi.mock('./native-helper.js', async original => ({
  ...await original<typeof import('./native-helper.js')>(), convergeNativeHelper: vi.fn(async () => process.pid),
}));
afterEach(() => vi.clearAllMocks());

const snapshot = (release: string, generation = 'successor'): HelperStatusFile => ({
  pid: process.pid, generation, processState: 'serving', loadedRelease: release,
  updatedAt: '2026-11-22T17:00:00Z', agents: { sleepy: {
    state: 'starting', status: 'waiting for discovery', since: '2026-11-22T16:31:57Z', enabled: true,
  } },
});

it('accepts the target with starting agents, rejects predecessor and same-version different content', async () => {
  const home = await mkdtemp(join(tmpdir(), 'beeline-helper-gate-'));
  const layout = { libDir: join(home, 'lib'), binDir: join(home, 'bin'), releasesRoot: join(home, 'releases') };
  await mkdir(join(layout.releasesRoot, 'target/lib/beeline'), { recursive: true });
  await writeFile(join(layout.releasesRoot, 'target/lib/beeline/bundle.json'), JSON.stringify({ version: 'v1.2.3', commit: 'target' }));
  vi.mocked(requestMachine).mockImplementation(async (_root, request, accept) => {
    if (request.operation === 'status') return snapshot('old', 'predecessor');
    expect(accept({ ...snapshot('old', 'predecessor'), desiredRelease: 'wrong' })).toBe(false);
    expect(accept({ ...snapshot('other'), loadedIdentity: { version: 'v1.2.3', commit: 'other' } })).toBe(false);
    expect(accept({ ...snapshot('newer'), loadedIdentity: { version: 'v1.2.4' } })).toBe(true);
    const target = snapshot('target');
    expect(accept(target)).toBe(true);
    return target;
  });
  try {
    const result = await convergeMachine({ layout, env: { ...process.env, HOME: home,
      XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state') },
      releaseId: 'target', waitForAgents: false, run: async () => ({ stdout: '' }) });
    expect(result.loadedRelease).toBe('target');
    expect(result.agents.sleepy?.state).toBe('starting');
    expect(convergeNativeHelper).toHaveBeenCalledWith(expect.objectContaining({ restart: false }));
  } finally { await rm(home, { recursive: true, force: true }); }
});

it('never restarts a helper after a protocol failure', async () => {
  vi.mocked(requestMachine).mockRejectedValue(new Error('invalid helper acknowledgment'));
  await expect(convergeMachine({ run: async () => ({ stdout: '' }) })).rejects.toThrow('invalid helper acknowledgment');
  expect(convergeNativeHelper).not.toHaveBeenCalled();
});

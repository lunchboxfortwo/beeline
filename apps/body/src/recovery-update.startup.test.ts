import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { askMachine } from './machine-control.js';
import { prepareMachineRelease } from './recovery.js';
import { anchorLayout, installedReleaseChannel } from './self-update.js';

vi.mock('./recovery-dependencies.js', () => ({ convergeDependencies: vi.fn(async () => {}) }));

vi.mock('./machine-control.js', async (original) => ({
  ...(await original<typeof import('./machine-control.js')>()),
  askMachine: vi.fn(),
}));
vi.mock('./native-helper.js', async (original) => ({
  ...(await original<typeof import('./native-helper.js')>()),
  convergeNativeHelper: vi.fn(async () => process.pid),
  nativeHelperStatus: vi.fn(async () => ({})),
}));
vi.mock('./recovery.js', async (original) => ({
  ...(await original<typeof import('./recovery.js')>()),
  prepareMachineRelease: vi.fn(async () => ({ releaseId: 'new', identity: {} })),
  convergeMachine: (options: Parameters<typeof import('./recovery.js').convergeMachine>[0]) =>
    original<typeof import('./recovery.js')>().then((module) =>
      module.convergeMachine({ ...options, run: async () => ({ stdout: '' }) }),
    ),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it.each([[false, undefined], [true, 'next']] as const)(
  'carries CLI force=%s to the live helper and remembers channel %s',
  async (force, channel) => {
    vi.resetModules();
    const home = await mkdtemp(join(tmpdir(), 'beeline-update-entry-'));
    const lib = join(home, 'lib/beeline');
    await mkdir(join(lib, 'lib/beeline'), { recursive: true });
    await writeFile(join(lib, 'lib/beeline/beeline-cli.mjs'), '');
    await mkdir(join(home, 'lib/beeline-releases/new/lib/beeline'), { recursive: true });
    await writeFile(join(home, 'lib/beeline-releases/new/lib/beeline/beeline-cli.mjs'), '');
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', join(home, 'config'));
    vi.stubEnv('XDG_STATE_HOME', join(home, 'state'));
    vi.stubEnv('BEELINE_LIB_DIR', lib);
    vi.stubEnv('BEELINE_RELEASE_CHANNEL', channel);
    vi.stubEnv('BEELINE_UPDATE_MANIFEST_URL', undefined);
    vi.mocked(askMachine).mockImplementation(async (_root, request) => ({
      pid: process.pid,
      generation: 'current',
      processState: 'serving' as const,
      loadedRelease: request.operation === 'update' ? 'new' : 'old',
      updatedAt: '',
      agents: {},
    }));
    const previousArgs = process.argv;
    const previousExit = process.exitCode;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.argv = [process.execPath, 'recovery.mjs', 'update', ...(force ? ['--force'] : [])];
    try {
      await import('./recovery-cli.js');
      await vi.waitFor(() =>
        expect(log.mock.calls.length + error.mock.calls.length).toBeGreaterThan(0),
      );
      expect(error).not.toHaveBeenCalled();
      expect(prepareMachineRelease).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ force }),
      );
      const request = vi
        .mocked(askMachine)
        .mock.calls.find(([, request]) => request.operation === 'update')?.[1];
      expect(request).toEqual({
        operation: 'update',
        releaseId: 'new',
        sourceGeneration: 'current',
        ...(force ? { force: true } : {}),
      });
      vi.stubEnv('BEELINE_RELEASE_CHANNEL', undefined);
      expect(await installedReleaseChannel(anchorLayout(lib), {})).toBe(channel ?? 'latest');

      log.mockClear();
      vi.resetModules();
      process.argv = [process.execPath, 'recovery.mjs', 'update', '--status'];
      await import('./recovery-cli.js');
      await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
      expect(JSON.parse(log.mock.calls[0]![0]).releaseChannel).toBe(channel ?? 'latest');
    } finally {
      process.argv = previousArgs;
      process.exitCode = previousExit;
      await rm(home, { recursive: true, force: true });
    }
  },
);

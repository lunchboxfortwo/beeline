import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runUpdateCommand } from './self-update-cli.js';
import { convergeMachine, prepareMachineRelease } from './recovery.js';
import { convergeDependencies } from './recovery-dependencies.js';
import { anchorLayout, prepareLatestRelease } from './self-update.js';
import { DEFAULT_UPDATE_MANIFEST_URL } from './self-update-manifest.js';
vi.mock('./recovery.js', () => ({ prepareMachineRelease: vi.fn(), convergeMachine: vi.fn() }));
vi.mock('./recovery-dependencies.js', () => ({ convergeDependencies: vi.fn(async () => {}) }));
vi.mock('./helper-status.js', () => ({ helperStatusLines: vi.fn(async () => ['not running']) }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it('uses the target gate and reports a stuck agent on the direct body CLI', async () => {
  vi.stubEnv('BEELINE_LIB_DIR', '/tmp/beeline-direct-cli/lib/beeline');
  vi.mocked(prepareMachineRelease).mockResolvedValue({
    releaseId: 'target',
    identity: { version: 'v1.2.3' },
  });
  vi.mocked(convergeMachine).mockResolvedValue({
    pid: 123,
    generation: 'new',
    loadedRelease: 'target',
    processState: 'serving',
    updatedAt: 'snapshot-time',
    agents: {
      sleepy: {
        state: 'starting',
        status: 'discovery pending',
        since: 'startup-time',
      },
    },
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  await runUpdateCommand(['update', '--force']);
  expect(convergeDependencies).toHaveBeenCalledWith(
    expect.anything(),
    'target',
    undefined,
    expect.any(AbortSignal),
  );
  expect(convergeMachine).toHaveBeenCalledWith(
    expect.objectContaining({ releaseId: 'target', reportAgentsOnly: true, force: true }),
  );
  expect(stderr.mock.calls.flat().join('')).toContain(
    'sleepy: starting since startup-time; discovery pending; snapshot snapshot-time',
  );
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

it('keeps the chosen channel across background checks and shows it in status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-update-channel-'));
  const layout = anchorLayout(join(root, 'lib/beeline'));
  vi.stubEnv('BEELINE_LIB_DIR', layout.libDir);
  vi.stubEnv('BEELINE_RELEASE_CHANNEL', undefined);
  vi.stubEnv('BEELINE_UPDATE_MANIFEST_URL', undefined);
  vi.mocked(prepareMachineRelease).mockResolvedValue({ releaseId: 'target', identity: {} });
  vi.mocked(convergeMachine).mockResolvedValue({
    pid: 123,
    generation: 'current',
    loadedRelease: 'target',
    processState: 'serving',
    updatedAt: '',
    agents: {},
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const expectBackgroundManifest = async (env: NodeJS.ProcessEnv, url: string) => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('fixture stops after manifest selection'));
    await expect(prepareLatestRelease(layout, { env, fetchImpl })).rejects.toThrow('fixture stops');
    expect(fetchImpl).toHaveBeenCalledWith(url, expect.anything());
  };
  try {
    await expectBackgroundManifest({}, DEFAULT_UPDATE_MANIFEST_URL);

    vi.stubEnv('BEELINE_RELEASE_CHANNEL', 'next');
    await runUpdateCommand(['update']);
    vi.stubEnv('BEELINE_RELEASE_CHANNEL', undefined);
    const nextUrl = 'https://usebeeline.app/dl/next/manifest.json';
    await expectBackgroundManifest({}, nextUrl);
    await runUpdateCommand(['update']);
    expect(prepareMachineRelease).toHaveBeenLastCalledWith(
      layout,
      expect.objectContaining({ env: expect.objectContaining({ BEELINE_UPDATE_MANIFEST_URL: nextUrl }) }),
    );
    await runUpdateCommand(['update', '--status']);
    expect(log.mock.calls.flat()).toContainEqual(expect.stringMatching(/release channel\s+next/));

    vi.stubEnv('BEELINE_RELEASE_CHANNEL', 'latest');
    await runUpdateCommand(['update']);
    await expectBackgroundManifest({ BEELINE_RELEASE_CHANNEL: 'next' }, DEFAULT_UPDATE_MANIFEST_URL);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

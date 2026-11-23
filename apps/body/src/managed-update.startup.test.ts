import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReleaseTransaction, versionAtLeast } from './managed-update.js';
import { readUpdateState, writeUpdateState } from './self-update.js';

afterEach(() => vi.useRealTimers());

it.each([
  ['v0.1.202-rc.5', 'v0.1.201', true],
  ['v0.1.202-rc.5', 'v0.1.202-rc.4', true],
  ['v0.1.202-rc.5', 'v0.1.202', false],
  ['v0.1.202', 'v0.1.202-rc.5', true],
  ['0.1.203', 'v0.1.202-rc.5', true],
  ['v0.1.202-rc.5', 'v0.1.202-rc.5', true],
] as const)('compares running %s against requested %s', (actual, minimum, expected) => {
  expect(versionAtLeast(actual, minimum)).toBe(expected);
});

it.each(['v0.1.201', 'v0.1.202-rc.4'])(
  'treats older %s as current and discards only its staged selection', async version => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-downgrade-'));
    const layout = { libDir: join(root, 'lib'), releasesRoot: join(root, 'releases'), binDir: join(root, 'bin') };
    for (const [id, value] of [['running', 'v0.1.202-rc.5'], ['older', version]]) {
      await mkdir(join(layout.releasesRoot, id!, 'lib/beeline'), { recursive: true });
      await writeFile(join(layout.releasesRoot, id!, 'lib/beeline/bundle.json'), JSON.stringify({ version: value }));
    }
    await writeUpdateState(layout, { stagedReleaseId: 'older', previousReleaseId: 'previous' });
    const handoff = vi.fn(async () => {});
    const failed = vi.fn();
    const update = new ReleaseTransaction({ layout, loadedRelease: 'running', env: {},
      handoff, failed, changed: vi.fn() });
    try {
      expect(await update.prepared('older')).toBe('current');
      await update.pending;
      expect(handoff).not.toHaveBeenCalled();
      expect(failed).not.toHaveBeenCalled();
      expect((await readUpdateState(layout)).lastCheckResult).toBe('current');
      expect(update.desiredRelease).toBeUndefined();
      expect(await readUpdateState(layout)).toMatchObject({ previousReleaseId: 'previous' });
      expect((await readUpdateState(layout)).stagedReleaseId).toBeUndefined();
    } finally { update.dispose(); await rm(root, { recursive: true, force: true }); }
  },
);

it('discards a failed handoff so another helper cannot retry the rolled-back selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-failed-swap-'));
  const layout = { libDir: join(root, 'lib'), releasesRoot: join(root, 'releases'), binDir: join(root, 'bin') };
  await writeUpdateState(layout, { stagedReleaseId: 'broken', previousReleaseId: 'old' });
  const handoff = vi.fn(async () => { throw new Error('successor failed; restored old release'); });
  const failed = vi.fn();
  const update = new ReleaseTransaction({ layout, loadedRelease: 'old', env: {},
    handoff, failed, changed: vi.fn() });
  try {
    await update.prepared('broken');
    await update.pending;
    await update.pending;
    expect(failed).toHaveBeenCalledTimes(1);
    expect((await readUpdateState(layout)).stagedReleaseId).toBeUndefined();
    expect(handoff).toHaveBeenCalledTimes(1);
  } finally { update.dispose(); await rm(root, { recursive: true, force: true }); }
});

function fixture(handoff: (release: string, signal: AbortSignal) => Promise<void>) {
  const failed = vi.fn();
  const changed = vi.fn();
  const update = new ReleaseTransaction({
    layout: { libDir: '/isolated/lib', releasesRoot: '/isolated/releases', binDir: '/isolated/bin' },
    loadedRelease: 'old', env: {},
    handoff, failed, changed,
  });
  return { update, failed, changed };
}

it('arms no timer for a handoff; the requester is answered when it starts or fails', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(done => { started = done; });
  const stuck = new Promise<void>(done => { release = done; });
  const handoff = vi.fn(async () => { started(); await stuck; });
  const { update, failed } = fixture(handoff);
  expect(await update.prepared('new')).toBe('pending');
  await entered;
  expect(vi.getTimerCount()).toBe(0);
  expect(failed).not.toHaveBeenCalled();
  release();
  await update.pending;
  expect(handoff).toHaveBeenCalledTimes(1);
  // The handoff already ran: a later request is answered at once.
  expect(await update.prepared('newer')).toBe('handed-off');
  update.dispose();
});

it('hands off as soon as a release is prepared, whatever the agents are doing', async () => {
  vi.useFakeTimers();
  const handoff = vi.fn(async () => {});
  const { update, failed } = fixture(handoff);
  await update.prepared('new');
  await update.pending;
  expect(handoff).toHaveBeenCalledTimes(1);
  expect(handoff).toHaveBeenCalledWith('new', expect.any(AbortSignal));
  expect(failed).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('preserves a release notification arriving during an earlier preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-update-notice-'));
  const layout = { libDir: join(root, 'lib'), releasesRoot: join(root, 'releases'), binDir: join(root, 'bin') };
  let started!: () => void;
  const entered = new Promise<void>(done => { started = done; });
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  let calls = 0;
  const prepare = vi.fn(async () => {
    const target = ++calls === 1 ? 'old' : 'new';
    if (target === 'old') { started(); await gate; }
    await writeUpdateState(layout, { stagedReleaseId: target, lastCheckResult: 'verified' });
  });
  const handoff = vi.fn(async () => {});
  const failed = vi.fn();
  const update = new ReleaseTransaction({
    layout, loadedRelease: 'old', env: {},
    prepare, handoff, failed, changed: vi.fn(),
  });
  update.notify('old');
  const first = update.pending;
  try {
    await entered;
    update.notify('new');
    release();
    await first;
    expect(prepare).toHaveBeenCalledTimes(2);
    await update.pending;
    await update.pending;
    expect(handoff).toHaveBeenCalledWith('new', expect.any(AbortSignal));
    expect(failed).not.toHaveBeenCalled();
  } finally {
    release();
    update.dispose();
    await first;
    await update.pending;
    await rm(root, { recursive: true, force: true });
  }
});

it('prepares after this helper\'s own pruning instead of failing on its install lock', async () => {
  // Native proof: a release notice at boot failed "release pruning already running as pid <self>".
  let pruned!: () => void;
  const pruning = new Promise<void>(done => { pruned = done; });
  const prepare = vi.fn(async () => {});
  const update = new ReleaseTransaction({
    layout: { libDir: '/isolated/lib', releasesRoot: '/isolated/releases', binDir: '/isolated/bin' },
    loadedRelease: 'old', env: {}, prepare, ownWork: () => pruning,
    handoff: vi.fn(), failed: vi.fn(), changed: vi.fn(),
  });
  update.notify('new');
  await new Promise(done => setImmediate(done));
  expect(prepare).not.toHaveBeenCalled();
  pruned();
  await update.pending;
  expect(prepare).toHaveBeenCalledTimes(1);
  update.dispose();
});

it('gives overlapping already-current requests only terminal outcomes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-overlapping-current-'));
  const layout = { libDir: join(root, 'lib'), releasesRoot: join(root, 'releases'), binDir: join(root, 'bin') };
  await mkdir(join(layout.releasesRoot, 'running/lib/beeline'), { recursive: true });
  await writeFile(join(layout.releasesRoot, 'running/lib/beeline/bundle.json'), JSON.stringify({ version: 'v1.0.0' }));
  const settled = vi.fn();
  const update = new ReleaseTransaction({ layout, loadedRelease: 'running', env: {},
    handoff: vi.fn(), changed: vi.fn(), failed: vi.fn(), settled });
  try {
    const outcomes = await Promise.allSettled([update.prepared('running'), update.prepared('running')]);
    expect(outcomes.some(outcome => outcome.status === 'fulfilled' && outcome.value === 'current')).toBe(true);
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') expect(outcome.value).toBe('current');
      else expect(String(outcome.reason)).toContain('attempt ended');
    }
    expect(settled).toHaveBeenCalledWith('current');
  } finally { update.dispose(); await rm(root, { recursive: true, force: true }); }
});

it('reports cancellation of a pending handoff exactly once', async () => {
  let finish!: () => void;
  let entered!: () => void;
  const running = new Promise<void>(done => { entered = done; });
  const handoff = new Promise<void>(done => { finish = done; });
  const settled = vi.fn();
  const update = new ReleaseTransaction({
    layout: { libDir: '/isolated/lib', releasesRoot: '/isolated/releases', binDir: '/isolated/bin' },
    loadedRelease: 'old', env: {}, changed: vi.fn(), failed: vi.fn(), settled,
    handoff: async () => { entered(); await handoff; },
  });
  expect(await update.prepared('new')).toBe('pending');
  await running;
  update.dispose(); update.dispose();
  expect(settled.mock.calls).toEqual([['cancelled']]);
  finish(); await update.pending;
});

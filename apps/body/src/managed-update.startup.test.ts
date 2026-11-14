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
  'refuses a requested downgrade to %s and discards its staged selection', async version => {
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
      await update.prepared('older');
      await update.pending;
      expect(handoff).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledTimes(1);
      expect(String(failed.mock.calls[0]![0])).toContain('older');
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

it('abandons a wedged handoff once and fences its late completion', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(done => { started = done; });
  const stuck = new Promise<void>(done => { release = done; });
  let signal: AbortSignal | undefined;
  const handoff = vi.fn(async (_target: string, attempt: AbortSignal) => {
    signal = attempt;
    started();
    await stuck;
  });
  const { update, failed } = fixture(handoff);
  await update.prepared('new');
  await entered;
  const pending = update.pending;
  vi.advanceTimersByTime(179_999);
  expect(signal?.aborted).toBe(false);
  vi.advanceTimersByTime(1);
  expect(signal?.aborted).toBe(true);
  expect(failed).toHaveBeenCalledTimes(1);
  expect(String(failed.mock.calls[0]![0])).toContain('update handoff timed out');
  expect(update.desiredRelease).toBeUndefined();
  release();
  await pending;
  expect(handoff).toHaveBeenCalledTimes(1);
  await update.prepared('newer');
  await update.pending;
  expect(handoff).toHaveBeenCalledTimes(2);
  update.dispose();
});

it('cancels a wedged preparation and does not let it adopt a release after timeout', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const stuck = new Promise<void>(done => { release = done; });
  let started!: () => void;
  const entered = new Promise<void>(done => { started = done; });
  const failed = vi.fn();
  const handoff = vi.fn();
  const prepare = vi.fn(async () => { started(); await stuck; });
  const update = new ReleaseTransaction({
    layout: { libDir: '/isolated/lib', releasesRoot: '/isolated/releases', binDir: '/isolated/bin' },
    loadedRelease: 'old', env: {},
    prepare,
    handoff, failed, changed: vi.fn(),
  });
  update.notify('new');
  await entered;
  const pending = update.pending;
  update.notify('newer');
  vi.runOnlyPendingTimers();
  expect(failed).toHaveBeenCalledTimes(1);
  release();
  await pending;
  expect(handoff).not.toHaveBeenCalled();
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(update.desiredRelease).toBeUndefined();
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

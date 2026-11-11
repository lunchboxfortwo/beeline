import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReleaseTransaction } from './managed-update.js';
import { writeUpdateState } from './self-update.js';

afterEach(() => vi.useRealTimers());

function fixture(handoff: (release: string, interrupted: boolean, signal: AbortSignal) => Promise<void>) {
  const failed = vi.fn();
  const changed = vi.fn();
  const update = new ReleaseTransaction({
    layout: { libDir: '/isolated/lib', releasesRoot: '/isolated/releases', binDir: '/isolated/bin' },
    loadedRelease: 'old', env: {}, idle: () => true,
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
  const handoff = vi.fn(async (_target: string, _interrupted: boolean, attempt: AbortSignal) => {
    signal = attempt;
    started();
    await stuck;
  });
  const { update, failed } = fixture(handoff);
  const preparing = update.prepared('new');
  await entered;
  const pending = update.pending;
  vi.runOnlyPendingTimers();
  expect(signal?.aborted).toBe(true);
  expect(failed).toHaveBeenCalledTimes(1);
  expect(String(failed.mock.calls[0]![0])).toContain('update handoff timed out');
  expect(update.desiredRelease).toBeUndefined();
  release();
  await preparing;
  await pending;
  update.idleChanged();
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
    loadedRelease: 'old', env: {}, idle: () => true,
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

it('hands over on the next idle event without pausing active work', async () => {
  vi.useFakeTimers();
  let idle = false;
  const handoff = vi.fn(async () => {});
  const { update, failed } = fixture(handoff);
  update.options.idle = () => idle;
  await update.prepared('new');
  await update.pending;
  expect(handoff).not.toHaveBeenCalled();
  idle = true;
  update.idleChanged();
  await update.pending;
  expect(handoff).toHaveBeenCalledTimes(1);
  expect(handoff).toHaveBeenCalledWith('new', false, expect.any(AbortSignal));
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
    layout, loadedRelease: 'old', env: {}, idle: () => true,
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
    expect(handoff).toHaveBeenCalledWith('new', false, expect.any(AbortSignal));
    expect(failed).not.toHaveBeenCalled();
  } finally {
    release();
    update.dispose();
    await first;
    await update.pending;
    await rm(root, { recursive: true, force: true });
  }
});

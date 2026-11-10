import { scrollBarPosition, type TranscriptScrollMetrics } from './transcript-scrubber';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTranscriptScrubberStore, SCRUBBER_LINGER_MS } from './use-transcript-scrubber';
import nativeSequence from './transcript-scrubber.native-sequence.json';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const event = (offset: number, height = 5_600) => ({
  contentOffset: { y: offset },
  contentSize: { height },
  layoutMeasurement: { height: 600 },
});

it('scrubber-idle-1: native above-tail anchor corrections neither move nor reveal the thumb', () => {
  // emulator-5646, ce8c3ec5 plus temporary metric logging: untouched #general
  // receives short/long messages every two seconds. Preserve callback ordering,
  // including content-size reports that precede the matching native offset.
  const store = createTranscriptScrubberStore();
  const nativeEvent = (offset: number, contentHeight: number, viewportHeight = 744.3809814453125) => ({
    contentOffset: { y: offset }, contentSize: { height: contentHeight }, layoutMeasurement: { height: viewportHeight },
  });
  store.observeScroll(nativeEvent(597.7142944335938, 3482.666748046875));
  const position = store.getSnapshot().position;
  let previousTime = nativeSequence[0].time;
  for (const frame of nativeSequence) {
    vi.advanceTimersByTime(frame.time - previousTime);
    previousTime = frame.time;
    if (frame.kind === 'content') store.observeContentSize(frame.contentHeight);
    else store.observeScroll(nativeEvent(frame.offset!, frame.contentHeight, frame.viewportHeight!), false);
    expect(store.getSnapshot().position).toBe(position);
    if (frame.time - nativeSequence[0].time >= SCRUBBER_LINGER_MS)
      expect(store.getSnapshot().visible).toBe(false);
  }
  const metrics = store.getSnapshot().metrics!;
  expect(metrics.offset).toBe(10686.857421875);
  // A real drag resumes from the latest native offset, not the old anchor.
  store.observeScroll(nativeEvent(metrics.offset + 100, metrics.contentHeight));
  expect(store.getSnapshot().visible).toBe(true);
  expect(store.getSnapshot().position).not.toBe(position);
  store.dispose();
});

it('scrubber-idle-1: ignores remeasurement and subpixel echoes until the list moves', () => {
  const store = createTranscriptScrubberStore();
  store.observeScroll(event(2_500));
  // The fallback is the original component calculation, so this same
  // sequence demonstrates the oscillation before the snapshot owns position.
  const position = () => {
    const snapshot: { position?: number | null; metrics: TranscriptScrollMetrics | null } = store.getSnapshot();
    return 'position' in snapshot ? snapshot.position : snapshot.metrics && scrollBarPosition(snapshot.metrics);
  };
  expect(position()).toBe(0.5);
  for (const height of [8_600, 5_600, 9_600, 5_600]) {
    store.observeContentSize(height);
    store.observeScroll(event(2_500.25, height));
    expect(position()).toBe(0.5);
    expect(store.getSnapshot().metrics?.contentHeight).toBe(height);
    vi.advanceTimersByTime(SCRUBBER_LINGER_MS / 4);
  }
  expect(store.getSnapshot().visible).toBe(false);
  store.observeScroll(event(2_500, 8_600));
  expect(store.getSnapshot().visible).toBe(false);
  store.observeScroll(event(4_000, 8_600));
  expect(store.getSnapshot()).toMatchObject({ position: 0.5, visible: true });
  store.observeScroll(event(4_000.5, 8_600));
  expect(position()).toBe(0.5);
  store.observeScroll(event(4_001.5, 8_600));
  expect(position()).toBe(4_001.5 / 8_000);
  store.reset();
  expect(store.getSnapshot()).toMatchObject({ position: null, metrics: null, visible: false });
  store.dispose();
});

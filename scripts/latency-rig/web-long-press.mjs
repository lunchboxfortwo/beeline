import { readFile } from 'node:fs/promises';

export async function cornerLongPressThreshold() {
  const source = await readFile(
    new URL(
      '../../apps/mobile/sources/app/(app)/beeline/chat/ChatSurfaceHeader.tsx',
      import.meta.url,
    ),
    'utf8',
  );
  const control = source
    .split('<TouchableOpacity')
    .find((part) => part.includes('testID="room-corners-menu"'));
  const match = control?.match(/delayLongPress=\{(\d+)\}/);
  if (!match) throw new Error('Cannot read corner long-press threshold from source');
  return Number(match[1]);
}

/** Observe the existing result while the real gesture continues to release. */
export async function measureLongPress(page, prepared) {
  await page.evaluate(() => {
    delete window.__latencyHoldStart;
    document.addEventListener(
      'pointerdown',
      () => {
        window.__latencyHoldStart = performance.now();
      },
      { once: true, capture: true },
    );
  });
  const result = (async () => {
    await prepared.done();
    return page.evaluate(
      (threshold) =>
        new Promise((resolve) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const end = performance.now();
              const holdStart = window.__latencyHoldStart;
              if (!Number.isFinite(holdStart)) return resolve(null);
              performance.mark('rig:long-press-recognized', { startTime: holdStart + threshold });
              performance.mark('rig:visible-result', { startTime: end });
              resolve({
                holdStartMs: holdStart,
                recognitionStartMs: holdStart + threshold,
                completionMs: end,
                postRecognitionMs: end - holdStart - threshold,
                gestureInclusiveMs: end - window.__latencyStart,
              });
            }),
          );
        }),
      prepared.longPressThresholdMs,
    );
  })();
  const [gesture, observation] = await Promise.allSettled([prepared.act(), result]);
  if (gesture.status === 'rejected') throw gesture.reason;
  if (observation.status === 'rejected') throw observation.reason;
  const timing = observation.value;
  if (!timing || timing.postRecognitionMs <= 0)
    throw new Error('Long-press result did not follow recognition');
  return timing;
}

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import { cornerLongPressThreshold, measureLongPress } from './web-long-press.mjs';
const threshold = await cornerLongPressThreshold();
const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const p = await b.newPage();
  await p.setContent(
    '<button data-testid="room-corners-menu">Corners</button><div id="result"></div>',
  );
  await p.evaluate(
    (threshold) =>
      document.querySelector('button').addEventListener('pointerdown', () => {
        const start = performance.now();
        const frame = () => {
          if (performance.now() - start >= threshold)
            document.querySelector('#result').textContent = 'Corner open';
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
    threshold,
  );
  const captures = [];
  for (let capture = 1; capture <= 2; capture++) {
    const samples = [];
    for (let i = 0; i < 20; i++) {
      await p.evaluate(() => {
        document.querySelector('#result').textContent = '';
        window.__latencyStart = performance.now();
      });
      const timing = await measureLongPress(p, {
        longPressThresholdMs: threshold,
        act: async () => {
          await p.getByTestId('room-corners-menu').hover();
          await p.mouse.down();
          await p.waitForTimeout(650);
          await p.mouse.up();
        },
        done: async () => {
          await p.waitForFunction(
            () => document.querySelector('#result').textContent === 'Corner open',
            null,
            { polling: 'raf' },
          );
        },
      });
      samples.push(timing);
    }
    captures.push({ capture, samples });
  }
  const values = captures
    .flatMap((c) => c.samples.map((s) => s.postRecognitionMs))
    .sort((a, b) => a - b);
  const result = {
    kind: 'static rendered result, not app capture',
    thresholdFromSourceMs: threshold,
    p50Ms: values[19],
    p95Ms: values[37],
    captures,
  };
  const out = process.argv[2] ?? '.beeline-proof/create-corner-floor/revision3-floor.json';
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ p50: values[19], p95: values[37] }));
} finally {
  await b.close();
}

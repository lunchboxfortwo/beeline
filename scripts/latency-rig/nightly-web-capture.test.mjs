import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateInventory, summarize } from './web-capture.mjs';
import { attachWebInventory } from './nightly-local.mjs';
import { scenarios, fixture } from './web-fixtures.mjs';
import { steps } from './web-steps.mjs';
import { cornerLongPressThreshold, measureLongPress } from './web-long-press.mjs';
const inventory = JSON.parse(
  await readFile(new URL('./interactions.json', import.meta.url), 'utf8'),
);
test('corner clock follows the source threshold and observes completion before release', async () => {
  const source = await readFile(
    new URL(
      '../../apps/mobile/sources/app/(app)/beeline/chat/ChatSurfaceHeader.tsx',
      import.meta.url,
    ),
    'utf8',
  );
  const threshold = await cornerLongPressThreshold();
  const control = source
    .split('<TouchableOpacity')
    .find((part) => part.includes('testID="room-corners-menu"'));
  assert.equal(threshold, Number(control.match(/delayLongPress=\{(\d+)\}/)[1]));
  let release;
  let observed = false;
  let released = false;
  const marks = [];
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const page = {
    evaluate: async (fn, value) => {
      if (value === undefined) return;
      // Execute the actual browser clock/frame callback with a deterministic clock.
      const previous = {
        window: globalThis.window,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        performance: globalThis.performance,
      };
      globalThis.window = { __latencyHoldStart: 100, __latencyStart: 80 };
      globalThis.requestAnimationFrame = (callback) => callback();
      globalThis.performance = { now: () => 100 + threshold + 25, mark: (name, options) => marks.push([name, options.startTime]) };
      try {
        const timing = await fn(value);
        assert.equal(released, false);
        observed = true;
        release();
        return timing;
      } finally {
        Object.assign(globalThis, previous);
      }
    },
  };
  const timing = await measureLongPress(page, {
    longPressThresholdMs: threshold,
    act: async () => {
      await Promise.race([
        held,
        new Promise((_, reject) =>
          setImmediate(() => reject(new Error('Observation gated on release'))),
        ),
      ]);
      released = true;
    },
    done: async () => {},
  });
  assert.equal(observed, true);
  assert.equal(released, true);
  assert.equal(timing.recognitionStartMs, timing.holdStartMs + threshold);
  assert.equal(timing.postRecognitionMs, 25);
  assert.deepEqual(marks, [['rig:long-press-recognized', 100 + threshold], ['rig:visible-result', 100 + threshold + 25]]);
  assert.equal(timing.gestureInclusiveMs, threshold + 45);
});

test('a failed gesture cannot become a successful long-press sample', async () => {
  const page = {
    evaluate: async (fn, value) =>
      value === undefined
        ? undefined
        : {
            postRecognitionMs: 10,
          },
  };
  await assert.rejects(
    measureLongPress(page, {
      longPressThresholdMs: 123,
      act: async () => {
        throw new Error('release failed');
      },
      done: async () => {},
    }),
    /release failed/,
  );
});
test('every inventory entry has a seeded scenario and an executable driver decision', () => {
  validateInventory(inventory);
  for (const name of inventory) {
    const f = fixture(name);
    assert.equal(f.name, name);
    assert.match(f.roomId, /^[a-f0-9-]{36}$/);
    const missingFixture = { ...scenarios };
    delete missingFixture[name];
    assert.throws(
      () => validateInventory(inventory, missingFixture, steps),
      new RegExp(`Missing fixture: ${name}`),
    );
    const missingStep = { ...steps };
    delete missingStep[name];
    assert.throws(
      () => validateInventory(inventory, scenarios, missingStep),
      new RegExp(`Missing driver step: ${name}`),
    );
  }
});
test('a newly added inventory entry cannot silently inherit another fixture', () => {
  assert.throws(
    () => validateInventory([...inventory, 'future-interaction']),
    /Missing fixture: future-interaction/,
  );
});
const pair = (name) =>
  [1, 2].map((capture) => ({
    name,
    capture,
    samples: Array.from({ length: 20 }, (_, i) => i + 100),
  }));
test('only two complete captures contribute percentiles and a full score', () => {
  const result = summarize(inventory, inventory.flatMap(pair));
  assert.equal(result.fullInventoryScore, 100);
  assert.equal(result.rows.length, inventory.length);
  assert.deepEqual(result.unmeasured, []);
  assert.equal(result.rows[0].p50Ms, 109);
  assert.equal(result.rows[0].p95Ms, 118);
});
test('recognition summaries retain separately labelled gesture-inclusive percentiles', () => {
  const captures = pair('create-corner').map((capture) => ({
    ...capture,
    longPressTimings: capture.samples.map((value) => ({ gestureInclusiveMs: value + 500 })),
  }));
  const row = summarize(['create-corner'], captures).rows[0];
  assert.equal(row.p50Ms, 109);
  assert.match(row.timingContract, /recognition/);
  assert.deepEqual(row.gestureInclusive, { p50Ms: 609, p95Ms: 618 });
});
test('missing, partial, failed and nonfinite captures keep score unavailable and retain the exact reason', () => {
  for (const [name, availability] of [
    ['mark-read', 'unavailable'], ['mark-unread', 'unavailable'],
    ['start-workflow', 'unavailable'], ['handoff-workflow', 'unavailable'],
    ['approve-merge', 'external'], ['connect-app', 'external'],
  ]) {
    assert.equal(summarize([name], []).unmeasured[0].availability, availability);
  }
  for (const bad of [
    [],
    [{ ...pair('open-room')[0], samples: [1] }],
    [{ ...pair('open-room')[0], reason: 'Fixture result never became visible' }],
    [{ ...pair('open-room')[0], samples: Array(20).fill(NaN) }],
  ]) {
    const result = summarize(['open-room'], bad);
    assert.equal(result.fullInventoryScore, null);
    assert.equal(result.rows.length, 0);
    assert.equal(result.unmeasured[0].name, 'open-room');
    assert.ok(result.unmeasured[0].reason);
  }
  assert.match(
    summarize(['open-room'], [{ ...pair('open-room')[0], reason: 'exact failure' }]).unmeasured[0]
      .reason,
    /exact failure/,
  );
});

test('nightly verdict carries web coverage, timings and every exact gap to the morning card', () => {
  const summary = summarize(
    ['open-room', 'connect-app'],
    [
      ...pair('open-room'),
      { name: 'connect-app', capture: 1, samples: [], reason: 'Provider consent is external' },
    ],
  );
  const result = attachWebInventory({ text: 'Native verdict' }, summary, [
    'open-room',
    'connect-app',
  ]);
  assert.equal(result.fullInventoryScore, null);
  assert.equal(result.unmeasured.length, 1);
  assert.match(result.text, /Web open-room: n=40 p50=109 ms p95=118 ms/);
  assert.match(result.text, /Provider consent is external/);
  assert.match(result.text, /Web connect-app: external —/);
  const missing = attachWebInventory({ text: '' }, undefined, inventory, 'Expo export failed');
  assert.equal(missing.unmeasured.length, inventory.length);
  assert.ok(missing.unmeasured.every((g) => g.reason === 'Expo export failed'));
});
test('duplicate capture identity cannot masquerade as a paired capture', () => {
  assert.equal(
    summarize(['open-room'], [pair('open-room')[0], pair('open-room')[0]]).fullInventoryScore,
    null,
  );
});

test('Insights publishes valid paired web cases and gaps independently of native capture', async () => {
  const { latencyLoops } = await import('./nightly-insights.mjs');
  const webInventory = {
    ...summarize(
      ['open-room', 'connect-app'],
      [
        ...pair('open-room'),
        { name: 'connect-app', capture: 1, samples: [], reason: 'External consent' },
      ],
    ),
    commit: 'head',
  };
  const verdict = {
    final: true,
    night: '2026-11-07',
    head: 'head',
    runId: 'web-proof',
    failures: [],
    webInventory,
    unmeasured: webInventory.unmeasured,
  };
  const current = {
    loops: [
      { slug: 'latency', charts: [] },
      { slug: 'other', note: 'keep' },
    ],
  };
  const output = latencyLoops(current, verdict);
  assert.equal(output.loops[0].charts[0].series[0].points[0].value, 109);
  assert.match(output.loops[0].charts[0].series[0].key, /case:web\/open-room\/paired:p50/);
  assert.match(output.loops[0].note, /1\/2; full-inventory score unavailable/);
  assert.match(
    output.loops[0].log[0].text,
    /connect-app: external — Capture 1: External consent/,
  );
  assert.equal(output.loops[1].note, 'keep');
  assert.deepEqual(current.loops[0].charts, []);
  const stale = latencyLoops(current, { ...verdict, head: 'new-head' });
  assert.equal(stale.loops[0].charts.length, 0);
  const partial = latencyLoops(current, {
    ...verdict,
    webInventory: { ...webInventory, rows: [{ ...webInventory.rows[0], samples: 39 }] },
  });
  assert.equal(partial.loops[0].charts.length, 0);
});

test('paired summary retains corrected completion and the original driver timing separately', () => {
  const captures = [1, 2].map((capture) => ({
    name: 'forward-message',
    capture,
    samples: Array(20).fill(350),
    forwardTimings: Array.from({ length: 20 }, () => ({
      durationMs: 350,
      driverObservedMs: 850,
      animationMs: 250,
    })),
  }));
  const row = summarize(['forward-message'], captures).rows[0];
  assert.equal(row.p50Ms, 350);
  assert.equal(row.p95Ms, 350);
  assert.deepEqual(row.driverObserved, { p50Ms: 850, p95Ms: 850 });
  assert.deepEqual(row.profile.animationMs, { p50Ms: 250, p95Ms: 250 });
});

test('unobserved source visibility stays unavailable instead of becoming zero milliseconds', () => {
  const captures = [1, 2].map((capture) => ({
    name: 'forward-message',
    capture,
    samples: Array(20).fill(350),
    forwardTimings: Array.from({ length: 20 }, () => ({
      durationMs: 350,
      driverObservedMs: 850,
      sourceMessageVisibleMs: null,
    })),
  }));
  const field = summarize(['forward-message'], captures).rows[0].profile.sourceMessageVisibleMs;
  assert.deepEqual(field, { p50Ms: null, p95Ms: null, observedSamples: 0 });
});

test('route loads retain their states and sample contract in the nightly card', async () => {
  const { latencyLoops } = await import('./nightly-insights.mjs');
  const routeInventory = {
    ...summarize(
      ['/settings (cold)'],
      [1, 2].map((capture) => ({
        name: '/settings (cold)',
        capture,
        samples: [300, 320, 310],
      })),
      { samplesPerCapture: 3, budgetMs: 450 },
    ),
    samplesPerCapture: 3,
    states: { '/settings': 'settings-redirect' },
  };
  const web = { ...summarize([], []), commit: 'head', routeInventory };
  const verdict = attachWebInventory(
    { text: '', final: true, night: '2026-11-09', head: 'head', runId: 'routes', failures: [] },
    web,
    [],
  );
  assert.match(verdict.text, /Web routes: 1\/1/);
  const result = latencyLoops({ loops: [{ slug: 'latency', charts: [] }] }, verdict);
  assert.equal(result.loops[0].charts.length, 1);
  assert.match(result.loops[0].log[0].text, /settings-redirect/);
  const partial = structuredClone(verdict);
  partial.webInventory.routeInventory.rows[0].captures[0].samples = 2;
  assert.equal(
    latencyLoops({ loops: [{ slug: 'latency', charts: [] }] }, partial).loops[0].charts.length,
    0,
  );
});

test('Room-open setup waits for the actual destination row before the action clock', async () => {
  let release;
  const rowReady = new Promise((resolve) => {
    release = resolve;
  });
  let prepared;
  const row = {
    filter() {
      return this;
    },
    waitFor: () => rowReady,
    click: async () => {},
  };
  const header = {
    filter() {
      return this;
    },
    waitFor: async () => {},
  };
  const page = {
    goto: async () => {},
    getByTestId: (id) => (id.startsWith('room-') ? row : header),
  };
  const setup = steps['open-room'](page, fixture('open-room')).then((value) => {
    prepared = value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prepared, undefined, 'an absent row is fixture setup, not tap latency');
  release();
  await setup;
  assert.equal(typeof prepared.act, 'function');
});

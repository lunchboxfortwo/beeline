import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateInventory, summarize } from './web-capture.mjs';
import { attachWebInventory } from './nightly-local.mjs';
import { scenarios, fixture } from './web-fixtures.mjs';
import { steps } from './web-steps.mjs';
const inventory = JSON.parse(
  await readFile(new URL('./interactions.json', import.meta.url), 'utf8'),
);
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
test('missing, partial, failed and nonfinite captures keep score unavailable and retain the exact reason', () => {
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
    /connect-app: unmeasured — Capture 1: External consent/,
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

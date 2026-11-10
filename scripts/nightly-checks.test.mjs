import assert from 'node:assert/strict';
import test from 'node:test';
import { runNightly } from './nightly-checks.mjs';

test('R-NOISE-19: delayed nightly dispatch uses the Eastern date, including DST twins', async () => {
  for (const [date, selected, twin] of [
    ['2026-11-05T16:24:03.879Z', '7 8 * * *', '7 7 * * *'],
    ['2026-07-05T19:30:00Z', '7 7 * * *', '7 8 * * *'],
    ['2026-11-01T22:00:00Z', '7 8 * * *', '7 7 * * *'],
  ]) {
    const calls = [], saved = [];
    const api = async (method, path, body) => {
      calls.push({ method, path, body });
      if (path.includes('nightly-checks.yml/runs')) return { workflow_runs: [], total_count: 0 };
      if (path.includes('unified-release')) return { workflow_runs: [] };
      if (path === 'commits/main') return { sha: 'head' };
      return null;
    };
    const options = { api, save: r => saved.push(r), now: () => new Date(date), requestId: '123' };
    assert.equal((await runNightly({ ...options, schedule: selected })).dispatched, true);
    const count = calls.length;
    assert.equal(await runNightly({ ...options, schedule: twin }), undefined);
    assert.equal(calls.length, count);
    assert.equal(saved.length, 1);
    assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  }
});

test('Reproduction 23: cron is a fallback after a dispatch in the same Eastern night', async () => {
  for (const [created_at, skipped] of [
    ['2026-11-09T08:07:02Z', true],
    ['2026-11-09T04:07:02Z', false],
  ]) {
    const calls = [];
    const result = await runNightly({
      api: async (method, path) => {
        calls.push(method);
        if (path.includes('nightly-checks.yml/runs')) return { workflow_runs: [{ created_at }], total_count: 1 };
        if (path.includes('unified-release')) return { workflow_runs: [] };
        return { sha: 'head' };
      },
      save() {}, now: () => new Date('2026-11-09T14:59:32Z'), schedule: '7 8 * * *', requestId: '123',
    });
    assert.equal(Boolean(result.skipped), skipped);
    assert.equal(calls.includes('POST'), !skipped);
  }
});

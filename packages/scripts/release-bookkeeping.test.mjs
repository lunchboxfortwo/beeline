import assert from 'node:assert/strict';
import test from 'node:test';
import { writeRecord } from './release-bookkeeping.mjs';

test('creates and updates release bookkeeping in the current insights repository', async () => {
  const url = 'https://api.github.com/repos/lunchboxfortwo/beeline-insights/contents/releases/v0.2.1.json';
  const record = { version: 'v0.2.1', attempt: 2, sourceSha: 'a'.repeat(40) };
  for (const sha of [null, 'existing-record-sha']) {
    const calls = [];
    const fetchImpl = async (target, init) => {
      calls.push({ target, init });
      if (init.method !== 'PUT') return { ok: Boolean(sha), status: sha ? 200 : 404, json: async () => ({ sha }) };
      return { ok: true };
    };
    assert.equal(await writeRecord(fetchImpl, { api: 'https://api.github.com', token: 'fixture-token', record }),
      'releases/v0.2.1.json');
    assert.deepEqual(calls.map(call => call.target), [`${url}?ref=main`, url]);
    const body = JSON.parse(calls[1].init.body);
    assert.equal(body.branch, 'main');
    assert.equal(body.sha, sha ?? undefined);
    assert.deepEqual(JSON.parse(Buffer.from(body.content, 'base64').toString()), record);
  }
});

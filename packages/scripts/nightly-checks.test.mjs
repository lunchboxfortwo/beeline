import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { runNightly } from './nightly-checks.mjs';

test('Reproduction 20: the release that starts nightly is not a release still in the way', async () => {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.includes('unified-release')) {
      return { workflow_runs: [
        { id: 99, status: 'in_progress', html_url: 'https://example.test/release' },
        { id: 50, status: 'completed', html_url: 'https://example.test/done' },
      ] };
    }
    if (path === 'commits/main') return { sha: 'released' };
    return null;
  };
  const started = await runNightly({
    api, save() {}, requestId: '123', releaseRunId: '99',
  });
  assert.equal(started.dispatched, true);
  assert.equal(started.requestedSha, 'released');
  assert.deepEqual(calls.find(call => call.method === 'POST'), {
    method: 'POST', path: 'actions/workflows/checks.yml/dispatches',
    body: { ref: 'main', inputs: { suite: 'all', nightly_id: '123' } },
  });
  const blocked = await runNightly({
    api, save() {}, requestId: '123', releaseRunId: '100',
  });
  assert.equal(blocked.skipped, true);
  assert.equal(blocked.reason, 'A unified-release run on main is active');
  const unnamed = await runNightly({
    api, save() {}, requestId: '123',
  });
  assert.equal(unnamed.skipped, true);
});

test('Reproduction 20: a newer main does not replace the released commit', () => {
  const released = 'released-commit';
  const newer = 'newer-main-commit';
  const dir = mkdtempSync(join(tmpdir(), 'nightly-pin-'));
  try {
    const calls = join(dir, 'calls');
    writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
let body = '';
if (process.argv.includes('--input')) body = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.CALLS, JSON.stringify({ args: process.argv.slice(2), body }) + '\\n');
const endpoint = process.argv.find(arg => String(arg).includes('repos/')) || '';
if (endpoint.includes('unified-release')) {
  console.log(JSON.stringify({ workflow_runs: [{ id: 99, status: 'in_progress', html_url: 'https://example.test/release' }] }));
} else if (endpoint.endsWith('commits/main')) {
  console.log(JSON.stringify({ sha: ${JSON.stringify(newer)} }));
} else {
  console.log('');
}
`, { mode: 0o755 });
    const summary = join(dir, 'summary.txt');
    const result = spawnSync(process.execPath, [resolve('packages/scripts/nightly-checks.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: calls,
        GITHUB_REPOSITORY: 'fixture/repo', GITHUB_RUN_ID: '123',
        GITHUB_SERVER_URL: 'https://example.test', GITHUB_STEP_SUMMARY: summary,
        RELEASE_SHA: released, RELEASE_RUN_ID: '99',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const saved = JSON.parse(readFileSync(join(dir, 'nightly-checks.json'), 'utf8'));
    assert.equal(saved.requestedSha, released);
    assert.equal(saved.dispatched, true);
    const recorded = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(recorded.some(call => call.args.some(arg => String(arg).endsWith('commits/main'))), false);
    const post = recorded.find(call => call.args.includes('POST') && call.args.some(arg => String(arg).includes('checks.yml/dispatches')));
    assert.deepEqual(JSON.parse(post.body), {
      ref: 'main',
      inputs: { suite: 'all', nightly_id: '123', pinned_sha: released },
    });
    assert.match(readFileSync(summary, 'utf8'), new RegExp(released));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Reproduction 20: completion reports the released commit when main has moved', () => {
  const released = 'released-commit';
  const newer = 'newer-main-commit';
  const dir = mkdtempSync(join(tmpdir(), 'nightly-finish-'));
  try {
    const calls = join(dir, 'calls');
    const run = {
      id: 7, event: 'workflow_dispatch', head_branch: 'main', head_sha: newer,
      path: '.github/workflows/checks.yml', display_title: `Nightly Checks 123 ${released}`,
      status: 'completed', html_url: 'https://example.test/runs/7', run_attempt: 1,
    };
    const state = { ...run, conclusion: 'success', status: 'completed', run_attempt: 1, head_sha: newer };
    const job = { name: 'TYPECHECK', conclusion: 'success', started_at: '2026-11-12T07:00:00Z', completed_at: '2026-11-12T07:05:00Z' };
    writeFileSync(join(dir, 'event.json'), JSON.stringify({ workflow_run: run }));
    writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
const endpoint = process.argv.find(arg => String(arg).includes('repos/')) || '';
if (endpoint.includes('/jobs')) console.log(JSON.stringify({ total_count: 1, jobs: ${JSON.stringify([job])} }));
else if (endpoint.includes('/actions/runs/7')) console.log(JSON.stringify(${JSON.stringify(state)}));
else if (endpoint.includes('/issues')) console.log('[]');
else console.log('{}');
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [resolve('packages/scripts/nightly-checks.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: calls,
        GITHUB_REPOSITORY: 'fixture/repo', GITHUB_RUN_ID: '8',
        GITHUB_SERVER_URL: 'https://example.test', GITHUB_STEP_SUMMARY: join(dir, 'summary.txt'),
        GITHUB_EVENT_PATH: join(dir, 'event.json'), EVENT_NAME: 'workflow_run',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const saved = JSON.parse(readFileSync(join(dir, 'nightly-checks.json'), 'utf8'));
    assert.equal(saved.sha, released);
    assert.notEqual(saved.sha, newer);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

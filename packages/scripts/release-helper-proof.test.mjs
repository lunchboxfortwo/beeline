import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { localHooks } from './release-local.mjs';

test('published local release records include full-check evidence and honest Mac verification', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'release-record-checks-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'release'));
  const path = join(directory, 'release/release.json');
  const checks = { sourceSha: 'a'.repeat(40), result: 'success', resultsPath: '/private/full-checks/release-checks.json' };
  writeFileSync(path, JSON.stringify({ runId: 123, components: {}, delivery: {} }));
  await localHooks(directory, {}).afterStep({ step: { name: 'Finalize the release record' }, context: {
    runner: { temp: directory }, inputs: { channel: 'latest', dispatched_by: '{}' },
  }, engine: { variables: { releaseChecks: checks, macHelperMode: 'build', desktopMode: 'build' } } });
  const record = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(record.checks, checks);
  assert.equal(record.delivery.localExceptions.helperArm64, 'built and install-verified on GitHub-hosted macos-15');
  assert.equal(record.delivery.localExceptions.helperX64, 'built and install-verified on GitHub-hosted macos-15-intel');
});
test('explicit Mac carry checks durable release counters before delivery, including releases without helper publication', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'release-carry-plan-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'previous'));
  const bundle = { commit: 'b'.repeat(40), version: 'v0.1.208', sha256: 'c'.repeat(64) };
  bundle.carriedFrom = { ...bundle, releases: 3 };
  writeFileSync(join(directory, 'previous/release.json'), JSON.stringify({ components: { helper: { platforms: { 'darwin-arm64': bundle } } } }));
  await assert.rejects(localHooks(directory, {}).afterStep({
    step: { name: 'Produce the inspectable release plan' }, result: { outputs: { run_helper: 'true' } },
    context: { runner: { temp: directory } }, engine: { variables: { macHelperMode: 'carry' } },
  }), /more than 3 releases/);
});
test('finalization preserves carry age accumulated since the channel manifest last changed', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'release-carry-record-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of ['release', 'previous', 'jobs/helper-local/daemon-release']) mkdirSync(join(directory, path), { recursive: true });
  const bundle = { commit: 'b'.repeat(40), version: 'v0.1.208', sha256: 'c'.repeat(64) };
  const carried = releases => ({ ...bundle, carriedFrom: { ...bundle, releases } });
  writeFileSync(join(directory, 'previous/release.json'), JSON.stringify({ components: {
    helper: { platforms: { 'darwin-arm64': carried(2) } }, website: { sourceSha: 'd'.repeat(40) },
  } }));
  writeFileSync(join(directory, 'jobs/helper-local/daemon-release/manifest.json'), JSON.stringify({ bundles: { 'darwin-arm64': carried(1) } }));
  const path = join(directory, 'release/release.json');
  writeFileSync(path, JSON.stringify({ components: { helper: {}, website: {} }, delivery: {} }));
  await localHooks(directory, {}).afterStep({ step: { name: 'Finalize the release record' }, context: {
    runner: { temp: directory }, inputs: { channel: 'latest', dispatched_by: '{}' },
  }, engine: { variables: { macHelperMode: 'carry' } } });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).components.helper.platforms['darwin-arm64'].carriedFrom.releases, 3);
});

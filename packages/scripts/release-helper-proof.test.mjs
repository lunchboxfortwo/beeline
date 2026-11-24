import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { localHooks } from './release-local.mjs';

test('published local release records include quick-check evidence and honest Mac verification', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'release-record-checks-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'release'));
  const path = join(directory, 'release/release.json');
  const results = join(directory, 'release-checks.json');
  writeFileSync(results, '{"typecheck":{"result":"success"}}\n');
  const checked = { id: 'release_checks/typecheck-local', conclusion: 'success', steps: [] };
  const records = JSON.stringify([checked, { id: 'server-local', conclusion: 'success', steps: [
    { name: 'Build the exact Fly image', seconds: 201.4, started_at: '2026-11-21T03:20:00.000Z', outcome: 'success' }] }]);
  writeFileSync(join(directory, 'records.json'), records);
  writeFileSync(join(directory, 'release-checks-timing.json'), '{"wallSeconds":2442.5}');
  const checks = { profile: 'quick', sourceSha: 'a'.repeat(40), result: 'success', resultsPath: results,
    wallSeconds: 2442.5, completedAt: '2026-11-21T03:56:45.000Z' };
  const triggerEpoch = Date.parse('2026-11-21T03:16:07Z') / 1000;
  const checkedEpoch = Date.parse(checks.completedAt) / 1000, completedAt = checkedEpoch + 834;
  writeFileSync(path, JSON.stringify({ runId: 123, version: 'v0.1.242-rc.1', components: {},
    delivery: { live: { triggerEpoch, completedAt, elapsedSeconds: completedAt - triggerEpoch } } }));
  await localHooks(directory, {}).afterStep({ step: { name: 'Finalize the release record' }, context: {
    github: { repository: 'lunchboxfortwo/beeline' }, runner: { temp: directory },
    inputs: { channel: 'next', dispatched_by: '{}' },
  }, engine: { variables: { releaseChecks: checks, macHelperMode: 'build', desktopMode: 'build' } } });
  const record = JSON.parse(readFileSync(path, 'utf8'));
  const assets = 'https://github.com/lunchboxfortwo/beeline/releases/download/v0.1.242-rc.1';
  const published = { ...checks, resultsPath: `${assets}/release-checks.json`,
    recordsPath: `${assets}/records.json`, timingPath: `${assets}/release-checks-timing.json` };
  assert.deepEqual(record.checks, published);
  assert.deepEqual(record.delivery.localExceptions.checks, published);
  assert.equal(checks.resultsPath, results);
  const copied = readFileSync(join(directory, 'release/release-checks.json'), 'utf8');
  assert.equal(copied, readFileSync(results, 'utf8'));
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'release/records.json'), 'utf8')), [checked]);
  assert.equal(readFileSync(join(directory, 'release/release-checks-timing.json'), 'utf8'), '{"wallSeconds":2442.5}');
  assert.deepEqual(record.delivery.live.profile, { server: [
    { name: 'Build the exact Fly image', seconds: 201.4 }] });
  const { live } = record.delivery;
  assert.equal(live.checksSeconds, checkedEpoch - triggerEpoch);
  assert.equal(live.deploySeconds, 834);
  assert.equal(live.checksSeconds + live.deploySeconds, live.elapsedSeconds);
  assert.equal(record.delivery.localExceptions.helperArm64, 'built and install-verified on GitHub-hosted macos-15');
  assert.equal(record.delivery.localExceptions.helperX64, 'built and install-verified on GitHub-hosted macos-15-intel');
});
test('check evidence holding a release secret or credential stays unpublished', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'release-record-evidence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'release'));
  const path = join(directory, 'release/release.json'), results = join(directory, 'release-checks.json');
  writeFileSync(results, '{}');
  writeFileSync(join(directory, 'records.json'), '[{"id":"release_checks/fixture","note":"fixture-release-secret"}]');
  writeFileSync(join(directory, 'release-checks-timing.json'), `{"note":"gh${'p'}_${'a'.repeat(36)}"}`);
  const checks = { profile: 'quick', sourceSha: 'a'.repeat(40), result: 'success', resultsPath: results };
  writeFileSync(path, JSON.stringify({ version: 'v0.1.242-rc.1', components: {}, delivery: {} }));
  const logged = [];
  await localHooks(directory, { masks: new Set(['fixture-release-secret']), log: line => logged.push(line) }).afterStep({
    step: { name: 'Finalize the release record' }, context: { github: { repository: 'lunchboxfortwo/beeline' }, runner: { temp: directory },
      inputs: { channel: 'next', dispatched_by: '{}' } }, engine: { variables: { releaseChecks: checks, macHelperMode: 'build', desktopMode: 'build' } } });
  const record = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(record.checks.recordsPath, undefined);
  assert.equal(record.checks.timingPath, undefined);
  for (const name of ['records.json', 'release-checks-timing.json']) assert.equal(existsSync(join(directory, 'release', name)), false);
  assert.equal(logged.length, 2);
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
  const sourceSha = 'a'.repeat(40), checks = { profile: 'quick', sourceSha, result: 'success' };
  writeFileSync(path, JSON.stringify({ sourceSha, components: { helper: {}, website: {} }, delivery: {} }));
  await localHooks(directory, {}).afterStep({ step: { name: 'Finalize the release record' }, context: {
    runner: { temp: directory }, inputs: { channel: 'next', dispatched_by: '{}' },
  }, engine: { variables: { macHelperMode: 'carry', releaseChecks: checks } } });
  const record = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(record.components.helper.platforms['darwin-arm64'].carriedFrom.releases, 3);
  assert.deepEqual(record.checks, checks);
});

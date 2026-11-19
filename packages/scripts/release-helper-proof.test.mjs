import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { localHooks, macHelperJob } from './release-local.mjs';
import { LocalDelivery } from './release-local-delivery.mjs';

const root = resolve(import.meta.dirname, '../..');
test('both local Mac jobs build fresh on the Intel host and serialize on its existing slot', async () => {
  const original = parse(readFileSync(join(root, '.github/workflows/unified-release.yml'), 'utf8')).jobs.helper_macos;
  const job = macHelperJob(original);
  assert.ok(original.steps.some(step => step.id === 'carry_bundle'));
  assert.ok(!job.steps.some(step => ['previous_bundle', 'carry_bundle', 'native_cache'].includes(step.id)));
  assert.equal(job.steps.find(step => step.name === 'Require the native build architecture').run, 'test "$(uname -m)" = x86_64');
  assert.equal(job.steps.find(step => step.name === 'Build and install-verify the native helper').if, "steps.shipped.outputs.shipped != 'true'");
  const slots = [], delivery = new LocalDelivery({ variables: { macHelperMode: 'build' } });
  delivery.execute = async (slot, _job, context) => { slots.push([slot, context.matrix.platform]); return { result: 'success' }; };
  await Promise.all(['darwin-arm64', 'darwin-x64'].map(platform => delivery.run(job, { github: { job: 'helper_macos' }, matrix: { platform } })));
  assert.deepEqual(slots, [[4, 'darwin-arm64'], [4, 'darwin-x64']]);
});
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
  assert.match(record.delivery.localExceptions.helperArm64, /cross-built.*lipo and codesign verified/);
  assert.match(record.delivery.localExceptions.helperX64, /install-verified/);
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

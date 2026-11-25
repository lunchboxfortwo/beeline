import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { LocalActions } from './release-local-actions.mjs';
import { LocalChecks } from './release-local-checks.mjs';
import { localHooks } from './release-local.mjs';
import { Processes } from './release-local-process.mjs';

const root = resolve(import.meta.dirname, '../..'), sha = 'a'.repeat(40);
for (const outcome of ['success', 'failure', 'wrong-sha', 'skipped']) test(`real release graph overlaps builds and gates promotion: ${outcome}`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'release-gate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let releaseChecks, built;
  const checksReady = new Promise(resolve => { releaseChecks = resolve; });
  const builds = new Promise(resolve => { built = resolve; });
  const releaseSha = outcome === 'wrong-sha' ? 'b'.repeat(40) : sha;
  const skip = outcome === 'skipped' ? { profile: 'quick', sourceSha: sha, result: 'skipped', ownerMessageId: 'owner-42' } : undefined;
  const processes = new Processes({}, () => {}), started = new Set(), jobs = [];
  const early = ['helper_linux', 'helper_macos'];
  t.mock.method(LocalChecks.prototype, 'prepare', () => checksReady);
  t.mock.method(LocalChecks.prototype, 'finish', function () {
    writeFileSync(join(directory, 'release-checks-timing.json'), JSON.stringify({
      wallSeconds: 2, completedAt: '2026-11-23T00:00:00Z',
    }));
  });
  t.mock.method(LocalChecks.prototype, 'execute', async (_slot, _job, context) => {
    assert.deepEqual(context.inputs, { suite: 'all', release_sha: sha });
    const id = context.github.job;
    jobs.push(id);
    return { result: outcome === 'failure' && id === 'codecs' ? 'failure' : 'success', outputs: {} };
  });
  const markBuild = id => {
    started.add(id);
    if (early.every(build => started.has(build))) built();
  };
  let requestId;
  // Only the GitHub process boundary is substituted; execute the real Mac hook.
  processes.run = async (command, args, options) => {
    if (command === 'bash') return Processes.prototype.run.call(processes, command, args, options);
    assert.equal(command, 'gh');
    if (args[0] === 'workflow') {
      requestId = args.at(-1).slice('request_id='.length);
      markBuild('helper_macos');
      return '';
    }
    if (args[0] === 'run' && args[1] === 'download') return '';
    assert.equal(args[0], 'api');
    if (args[1].includes('/workflows/mac-helpers.yml/runs')) return JSON.stringify({ workflow_runs: [
      { id: 77, display_title: `Mac helpers · ${requestId}` },
    ] });
    if (args[1].endsWith('/runs/77')) return JSON.stringify({ id: 77, status: 'completed' });
    assert.ok(args[1].endsWith('/runs/77/jobs?per_page=10'));
    return JSON.stringify({ jobs: ['darwin-arm64', 'darwin-x64'].map(platform => ({
      name: `HELPER BUILD (${platform})`, conclusion: 'success',
    })) });
  };
  const hooks = localHooks(directory, processes), original = hooks.workflow;
  hooks.workflow = async args => {
    const execution = await original(args);
    if (args.file.endsWith('unified-release.yml')) args.engine.localDelivery.execute = async (_slot, _job, context) => {
      const id = context.github.job;
      markBuild(id);
      return { result: 'success', outputs: id === 'initialize' ? {
        run_helper: 'true', run_server: 'true', run_mobile_ota: 'true', run_website: 'true', run_desktop: 'true', release_sha: releaseSha, release_version: 'v1.2.3-rc.1',
      } : {} };
    };
    return execution;
  };
  const engine = new LocalActions({ root, directory, processes, variables: { releaseChecks: skip, macHelperMode: 'build' }, hooks });
  const run = engine.workflow('.github/workflows/unified-release.yml', { channel: 'next' }, {
    github: { sha, repository: 'lunchboxfortwo/beeline', run_id: 'test', event_name: 'workflow_dispatch' },
  });
  await Promise.race([builds, run]);
  for (const id of early) assert.ok(started.has(id), id);
  const delivery = ['helper', 'server', 'mobile_ota', 'website', 'desktop_build'];
  if (outcome !== 'skipped' && outcome !== 'wrong-sha') {
    for (const id of delivery) assert.equal(started.has(id), false, id);
  }
  releaseChecks();
  const results = await run;
  assert.equal(results.helper_macos.result, 'success');
  for (const platform of ['darwin-arm64', 'darwin-x64'])
    assert.ok(engine.artifacts.has(`daemon-${platform}-v1.2.3-rc.1-${releaseSha}`));
  const authorized = outcome === 'success' || outcome === 'skipped';
  assert.equal(results.release_validation.result, authorized ? 'success' : 'failure');
  assert.equal(results.desktop_installers.result, authorized ? 'success' : 'skipped');
  for (const id of delivery) assert.equal(started.has(id), authorized, id);
  if (outcome === 'success' || outcome === 'failure') {
    assert.deepEqual(jobs.sort(), ['codecs', 'dead-code', 'typecheck']);
    const { profile, sourceSha, result, resultsPath } = engine.variables.releaseChecks;
    assert.deepEqual([profile, sourceSha, result], ['quick', sha, outcome]);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(resultsPath, 'utf8'))).sort(), jobs);
  } else {
    assert.deepEqual(jobs, []);
    assert.deepEqual(engine.variables.releaseChecks, skip);
  }
  assert.equal(started.has('nightly_checks'), false);
});

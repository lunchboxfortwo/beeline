import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { LocalActions } from './release-local-actions.mjs';
import { localHooks } from './release-local.mjs';
import { Processes } from './release-local-process.mjs';

const root = resolve(import.meta.dirname, '../..'), sha = 'a'.repeat(40);
for (const outcome of ['success', 'failure', 'wrong-sha', 'skipped']) test(`real release graph overlaps builds and gates promotion: ${outcome}`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'release-gate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let resolveGate, rejectGate, built;
  const checksGate = new Promise((yes, no) => { resolveGate = yes; rejectGate = no; });
  const builds = new Promise(yes => { built = yes; });
  const checks = { sourceSha: outcome === 'wrong-sha' ? 'b'.repeat(40) : sha, result: outcome === 'skipped' ? 'skipped' : 'success', ...(outcome === 'skipped' ? { ownerMessageId: 'owner-42' } : {}) };
  const processes = new Processes({}, () => {}), started = new Set(), verdictFiles = {};
  // Server and OTA start with the builds; their workers wait for the verdict file.
  const early = ['helper_linux', 'helper_macos', 'server', 'mobile_ota'];
  const markBuild = id => {
    started.add(id);
    if (early.every(build => started.has(build))) built();
  };
  let requestId;
  // Only the GitHub process boundary is substituted; execute the real Mac hook.
  processes.run = async (command, args) => {
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
  const hooks = localHooks(directory, processes, { checksGate }), original = hooks.workflow;
  hooks.workflow = async args => {
    const execution = await original(args);
    if (args.file.endsWith('unified-release.yml')) args.engine.localDelivery.execute = async (_slot, _job, context, _label, _env, options) => {
      const id = context.github.job;
      if (options?.verdictFile) verdictFiles[id] = options.verdictFile;
      markBuild(id);
      return { result: 'success', outputs: id === 'initialize' ? {
        run_helper: 'true', run_server: 'true', run_mobile_ota: 'true', run_website: 'true', run_desktop: 'true', release_sha: sha, release_version: 'v1.2.3-rc.1',
      } : {} };
    };
    return execution;
  };
  const engine = new LocalActions({ root, directory, processes, variables: { releaseChecks: checks, macHelperMode: 'build' }, hooks });
  const run = engine.workflow('.github/workflows/unified-release.yml', { channel: 'next' }, {
    github: { sha, repository: 'lunchboxfortwo/beeline', run_id: 'test' },
  });
  await builds;
  for (const id of ['helper', 'website', 'release_result']) assert.equal(started.has(id), false, id);
  assert.deepEqual(Object.keys(verdictFiles).sort(), ['mobile_ota', 'server']);
  for (const file of Object.values(verdictFiles)) assert.equal(existsSync(file), false);
  if (outcome === 'failure') rejectGate(new Error('full suite failed')); else resolveGate();
  const results = await run;
  assert.equal(results.helper_macos.result, 'success');
  for (const platform of ['darwin-arm64', 'darwin-x64'])
    assert.ok(engine.artifacts.has(`daemon-${platform}-v1.2.3-rc.1-${sha}`));
  assert.equal(results.release_validation.result, ['failure', 'wrong-sha'].includes(outcome) ? 'failure' : 'success');
  for (const id of ['helper', 'website']) assert.equal(started.has(id), ['success', 'skipped'].includes(outcome), id);
  for (const file of Object.values(verdictFiles))
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).authorized, ['success', 'skipped'].includes(outcome));
  assert.equal(started.has('release_checks'), false);
  assert.equal(started.has('nightly_checks'), false);
});

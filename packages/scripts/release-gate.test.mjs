import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
  const processes = new Processes({}, () => {}), started = new Set();
  const hooks = localHooks(directory, processes, { checksGate }), original = hooks.workflow;
  hooks.workflow = async args => {
    const execution = await original(args);
    if (args.file.endsWith('unified-release.yml')) args.engine.localDelivery.execute = async (_slot, _job, context) => {
      const id = context.github.job;
      started.add(id);
      if (started.has('helper_linux') && started.has('helper_macos')) built();
      return { result: 'success', outputs: id === 'initialize' ? {
        run_helper: 'true', run_server: 'true', run_mobile_ota: 'true', run_website: 'true', run_desktop: 'true', release_sha: sha,
      } : {} };
    };
    return execution;
  };
  const engine = new LocalActions({ root, directory, processes, variables: { releaseChecks: checks, macHelperMode: 'build' }, hooks });
  const run = engine.workflow('.github/workflows/unified-release.yml', { channel: 'next' }, {
    github: { sha, repository: 'lunchboxfortwo/beeline', run_id: 'test' },
  });
  await builds;
  for (const id of ['helper', 'server', 'mobile_ota', 'website', 'release_result']) assert.equal(started.has(id), false, id);
  if (outcome === 'failure') rejectGate(new Error('full suite failed')); else resolveGate();
  const results = await run;
  assert.equal(results.release_validation.result, ['failure', 'wrong-sha'].includes(outcome) ? 'failure' : 'success');
  for (const id of ['helper', 'server', 'mobile_ota', 'website']) assert.equal(started.has(id), ['success', 'skipped'].includes(outcome), id);
  assert.equal(started.has('release_checks'), false);
  assert.equal(started.has('nightly_checks'), false);
});

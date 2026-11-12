import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { coverageMapReads } from '../apps/server/scripts/coverage-map-artifact.mjs';
import { releaseIdentityReads, releaseStartRestCallCount } from './release-record.mjs';

const workflow = name => parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8'));
const checks = workflow('checks');
const release = workflow('unified-release');

test('merging to main triggers no push workflow; PRs, merge-queue groups and manual suites keep their Checks contexts', () => {
  for (const file of readdirSync('.github/workflows').filter(file => file.endsWith('.yml'))) {
    const triggers = parse(readFileSync(`.github/workflows/${file}`, 'utf8')).on;
    assert.equal(triggers?.push, undefined, `${file} still runs on push`);
  }
  assert.ok(checks.on.pull_request); assert.ok(checks.on.workflow_dispatch); assert.ok(checks.on.workflow_call);
  // The main merge queue waits for every required context on its merge-group commit (item 19, 12 Nov).
  assert.deepEqual(checks.on.merge_group, { types: ['checks_requested'] });
  for (const job of ['typecheck', 'body-suite', 'server-suite-shard', 'server-claim-latency', 'mobile-suite', 'mobile-export-reachability', 'native-fingerprint', 'actionlint']) {
    assert.doesNotMatch(checks.jobs[job].if, /github.event_name == 'pull_request'\)?"?$/, `${job} skips merge groups`);
  }
  assert.equal(checks.jobs['coverage-map-check'].name, 'SERVER COVERAGE MAP');
  assert.equal(checks.jobs['coverage-map-check'].if, "github.event_name == 'pull_request'");
  const mapCheck = checks.jobs['coverage-map-check'].steps.find(step => step.run?.includes('check-map'));
  assert.ok(mapCheck);
  assert.ok(checks.on.workflow_dispatch.inputs.suite.options.includes('coverage-map'));
  assert.equal(checks.jobs.typecheck.name, 'TYPECHECK');
  assert.equal(checks.jobs['shared-package-tests'].name, 'SHARED PACKAGE TESTS');
});

test('full Checks checks out the exact release SHA and never applies PR selection during release', () => {
  assert.equal(release.jobs.release_checks.uses, './.github/workflows/checks.yml');
  assert.deepEqual(release.jobs.release_checks.with, { suite: 'all', release_sha: '${{ needs.initialize.outputs.release_sha }}' });
  for (const [name, job] of Object.entries(checks.jobs)) {
    if (name === 'coverage-map-check') continue; // PR-only validation of the existing map.
    for (const step of job.steps ?? []) {
      if (step.uses === 'actions/checkout@v4') assert.equal(step.with.ref, '${{ inputs.release_sha || github.sha }}');
      if (step.run?.includes('test-selection.mjs select')) assert.match(step.if, /github.event_name == 'pull_request'/);
    }
  }
  const shard = checks.jobs['server-suite-shard'];
  assert.deepEqual(shard.strategy.matrix.shard, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(shard.strategy['fail-fast'], false);
  assert.equal(shard.steps.filter(step => step.run?.includes('node scripts/run-ci-shard.mjs')).length, 1);
  assert.equal(shard.steps.filter(step => step.run?.includes('node scripts/run-integration-shard.mjs')).length, 1);
  const timing = checks.jobs['production-corpus-replay'].steps.find(step => step.name?.startsWith('Run server wall-clock'));
  assert.match(timing.if, /github.event_name == 'pull_request'/);
});

test('every delivery leg requires successful release tests, including jobs with always or cancelled conditions', () => {
  const gate = release.jobs.release_validation;
  assert.deepEqual(gate.needs, ['initialize', 'release_checks']);
  for (const name of ['server', 'helper_linux', 'helper_macos', 'helper', 'release_proof', 'mobile_ota',
    'mobile_ota_after_proof', 'desktop_installers', 'website', 'mobile_native_android', 'mobile_native_ios']) {
    const job = release.jobs[name];
    assert.ok(job.needs.includes('release_validation'), name);
    assert.match(job.if, /needs.release_validation.result == 'success'/, name);
  }
  const final = release.jobs.release_result;
  assert.ok(final.needs.includes('release_validation'));
  assert.match(final.steps.find(step => step.id === 'result').run, /TEST_RESULT.*success.*failure_class=release-tests/);
  const build = gate.steps.find(step => step.run?.includes('build-map'));
  assert.equal(build.if, "needs.release_checks.result == 'success'");
  assert.match(build.run, /--commit "\$RELEASE_SHA" --release-run "\$GITHUB_RUN_ID"/);
  assert.match(build.run, /check-map/);
  assert.ok(gate.steps.some(step => step.run?.includes('release-test-report.mjs')));
  assert.ok(gate.steps.some(step => step.uses === 'actions/upload-artifact@v4' && step.with.name === 'server-coverage-map'));
  const saved = gate.steps.find(step => step.uses === 'actions/cache/save@v4');
  assert.equal(saved.with.path, '${{ runner.temp }}/map/server-coverage-map.json');
  assert.equal(saved.with.key, 'server-coverage-map-${{ needs.initialize.outputs.release_sha }}');
  assert.equal(saved['continue-on-error'], true);
  const shard = checks.jobs['server-suite-shard'];
  const restored = shard.steps.find(step => step.uses === 'actions/cache/restore@v4' && step.with.key === 'server-coverage-map-${{ github.sha }}');
  assert.equal(restored.with['restore-keys'], 'server-coverage-map-');
  assert.match(restored.if, /github.event_name == 'pull_request'/);
  const mapCheck = checks.jobs['coverage-map-check'];
  assert.ok(mapCheck.steps.some(step => step.uses === 'actions/cache/restore@v4' && step.with.key === 'server-coverage-map-${{ github.sha }}'));
  assert.equal(shard.steps.some(step => step.run?.includes('coverage-map-artifact.mjs')), false);
  assert.match(final.steps.find(step => step.id === 'notification').if, /needs.release_validation.result == 'success'/);
});

test('the on-demand coverage map can save its cache only when every caller allows it', () => {
  const map = workflow('server-coverage-map').jobs.map.permissions;
  assert.equal(map.contents, 'read');
  assert.equal(map.actions, 'write');
  const caller = checks.jobs['coverage-map'];
  assert.equal(caller.uses, './.github/workflows/server-coverage-map.yml');
  assert.equal(caller.permissions.contents, 'read');
  assert.equal(caller.permissions.actions, 'write');
  const releaseCaller = release.jobs.release_checks.permissions;
  assert.equal(releaseCaller.contents, 'read');
  assert.equal(releaseCaller.actions, 'write');
  assert.equal(releaseCaller.packages, 'write');
});

test('one pull request Checks run fetches the coverage map from one job', () => {
  let jobs = 0;
  for (const job of Object.values(checks.jobs)) {
    if ((job.steps ?? []).some(step => step.run?.includes('coverage-map-artifact.mjs')))
      jobs += job.strategy?.matrix?.shard?.length ?? 1;
  }
  assert.equal(jobs, 1);
  // Two list reads plus the zip of the chosen map.
  assert.equal(coverageMapReads().length + 1, 3);
});

test('a release start lists one page and creates its draft once', () => {
  assert.deepEqual(releaseIdentityReads(), ['releases?per_page=100']);
  assert.equal(releaseStartRestCallCount(), 4);
  const steps = release.jobs.initialize.steps;
  const identity = steps.find(step => step.id === 'identity');
  const clock = steps.find(step => step.id === 'clock');
  const mint = steps.find(step => step.id === 'app_token');
  assert.equal((identity.run.match(/gh release create/g) ?? []).length, 1);
  assert.doesNotMatch(identity.run, /ghr_|gh-release-retry/);
  assert.match(clock.with.script, /getWorkflowRun/);
  assert.match(mint.run, /github-app-installation-token\.mjs/);
  assert.equal(mint.env.GITHUB_APP_ID, '${{ secrets.BEELINE_GITHUB_APP_ID }}');
  assert.equal(mint.env.GITHUB_APP_PRIVATE_KEY, '${{ secrets.BEELINE_GITHUB_APP_PRIVATE_KEY }}');
  assert.equal(clock.with['github-token'], '${{ steps.app_token.outputs.token }}');
  assert.equal(identity.env.GH_TOKEN, '${{ steps.app_token.outputs.token }}');
  assert.ok(steps.findIndex(step => step.id === 'app_token') < steps.findIndex(step => step.id === 'clock'));
});

test('workspace archives and provenance use the checkout SHA when a release promotes an older commit', () => {
  const action = parse(readFileSync('.github/actions/ci-workspace/action.yml', 'utf8'));
  assert.match(action.runs.steps.find(step => step.id === 'checkout').run, /git rev-parse HEAD/);
  for (const step of action.runs.steps) {
    if (step.env?.CI_BUILD_SHA) assert.equal(step.env.CI_BUILD_SHA, '${{ steps.checkout.outputs.sha }}');
    if (step.with?.key?.startsWith('ci-build-')) assert.match(step.with.key, /steps.checkout.outputs.sha/);
  }
});

test('ACTIONLINT uses the runner ShellCheck without refreshing apt mirrors', () => {
  const job = checks.jobs.actionlint;
  assert.equal(job['timeout-minutes'], 5);
  assert.ok(job.steps.some(step => step.run === 'shellcheck --version'));
  assert.ok(job.steps.some(step => step.run === 'npm run lint:shell'));
  for (const step of job.steps) assert.doesNotMatch(step.run ?? '', /\bapt(?:-get)?\b/);
});

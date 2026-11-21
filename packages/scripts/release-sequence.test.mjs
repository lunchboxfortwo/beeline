import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseArguments, releaseSequence } from './release.mjs';

const sha = 'a'.repeat(40);
const spec = { source: '/source', sha, directory: '/state', store: true };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
test('full checks overlap builds, gate promotion on the exact SHA and record both channel results', async () => {
  const verdict = deferred(), build = deferred(), calls = [];
  let promoted = false;
  const release = releaseSequence(spec, async (args, options) => {
    calls.push(args);
    if (args.leg) return verdict.promise;
    if (args.channel === 'next') build.resolve();
    await options.checksGate;
    assert.equal(args.checks.sourceSha, args['release-sha']);
    promoted = true;
  }, () => {}, () => {});
  await build.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.map(args => args.leg || args.channel), ['next', 'release_checks']);
  assert.equal(promoted, false);
  verdict.resolve();
  await release;
  assert.equal(promoted, true);
  assert.equal(calls.at(-1).channel, 'latest');
  for (const args of calls.filter(args => !args.leg)) {
    assert.equal(args.checks.result, 'success');
    assert.equal(args.checks.resultsPath, '/state/full-checks/release-checks.json');
    assert.equal(typeof args.checks.wallSeconds, 'number');
    assert.ok(Number.isFinite(Date.parse(args.checks.completedAt)));
  }
});
test('checks failure blocks promotion and waits for the build sibling before returning', async () => {
  const verdict = deferred(), build = deferred(), started = deferred();
  let finished = false, promoted = false;
  const release = releaseSequence(spec, async (args, options) => {
    if (args.leg) return verdict.promise;
    started.resolve();
    await build.promise;
    await options.checksGate;
    promoted = true;
  }, () => {}, () => {}).finally(() => { finished = true; });
  const rejection = assert.rejects(release, /bad suite/);
  await started.promise;
  verdict.reject(new Error('bad suite'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  build.resolve();
  await rejection;
  assert.equal(promoted, false);
});
test('only an explicit owner-message skip omits Checks and records the exception', async () => {
  assert.deepEqual(releaseArguments(['--skip-full-checks', 'owner-message-42']), { skipFullChecks: 'owner-message-42' });
  for (const argv of [['--skip-full-checks'], ['--skip-full-checks', ' '], ['--skip-full-checks', '--no-store']])
    assert.throws(() => releaseArguments(argv), /Usage/);
  const calls = [];
  await releaseSequence({ ...spec, skipFullChecks: 'owner-message-42' }, async (args, options) => {
    calls.push(args);
    await options.checksGate;
  }, () => {}, () => assert.fail('skipped checks cannot run audit'));
  assert.deepEqual(calls.map(args => args.channel), ['next', 'latest']);
  for (const args of calls) assert.deepEqual(args.checks, { sourceSha: sha, result: 'skipped', ownerMessageId: 'owner-message-42' });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseArguments, releaseSequence, removeReleaseDirectory, removeStaleReleaseImages, staleReleaseImages } from './release.mjs';

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
test('a finished release removes its whole working directory', () => {
  const calls = [];
  removeReleaseDirectory('/tmp/beeline-release-427CG5', (command, args) => calls.push([command, ...args]));
  assert.deepEqual(calls, [['sudo', '-n', 'rm', '-rf', '/tmp/beeline-release-427CG5']]);
});
test('release image cleanup keeps the current and previous release and never touches other images', () => {
  const [current, previous, older, oldest] = ['95eae3e06540', '90e4770917fe', '8a75d2ee5b27', 'a8dc3a6492d0'].map(short => short.padEnd(40, '0'));
  const image = (id, sha, created, ...tags) => ({ id: `sha256:${id}`, sha, created, tags });
  const images = [
    image('c1', current, '2026-11-21T04:05:38Z', 'registry.fly.io/beeline-server:0.1.242-rc.1-95eae3e06540'),
    image('c2', current, '2026-11-21T04:02:56Z', 'registry.fly.io/beeline-free-agents:0.1.242-rc.1-95eae3e06540'),
    image('p1', previous, '2026-11-21T01:11:55Z', 'registry.fly.io/beeline-server:0.1.241-rc.3-90e4770917fe'),
    image('o1', older, '2026-11-21T00:16:05Z', 'registry.fly.io/beeline-server:0.1.241-rc.2-8a75d2ee5b27'),
    image('o2', oldest, '2026-11-20T21:30:36Z', 'registry.fly.io/beeline-free-agents:0.1.241-rc.1-a8dc3a6492d0', 'beeline-free-agent:proof'),
    image('o3', oldest, '2026-11-20T21:20:00Z'),
    image('p2', previous, '2026-11-21T01:10:00Z'),
    image('x1', oldest, '2026-11-20T10:00:00Z', 'beeline-server-cachetest:latest'),
    image('x2', '', '2026-11-01T10:00:00Z', 'pgvector/pgvector:pg16'),
  ];
  assert.deepEqual(staleReleaseImages(images, current), [
    'registry.fly.io/beeline-server:0.1.241-rc.2-8a75d2ee5b27',
    'registry.fly.io/beeline-free-agents:0.1.241-rc.1-a8dc3a6492d0',
    'sha256:o3',
  ]);
  const calls = [];
  removeStaleReleaseImages(current, (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'images') return images.map(entry => entry.id).join('\n') + '\n';
    if (args[0] === 'image' && args[1] === 'inspect') return images.map(entry => JSON.stringify({ Id: entry.id, RepoTags: entry.tags, Created: entry.created, Config: { Labels: entry.sha ? { 'app.usebeeline.release.sha': entry.sha } : null } })).join('\n') + '\n';
    throw new Error('conflict: image is being used by a running container');
  });
  assert.deepEqual(calls.at(-1), ['docker', 'image', 'rm', 'registry.fly.io/beeline-server:0.1.241-rc.2-8a75d2ee5b27', 'registry.fly.io/beeline-free-agents:0.1.241-rc.1-a8dc3a6492d0', 'sha256:o3']);
});

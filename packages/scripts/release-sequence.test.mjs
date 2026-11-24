import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchPromotion, releaseArguments, releaseSequence, removeReleaseDirectory, removeStaleReleaseImages, staleReleaseImages } from './release.mjs';

const sha = 'a'.repeat(40);
const spec = { source: '/source', sha, directory: '/state', dispatchedBy: { humanCommandMessageId: 'owner-message-42' } };
test('routine delivery runs next once and does not promote or authorize stores', async () => {
  const calls = [];
  await releaseSequence({ ...spec, store: true }, async args => { calls.push(args); });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'next');
  assert.equal(calls[0]['release-sha'], sha);
  assert.equal(calls[0]['store-track'], 'none');
});
test('promotion dispatches only the metadata workflow and waits for its verdict', () => {
  const calls = [];
  dispatchPromotion(spec.dispatchedBy, {}, (command, args) => {
    calls.push([command, ...args]);
    return 'https://github.com/lunchboxfortwo/beeline/actions/runs/42';
  });
  assert.deepEqual(calls, [
    ['gh', 'workflow', 'run', 'unified-release.yml', '-R', 'lunchboxfortwo/beeline', '--ref', 'main',
      '-f', 'channel=latest', '-f', `dispatched_by=${JSON.stringify(spec.dispatchedBy)}`],
    ['gh', 'run', 'watch', '42', '-R', 'lunchboxfortwo/beeline', '--exit-status'],
  ]);
});
test('promotion accepts owner attribution and rejects build and test options', async () => {
  assert.deepEqual(releaseArguments(['--skip-full-checks', 'owner-message-42']), { skipFullChecks: 'owner-message-42' });
  assert.deepEqual(releaseArguments(['--promote', '--dispatched-by', JSON.stringify(spec.dispatchedBy)]),
    { promote: true, dispatchedBy: spec.dispatchedBy });
  for (const argv of [['--skip-full-checks'], ['--skip-full-checks', ' '], ['--skip-full-checks', '--no-store'],
    ['--promote'], ['--store-track', 'production'], ['--promote', '--dispatched-by', '{}', '--store-track', 'production'],
    ['--promote', '--dispatched-by', '{}', '--desktop-mode', 'carry']])
    assert.throws(() => releaseArguments(argv), /Usage/);
  const calls = [];
  await releaseSequence({ ...spec, skipFullChecks: 'owner-message-42' }, async args => { calls.push(args); });
  assert.equal(calls[0].skipFullChecks, 'owner-message-42');
  assert.equal(calls[0]['release-sha'], sha);
});
test('a finished release removes its whole working directory', () => {
  const calls = [];
  removeReleaseDirectory('/tmp/beeline-release-427CG5', (command, args) => calls.push([command, ...args]));
  assert.deepEqual(calls, [['sudo', '-n', 'rm', '-rf', '/tmp/beeline-release-427CG5']]);
});
test('release image cleanup retains current and previous tags, then prunes dangling images', () => {
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
  removeStaleReleaseImages(current, (command, args, options) => {
    calls.push([command, ...args]);
    if (args[0] === 'images') {
      assert.equal(options.maxBuffer, 256 * 1024 * 1024);
      return images.map(entry => entry.id).join('\n') + '\n';
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      assert.equal(options.maxBuffer, 256 * 1024 * 1024);
      assert.equal(args[3], '{"id":{{json .Id}},"tags":{{json .RepoTags}},"created":{{json .Created}},"sha":{{json (index .Config.Labels "app.usebeeline.release.sha")}}}');
      return images.map(entry => JSON.stringify(entry)).join('\n') + '\n';
    }
    throw new Error('conflict: image is being used by a running container');
  });
  assert.deepEqual(calls.slice(-2), [
    ['docker', 'image', 'rm', 'registry.fly.io/beeline-server:0.1.241-rc.2-8a75d2ee5b27', 'registry.fly.io/beeline-free-agents:0.1.241-rc.1-a8dc3a6492d0', 'sha256:o3'],
    ['docker', 'image', 'prune', '-f'],
  ]);
});
test('dangling image pruning is attempted with no labelled images or failed inventory', () => {
  for (const failure of [null, 'images', 'inspect']) {
    const calls = [];
    const cleanup = () => removeStaleReleaseImages(sha, (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === failure || args[1] === failure) throw new Error('inventory unavailable');
      if (args[0] === 'images') return failure === 'inspect' ? 'sha256:old\n' : '';
      throw new Error('pruning unavailable');
    });
    if (failure) assert.throws(cleanup, /inventory unavailable/);
    else assert.doesNotThrow(cleanup);
    assert.deepEqual(calls.at(-1), ['docker', 'image', 'prune', '-f']);
  }
});

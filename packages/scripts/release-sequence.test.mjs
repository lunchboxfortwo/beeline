import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseSequence } from './release.mjs';

const sha = 'a'.repeat(40);
const spec = { source: '/source', sha, directory: '/state', store: true };
test('the ordinary nightly command runs full checks before delivery and records their result path in both channels', async () => {
  const calls = [], refreshed = [], audits = [];
  await releaseSequence(spec, async args => calls.push(args), source => refreshed.push(source), (...args) => audits.push(args));
  assert.deepEqual(calls.map(args => args.leg || args.channel), ['release_checks', 'next', 'latest']);
  assert.deepEqual(audits, [['/source', '/state/prompt-audit']]);
  assert.deepEqual(refreshed, ['/source']);
  assert.equal(calls[0]['release-sha'], sha);
  assert.equal(calls[0]['state-dir'], '/state/full-checks');
  assert.deepEqual(calls.slice(1).map(args => args['store-track']), ['none', 'production']);
  for (const args of calls.slice(1)) {
    assert.deepEqual(args.checks, { sourceSha: sha, result: 'success', resultsPath: '/state/full-checks/release-checks.json' });
    assert.equal(args['release-sha'], sha);
  }
});
test('a full-check failure prevents every release; each delivery failure stops subsequent channels', async () => {
  for (const failing of ['release_checks', 'next', 'latest']) {
    const calls = [];
    await assert.rejects(releaseSequence(spec, async args => {
      const leg = args.leg || args.channel;
      calls.push(leg);
      if (leg === failing) throw new Error('fixture failure');
    }, () => {}, () => {}), /fixture failure/);
    assert.deepEqual(calls, ['release_checks', 'next', 'latest'].slice(0, ['release_checks', 'next', 'latest'].indexOf(failing) + 1));
  }
});

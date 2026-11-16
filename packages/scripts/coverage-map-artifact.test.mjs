import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import { coverageMapReads, newestCoverageMap, trustedMapRun, zipText } from '../../apps/server/scripts/coverage-map-artifact.mjs';

const release = id => ({ id, event: 'workflow_dispatch', path: '.github/workflows/unified-release.yml', head_branch: 'main', head_sha: 'dispatch-head' });
const artifact = id => ({ id, workflow_run: { id } });
const map = (id, commit) => ({ commit, provenance: { kind: 'release', runId: String(id), commit } });

test('newest release map uses embedded release commit, even when dispatch head differs', async () => {
  const downloaded = [];
  const selected = await newestCoverageMap({ artifacts: [artifact(1), artifact(3), artifact(2)],
    run: release, download: a => { downloaded.push(a.id); return map(a.id, 'promoted-rc'); },
    usable: m => m.commit === 'promoted-rc' });
  assert.equal(selected.artifact.id, 3);
  assert.deepEqual(downloaded, [3]);
});

test('a stale release map does not download older releases', async () => {
  const downloaded = [];
  const checks = id => ({ id, event: 'workflow_dispatch', path: '.github/workflows/checks.yml', head_branch: 'topic', conclusion: 'success' });
  const selected = await newestCoverageMap({
    artifacts: [artifact(1), artifact(2), artifact(3), artifact(4), artifact(5), { ...artifact(6), expired: true }],
    base: 'main', head: 'topic',
    run: id => id === 5 ? { ...release(id), event: 'pull_request' } : id === 1 ? checks(id) : release(id),
    download: a => {
      downloaded.push(a.id);
      if (a.id === 4) return map(999, 'good');
      return map(a.id, a.id === 3 ? 'stale' : 'good');
    },
    usable: m => m.commit === 'good',
  });
  assert.equal(selected.artifact.id, 1);
  assert.deepEqual(downloaded, [4, 3, 1]);
  assert.equal(await newestCoverageMap({ artifacts: [], run: release }), undefined);
});

test('a preloaded run list answers every artifact without another read', async () => {
  let reads = 0;
  const selected = await newestCoverageMap({
    artifacts: [artifact(1), artifact(2), artifact(3)],
    runs: [release(3), { id: 2, event: 'pull_request', path: '.github/workflows/checks.yml', head_branch: 'topic' }],
    run: () => { reads += 1; throw new Error('uncached read'); },
    download: a => { assert.equal(a.id, 3); return map(a.id, 'promoted-rc'); },
    usable: m => m.commit === 'promoted-rc',
  });
  assert.equal(reads, 0);
  assert.equal(selected.artifact.id, 3);
  assert.deepEqual(coverageMapReads(), [
    'actions/runs?event=workflow_dispatch&per_page=100',
    'actions/artifacts?name=server-coverage-map&per_page=100&page=1',
  ]);
});

test('artifact zip text comes from the central directory', () => {
  const name = 'server-coverage-map.json';
  const text = '{"commit":"abc"}';
  const compressed = deflateRawSync(Buffer.from(text));
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x8, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(nameBuf.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt16LE(20, 4);
  directory.writeUInt16LE(20, 6);
  directory.writeUInt16LE(0x8, 8);
  directory.writeUInt16LE(8, 10);
  directory.writeUInt32LE(compressed.length, 20);
  directory.writeUInt32LE(Buffer.byteLength(text), 24);
  directory.writeUInt16LE(nameBuf.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + nameBuf.length, 12);
  end.writeUInt32LE(30 + nameBuf.length + compressed.length, 16);
  const zip = Buffer.concat([local, nameBuf, compressed, directory, nameBuf, end]);
  assert.equal(zipText(zip, name), text);
});

test('manual recovery maps require successful Checks on a PR base or head branch', () => {
  const run = { event: 'workflow_dispatch', path: '.github/workflows/checks.yml', head_branch: 'topic', conclusion: 'success' };
  assert.equal(trustedMapRun(run, { base: 'main', head: 'topic' }), true);
  assert.equal(trustedMapRun(run, { base: 'main', head: 'other' }), false);
  assert.equal(trustedMapRun({ ...run, conclusion: 'failure' }, { head: 'topic' }), false);
  assert.equal(trustedMapRun({ ...release(1), head_branch: 'untrusted' }, {}), false);
});

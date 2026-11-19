import assert from 'node:assert/strict';
import test from 'node:test';
import { carryHelperPlatform } from './helper-carry.mjs';
import { initializeRelease } from './unified-release.mjs';

const sha = 'a'.repeat(40), oldSha = 'b'.repeat(40);
const bundle = { commit: oldSha, version: 'v0.1.208', sha256: 'c'.repeat(64), verified: true };
test('three carries retain the exact byte identity; the fourth and uncounted legacy carries require a rebuild', () => {
  for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-x64']) {
    let carried = bundle;
    for (let releases = 1; releases <= 3; releases++) {
      carried = carryHelperPlatform(platform, carried);
      assert.deepEqual(carried.carriedFrom, { commit: oldSha, version: bundle.version, sha256: bundle.sha256, releases });
    }
    assert.throws(() => carryHelperPlatform(platform, carried), /more than 3 releases/);
    assert.throws(() => carryHelperPlatform(platform, { ...bundle, carriedFrom: { commit: oldSha } }), /count is unknown/);
    assert.equal(carryHelperPlatform(platform, bundle).carriedFrom.releases, 1);
  }
});
test('releases carrying the entire helper retain and advance platform counters', () => {
  let previous = initializeRelease({ version: 'v0.1.208', sourceSha: oldSha });
  previous.components.helper.platforms = { 'darwin-arm64': bundle };
  for (let releases = 1; releases <= 3; releases++) {
    const state = initializeRelease({ version: `v0.1.${208 + releases}`, sourceSha: sha, previous, selectedComponents: ['server'], freshIdentity: true });
    assert.equal(state.components.helper.platforms['darwin-arm64'].carriedFrom.releases, releases);
    previous = state;
  }
  assert.throws(() => initializeRelease({ version: 'v0.1.212', sourceSha: sha, previous, selectedComponents: ['server'], freshIdentity: true }), /more than 3 releases/);
});

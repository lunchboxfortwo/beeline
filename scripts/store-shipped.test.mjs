import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseMarker } from './store-shipped.mjs';

test('beta releases carry their rc version in the store marker', () => {
  const sha = '068d540767a1b2c3d4e5f60718293a4b5c6d7e8f';
  assert.equal(releaseMarker('v0.1.210-rc.1', sha), 'v0.1.210-rc.1@068d540767a1');
  assert.equal(releaseMarker('v0.1.210', sha), 'v0.1.210@068d540767a1');
  assert.throws(() => releaseMarker('', sha), /invalid release marker/);
});

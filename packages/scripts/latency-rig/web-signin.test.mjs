import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureSignIn } from './web-signin.mjs';

test('reusable sign-in retains credentials without priming surfaces or device settings', async () => {
  const names = [
    'buzzy.monolith.identity.v1',
    'buzzy.monolith.access.v1',
    'buzzy.monolith.refresh.v1',
  ];
  let closed = false;
  const state = {
    cookies: [],
    origins: [
      {
        origin: 'http://127.0.0.1',
        localStorage: [
          ...names,
          'beeline.surface.room',
          'beeline.outbox.room',
          '@beeline/community/active/viewer',
          'unrelated',
        ].map((name) => ({ name, value: 'fixture' })),
      },
    ],
  };
  const context = {
    newPage: async () => ({
      goto: async (url) => assert.equal(url, '/review/local-fixture'),
      waitForURL: async () => {},
      evaluate: async (_fn, allowed) => assert.deepEqual(allowed, names),
      close: async () => {
        closed = true;
      },
    }),
    storageState: async () => state,
  };
  const restored = await fixtureSignIn(context, 'local-fixture');
  assert.deepEqual(
    restored.origins[0].localStorage.map((item) => item.name),
    names,
  );
  assert.equal(closed, true);
});

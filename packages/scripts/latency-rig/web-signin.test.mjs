import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureContext, fixtureSignIn, saveReviewerSession } from './web-signin.mjs';

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

test('bootstrap saves one reviewer login for both inventories, then closes its context', async () => {
  const out = await mkdtemp(join(tmpdir(), 'latency-reviewer-session-'));
  const state = {
    cookies: [],
    origins: [
      {
        origin: 'http://127.0.0.1:18089',
        localStorage: [
          { name: 'buzzy.monolith.identity.v1', value: 'reviewer' },
          { name: 'buzzy.monolith.access.v1', value: 'local-access' },
          { name: 'buzzy.monolith.refresh.v1', value: 'local-refresh' },
          { name: 'beeline.surface.rooms', value: 'cached-rooms' },
        ],
      },
    ],
  };
  let redemptions = 0,
    closed = false;
  const browser = {
    newContext: async (options) => {
      assert.equal(options.storageState, undefined);
      return {
        route: async () => {},
        routeWebSocket: async () => {},
        unrouteAll: async ({ behavior }) => assert.equal(behavior, 'ignoreErrors'),
        storageState: async () => structuredClone(state),
        newPage: async () => ({
          goto: async (url) => {
            assert.equal(url, '/review/local-fixture');
            redemptions++;
          },
          waitForURL: async () => {},
          close: async () => {},
        }),
        close: async () => {
          closed = true;
        },
      };
    },
  };
  try {
    const path = await saveReviewerSession(browser, {
      origin: new URL(state.origins[0].origin),
      backend: new URL('http://127.0.0.1:18090'),
      secret: 'local-fixture',
      out,
      blockedRequests: [],
    });
    assert.equal(redemptions, 1);
    assert.equal(closed, true);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(
      saved.origins[0].localStorage.map(({ name }) => name),
      ['buzzy.monolith.identity.v1', 'buzzy.monolith.access.v1', 'buzzy.monolith.refresh.v1'],
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('routed requests are detached before context disposal', async () => {
  const events=[];
  const context=await fixtureContext({newContext:async()=>({
    route:async()=>{},routeWebSocket:async()=>{},
    unrouteAll:async options=>events.push(['unroute',options.behavior]),
    close:async()=>events.push(['close']),
  })},{origin:new URL('http://127.0.0.1:28089'),backend:new URL('http://127.0.0.1:28090'),blockedRequests:[]});
  await context.close();
  assert.deepEqual(events,[['unroute','ignoreErrors'],['close']]);
});

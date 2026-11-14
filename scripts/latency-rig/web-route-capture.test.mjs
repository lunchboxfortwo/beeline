import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureRoutes } from './web-route-capture.mjs';

test('route captures cannot inherit another route context and retain resource observations', async () => {
  const out = await mkdtemp(join(tmpdir(), 'route-isolation-'));
  const contexts = [];
  const browser = {
    async newContext() {
      const visits = [];
      const context = {
        storageState: async () => ({ cookies: [], origins: [] }),
        visits,
        closed: false,
        route: async () => {},
        routeWebSocket: async () => {},
        newCDPSession: async () => ({
          send: async (method) =>
            method === 'Performance.getMetrics'
              ? {
                  metrics: [
                    { name: 'JSHeapUsedSize', value: 1024 },
                    { name: 'TaskDuration', value: 0.1 },
                  ],
                }
              : {},
          detach: async () => {},
        }),
        async newPage() {
          const target = {
            filter() {
              return this;
            },
            first() {
              return this;
            },
            waitFor: async () => {},
          };
          return {
            setDefaultTimeout() {},
            setDefaultNavigationTimeout() {},
            goto: async (url) => visits.push(url),
            waitForURL: async () => {},
            locator: () => target,
            getByText: () => target,
            evaluate: async () => ({ startMs: 0, domMs: 90, frameMs: 100, durationMs: 100 }),
            addInitScript: async () => {},
            close: async () => {},
            screenshot: async () => {},
          };
        },
        async close() {
          this.closed = true;
        },
      };
      contexts.push(context);
      return context;
    },
  };
  try {
    await captureRoutes({
      browser,
      routes: [{ path: '/' }, { path: '/beeline/chat/[channelId]' }],
      origin: new URL('http://127.0.0.1:18089'),
      backend: new URL('http://127.0.0.1:18090'),
      secret: 'local-fixture',
      out,
      blockedRequests: [],
    });
    assert.equal(contexts.length, 24);
    for (const context of contexts) {
      assert.equal(context.closed, true);
      const destinations = context.visits.filter(
        (url) =>
          url !== '/__latency_blank.html' &&
          !url.startsWith('/review/') &&
          url !== '/beeline/channels',
      );
      assert.equal(new Set(destinations).size, 1);
      assert.ok([1, 2].includes(destinations.length));
    }
    const captures = JSON.parse(await readFile(join(out, 'route-captures.json')));
    assert.equal(captures.length, 8);
    for (const capture of captures) {
      assert.equal(capture.resources.length, capture.samples.length);
      assert.equal(capture.resources.length, 3);
      assert.deepEqual(capture.samples, [100, 100, 100]);
      assert.match(capture.cache.http, /disabled/);
      for (const { before, after } of capture.resources) {
        assert.equal(before.page.JSHeapUsedSize, 1024);
        assert.equal(after.page.TaskDuration, 0.1);
        assert.ok(after.host.totalMemoryBytes > 0);
      }
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('a warm page that misses its fixture is recorded and the sweep continues', async () => {
  const out = await mkdtemp(join(tmpdir(), 'route-warm-miss-'));
  const browser = {
    async newContext() {
      const visits = [];
      return {
        storageState: async () => ({ cookies: [], origins: [] }),
        route: async () => {},
        routeWebSocket: async () => {},
        newCDPSession: async () => ({
          send: async (method) =>
            method === 'Performance.getMetrics'
              ? {
                  metrics: [
                    { name: 'JSHeapUsedSize', value: 1024 },
                    { name: 'TaskDuration', value: 0.1 },
                  ],
                }
              : {},
          detach: async () => {},
        }),
        async newPage() {
          const target = {
            filter() {
              return this;
            },
            first() {
              return this;
            },
            async waitFor() {
              const last = visits.at(-1) ?? '';
              if (last.startsWith('/beeline/brief'))
                throw new Error('locator.waitFor: Timeout 5000ms exceeded');
            },
            async innerText() {
              return 'No messages yet';
            },
          };
          return {
            setDefaultTimeout() {},
            setDefaultNavigationTimeout() {},
            goto: async (url) => visits.push(url),
            waitForURL: async () => {},
            locator: () => target,
            getByText: () => target,
            evaluate: async () => ({ startMs: 0, domMs: 90, frameMs: 100, durationMs: 100 }),
            addInitScript: async () => {},
            close: async () => {},
            screenshot: async () => {},
          };
        },
        async close() {},
      };
    },
  };
  try {
    await captureRoutes({
      browser,
      routes: [{ path: '/' }, { path: '/beeline/brief' }, { path: '/beeline/agent-profile' }],
      origin: new URL('http://127.0.0.1:18089'),
      backend: new URL('http://127.0.0.1:18090'),
      secret: 'local-fixture',
      out,
      blockedRequests: [],
    });
    const captures = JSON.parse(await readFile(join(out, 'route-captures.json')));
    const briefWarm = captures.filter(
      (row) => row.path === '/beeline/brief' && row.variant === 'warm',
    );
    assert.equal(briefWarm.length, 2);
    for (const row of briefWarm) {
      assert.match(row.reason, /Timeout 5000ms/);
      assert.equal(row.samples.length, 0);
    }
    const profile = captures.filter((row) => row.path === '/beeline/agent-profile');
    assert.equal(profile.length, 4);
    for (const row of profile) {
      assert.equal(row.reason, undefined);
      assert.equal(row.samples.length, 3);
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

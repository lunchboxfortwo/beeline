import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { routeFixture, routeFixtures } from './web-route-fixtures.mjs';
test('every real route has an explicit visible content check and dynamic parameters', async () => {
  const routes = JSON.parse(await readFile(new URL('./routes.json', import.meta.url)));
  assert.deepEqual(Object.keys(routeFixtures).sort(), routes.map((r) => r.path).sort());
  for (const { path } of routes) {
    const f = routeFixture(path, 'local-secret');
    assert.ok(f.selector || f.text, path);
    assert.doesNotMatch(f.url, /\[(channelId|roomId|token|secret)\]/);
    assert.ok(f.state);
  }
  assert.throws(() => routeFixture('/future', 'local-secret'), /No web route fixture/);
});

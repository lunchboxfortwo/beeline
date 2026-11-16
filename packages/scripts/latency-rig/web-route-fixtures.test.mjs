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
test('empty-page predicates match the wording on screen', async () => {
  const brief = await readFile(
    new URL('../../../apps/mobile/sources/ui/screens/thread/BriefScreen.tsx', import.meta.url),
    'utf8',
  );
  const workflows = await readFile(
    new URL('../../../apps/mobile/sources/app/(app)/beeline/settings/workflows.tsx', import.meta.url),
    'utf8',
  );
  const previews = await readFile(
    new URL('../../../apps/mobile/sources/buzz/room-list-row.ts', import.meta.url),
    'utf8',
  );
  const briefText = brief.match(/>(This thread has no brief yet)</)[1];
  const workflowText = workflows.match(/>(No dispatchable workflows in this chat\.)</)[1];
  const emptyChat = previews.match(/NO_ACTIVITY_PREVIEW = '([^']+)'/)[1];
  assert.equal(routeFixtures['/beeline/brief'].text, briefText);
  assert.equal(routeFixtures['/beeline/settings/workflows'].text, workflowText);
  for (const path of [
    '/beeline/github-callback',
    '/beeline/google-callback',
    '/beeline/onboarding',
    '/buzz/github-callback',
    '/review/[secret]',
  ]) {
    assert.equal(routeFixtures[path].text, emptyChat);
    assert.match(routeFixtures[path].state, /-default-review-workspace$/);
  }
});
test('taps follow the controls on screen', async () => {
  const source = await readFile(new URL('./web-steps.mjs', import.meta.url), 'utf8');
  assert.match(source, /reaction-chip-\$\{f\.messageId\}-👍/);
  assert.match(source, /chat-name-save/);
  assert.match(source, /model-applies-model/);
  assert.match(source, /aria-label="Stop this turn"/);
  assert.doesNotMatch(source, /slash-verb-rename/);
  assert.doesNotMatch(source, /button\(p, 'Report'\)/);
  assert.doesNotMatch(source, /button\(p, 'Delete'\)/);
  assert.doesNotMatch(source, /button\(p, 'Leave'\)/);
  assert.doesNotMatch(source, /button\(p, 'Stop this turn'\)/);
  assert.doesNotMatch(source, /getByText\('Rig B'/);
});

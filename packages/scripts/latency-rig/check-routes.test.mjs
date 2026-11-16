import test from 'node:test';
import assert from 'node:assert/strict';
import { routeForFile, checkRoutes } from './check-routes.mjs';

test('route discovery skips extracted hooks and support modules but retains new screens', async () => {
  for (const name of [
    'useChatHeader.tsx',
    'test-support-channels.test-support.tsx',
    'chat-surface-values.tsx',
    'ChatSurfaceHeader.tsx',
    '_layout.tsx',
    'foo.test.tsx',
  ]) {
    assert.equal(routeForFile(`(app)/beeline/chat/${name}`), null, name);
  }
  assert.equal(routeForFile('(app)/beeline/browser-share.tsx'), '/beeline/browser-share');
  assert.equal(routeForFile('(app)/beeline/google-callback.tsx'), '/beeline/google-callback');
  assert.equal(routeForFile('(app)/beeline/settings/index.tsx'), '/beeline/settings');
  await assert.rejects(
    checkRoutes(['(app)/beeline/new-screen.tsx'], []),
    /missing=\/beeline\/new-screen/,
  );
});

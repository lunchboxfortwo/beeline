import { afterEach, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => ({ load: vi.fn(), captureMobileError: vi.fn(), setMobileErrorRoute: vi.fn() }));
vi.mock('./sentry', () => { sdk.load(); return sdk; });
vi.mock('./web-chunk-recovery', () => ({ installWebChunkRecovery: vi.fn(), recoverWebChunk: () => false }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); vi.resetModules(); });

it('keeps the reporting SDK outside a healthy web launch and captures the first early error', async () => {
  const window = new EventTarget();
  vi.stubGlobal('window', window);
  vi.stubGlobal('__DEV__', false);
  vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN', 'https://public@fixture.ingest.sentry.io/1');
  const capture = await import('./sentry-entry.web');
  capture.setMobileErrorRoute(['beeline', 'chat', '[channelId]']);
  await Promise.resolve();
  expect(sdk.load).not.toHaveBeenCalled();
  const cause = new Error('early render failure');
  window.dispatchEvent(Object.assign(new Event('error'), { error: cause }));
  capture.setMobileErrorRoute(['beeline', 'settings']);
  await vi.waitFor(() => expect(sdk.captureMobileError).toHaveBeenCalledWith('app', cause));
  expect(sdk.load).toHaveBeenCalledOnce();
  expect(sdk.setMobileErrorRoute).toHaveBeenCalledWith(['beeline', 'chat', '[channelId]']);
  expect(sdk.setMobileErrorRoute).toHaveBeenLastCalledWith(['beeline', 'settings']);
  capture.captureMobileError('conversation', new Error('later failure'));
  await vi.waitFor(() => expect(sdk.captureMobileError).toHaveBeenCalledTimes(2));
  expect(sdk.load).toHaveBeenCalledOnce();
});

it('retains a rejected promise while the reporting SDK loads', async () => {
  const window = new EventTarget();
  vi.stubGlobal('window', window); vi.stubGlobal('__DEV__', false);
  vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN', 'https://public@fixture.ingest.sentry.io/1');
  await import('./sentry-entry.web');
  const cause = new Error('early rejection');
  window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: cause }));
  await vi.waitFor(() => expect(sdk.captureMobileError).toHaveBeenCalledWith('app', cause));
});

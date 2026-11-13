import { afterEach, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => ({ load: vi.fn(), captureMobileError: vi.fn(), setMobileErrorRoute: vi.fn(), setMobileErrorUser: vi.fn() }));
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
  capture.setMobileErrorUser('a'.repeat(64));
  await Promise.resolve();
  expect(sdk.load).not.toHaveBeenCalled();
  const cause = new Error('early render failure');
  window.dispatchEvent(Object.assign(new Event('error'), { error: cause }));
  capture.setMobileErrorRoute(['beeline', 'settings']);
  await vi.waitFor(() => expect(sdk.captureMobileError).toHaveBeenCalledWith('app', cause));
  expect(sdk.load).toHaveBeenCalledOnce();
  expect(sdk.setMobileErrorRoute).toHaveBeenCalledWith(['beeline', 'chat', '[channelId]']);
  expect(sdk.setMobileErrorRoute).toHaveBeenLastCalledWith(['beeline', 'settings']);
  // The signed-in identity set before the SDK loaded reaches the first early error.
  expect(sdk.setMobileErrorUser).toHaveBeenCalledWith('a'.repeat(64));
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

it.each([['account switch', 'b'.repeat(64)], ['sign-out', null]])(
  'reports an error captured while loading as its own account after %s', async (_case, next) => {
    const window = new EventTarget();
    vi.stubGlobal('window', window); vi.stubGlobal('__DEV__', false);
    vi.stubEnv('EXPO_PUBLIC_SENTRY_DSN', 'https://public@fixture.ingest.sentry.io/1');
    let active: string | null = null;
    const owners: (string | null)[] = [];
    sdk.setMobileErrorUser.mockImplementation((id: string | null) => { active = id; });
    sdk.captureMobileError.mockImplementation(() => { owners.push(active); });
    const capture = await import('./sentry-entry.web');
    capture.setMobileErrorUser('a'.repeat(64));
    capture.captureMobileError('conversation', new Error('first account failure'));
    capture.setMobileErrorUser(next);
    await vi.waitFor(() => expect(sdk.captureMobileError).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(owners).toEqual(['a'.repeat(64)]);
    expect(active).toBe(next);
  });

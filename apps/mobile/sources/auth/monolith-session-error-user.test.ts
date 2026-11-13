import { expect, it, vi } from 'vitest';
const sentry = vi.hoisted(() => ({ setMobileErrorUser: vi.fn() }));
vi.mock('@/buzz/sentry', () => sentry);
vi.mock('@/track/diagnostics', () => ({ authDiagnostic: vi.fn(), diagnosticIdentity: vi.fn() }));
vi.mock('./signin-funnel', () => ({ funnelSignedIn: vi.fn(), beginFunnelAttempt: vi.fn(async () => undefined), funnelCallback: vi.fn() }));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://fixture.invalid' }) }));
vi.mock('@/auth/monolith-secure-storage', () => ({ monolithSecureStorage: async () => ({}) }));
vi.mock('@/utils/web-storage', () => ({ webRuntimeStorage: () => undefined }));
vi.mock('@/sync/client-reset', () => ({ resetClientState: vi.fn() }));
import { MonolithSession } from './monolith-session';

it('sign-in names the identity on phone error reports and sign-out clears it', async () => {
  const identityId = 'a'.repeat(64);
  const values = new Map<string, string>();
  const storage = {
    getItemAsync: async (key: string) => values.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { values.set(key, value); },
    deleteItemAsync: async (key: string) => { values.delete(key); },
  };
  const session = new MonolithSession('https://fixture.invalid', async (url) => String(url).endsWith('/v1/auth/logout')
    ? new Response(null, { status: 204 })
    : new Response(JSON.stringify({ accessToken: 'access', refreshToken: 'refresh', identityId, accessExpiresAt: Date.now() + 600_000 })),
  async () => storage);
  await session.exchangeGoogleTicket('ticket');
  await vi.waitFor(() => expect(sentry.setMobileErrorUser).toHaveBeenLastCalledWith(identityId));
  await session.signOut();
  await vi.waitFor(() => expect(sentry.setMobileErrorUser).toHaveBeenLastCalledWith(null));
  expect(new Set(sentry.setMobileErrorUser.mock.calls.map(([id]) => id))).toEqual(new Set([identityId, null]));
});

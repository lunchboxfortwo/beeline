import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { app, alphaTenant, betaTenant, database, provider, startCookie, store, useAuthServerFixture } from '../../../packages/test-helpers/helpers/server.js';

useAuthServerFixture();

const recoveryToken = 'r'.repeat(43);
const recoveryHash = createHash('sha256').update(recoveryToken).digest('hex');
const appState = 's'.repeat(43);

async function start() {
  const query = new URLSearchParams({
    app_redirect: 'https://web.alpha.example/beeline/google-callback',
    app_state: appState,
    app_recovery_challenge: recoveryHash,
  });
  const response = await app.inject({ method: 'GET', url: `/auth/oidc/start?${query}`, headers: { host: alphaTenant.host } });
  expect(response.statusCode).toBe(302);
  expect(String(response.headers['set-cookie'])).toContain('Max-Age=900; Secure; HttpOnly; SameSite=Lax');
  const authorization = await fetch(response.headers.location!, { redirect: 'manual' });
  const callback = new URL(authorization.headers.get('location')!);
  return { url: callback.pathname + callback.search, cookie: startCookie(response.headers['set-cookie']) };
}

async function callback(url: string, cookie?: string, host = alphaTenant.host) {
  return app.inject({ method: 'GET', url, headers: { host, ...(cookie ? { cookie } : {}) } });
}

function expectRestart(response: Awaited<ReturnType<typeof callback>>) {
  expect(response.statusCode).toBe(302);
  expect(response.headers.location).toBe('https://web.alpha.example/beeline/onboarding');
  expect(response.headers['cache-control']).toContain('no-store');
  expect(response.body).not.toContain('invalid_oidc');
  expect(response.headers.location).not.toMatch(/state|code|ticket|error|message/);
}

describe('Google browser callback recovery', () => {
  it('reproduces the 29-minute canceled return with the expired browser cookie missing', async () => {
    const flow = await start();
    const cancel = await app.inject({ method: 'POST', url: '/auth/oidc/completion/cancel', headers: { host: alphaTenant.host }, payload: { recoveryToken } });
    expect(cancel.statusCode).toBe(204);
    expect(cancel.headers['set-cookie']).toBeUndefined();
    // Expire the stored flow as well as omitting the cookie a browser drops at fifteen minutes.
    await database.query("UPDATE beeline_oidc_flows SET created_at = created_at - interval '29 minutes', expires_at = expires_at - interval '29 minutes'");
    expectRestart(await callback(flow.url));
    expect(provider.tokenRequests).toBe(0);
    expect(await store.findTicket(recoveryHash)).toBeNull();
  });

  it.each(['missing', 'malformed', 'duplicate', 'wrong'])('returns a %s browser session to sign-in without consuming a valid flow', async kind => {
    const flow = await start();
    const name = flow.cookie.split('=')[0];
    const cookie = kind === 'missing' ? undefined : kind === 'malformed' ? `${name}=bad` : kind === 'duplicate' ? `${flow.cookie}; ${flow.cookie}` : `${name}=${'x'.repeat(43)}`;
    expectRestart(await callback(flow.url, cookie));
    expect(provider.tokenRequests).toBe(0);
    const completed = await callback(flow.url, flow.cookie);
    expect(completed.statusCode).toBe(302);
    const target = new URL(completed.headers.location!);
    expect(target.origin + target.pathname).toBe('https://web.alpha.example/beeline/google-callback');
    expect(target.searchParams.get('state')).toBe(appState);
    expect(target.searchParams.get('completed')).toBe('1');
    expect(await store.findTicket(recoveryHash)).not.toBeNull();
    expect(provider.tokenRequests).toBe(1);
  });

  it('completes a still-valid approval three minutes into the flow', async () => {
    const flow = await start();
    await database.query("UPDATE beeline_oidc_flows SET created_at = created_at - interval '3 minutes', expires_at = expires_at - interval '3 minutes'");
    const response = await callback(flow.url, flow.cookie);
    expect(response.statusCode).toBe(302);
    expect(new URL(response.headers.location!).searchParams.get('completed')).toBe('1');
    expect(await store.findTicket(recoveryHash)).not.toBeNull();
    expect(provider.tokenRequests).toBe(1);
  });

  it.each(['missing-code', 'denied', 'invalid-code', 'invalid-proof'])('returns a browser-only %s failure to sign-in', async kind => {
    const response = await app.inject({ method: 'GET', url: '/auth/oidc/start', headers: { host: alphaTenant.host } });
    const authorization = await fetch(response.headers.location!, { redirect: 'manual' });
    const target = new URL(authorization.headers.get('location')!);
    if (kind === 'missing-code') target.searchParams.delete('code');
    if (kind === 'denied') { target.searchParams.delete('code'); target.searchParams.set('error', 'access_denied'); }
    if (kind === 'invalid-code') target.searchParams.set('code', 'invalid');
    if (kind === 'invalid-proof') provider.claims.issuer = 'https://wrong-issuer.example';
    expectRestart(await callback(target.pathname + target.search, startCookie(response.headers['set-cookie'])));
    expect((await database.query('SELECT * FROM beeline_bind_tickets')).rows).toHaveLength(0);
  });

  it.each(['expired', 'cancelled', 'replayed', 'tenant-mismatch'])('returns a %s flow to sign-in without issuing another ticket', async kind => {
    const flow = await start();
    if (kind === 'expired') await database.query("UPDATE beeline_oidc_flows SET expires_at = NOW() - interval '1 second'");
    if (kind === 'cancelled') await store.cancelRecoveryTicket(recoveryHash, new Date());
    if (kind === 'replayed') expect((await callback(flow.url, flow.cookie)).statusCode).toBe(302);
    const requests = provider.tokenRequests;
    expectRestart(await callback(flow.url, flow.cookie, kind === 'tenant-mismatch' ? betaTenant.host : alphaTenant.host));
    expect(provider.tokenRequests).toBe(requests);
    if (kind !== 'replayed') expect(await store.findTicket(recoveryHash)).toBeNull();
  });

  it.each(['', '?state=x', '?state=x&state=y&code=z'])('returns an incomplete callback %s to sign-in', async query => {
    expectRestart(await callback(`/auth/oidc/callback${query}`));
    expect(provider.tokenRequests).toBe(0);
  });

  it('keeps database failures visible to server error handling', async () => {
    const flow = await start();
    const consume = vi.spyOn(store, 'consumeFlow').mockRejectedValueOnce(new Error('database unavailable'));
    try { expect((await callback(flow.url, flow.cookie)).statusCode).toBe(500); }
    finally { consume.mockRestore(); }
  });
});

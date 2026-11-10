import { describe, expect, it, vi } from 'vitest';
import { app, alphaTenant, database, startCookie, useAuthServerFixture } from '../../../tests/helpers/server.js';

useAuthServerFixture();

async function start() {
  const response = await app.inject({ method: 'GET', url: '/auth/github/start', headers: { host: alphaTenant.host } });
  expect(response.statusCode).toBe(302);
  const state = new URL(response.headers.location!).searchParams.get('state')!;
  return { response, state, url: `/auth/github/callback?state=${state}&code=github-code`, cookie: startCookie(response.headers['set-cookie']) };
}

async function callback(url: string, cookie?: string) {
  return app.inject({ method: 'GET', url, headers: { host: alphaTenant.host, ...(cookie ? { cookie } : {}) } });
}

function expectRestart(response: Awaited<ReturnType<typeof callback>>) {
  expect(response.statusCode).toBe(302);
  expect(response.headers.location).toBe('https://web.alpha.example/beeline/onboarding');
  expect(response.headers['cache-control']).toContain('no-store');
  expect(response.body).toBe('');
  expect(String(response.headers['content-type'])).not.toContain('application/json');
}

describe('GitHub browser callback recovery', () => {
  it('R1: restarts sign-in after a slow GitHub Mobile 2FA return drops the old five-minute cookie', async () => {
    const flow = await start();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    try { expectRestart(await callback(flow.url)); }
    finally { vi.useRealTimers(); }
    expect((await database.query('SELECT * FROM beeline_bind_tickets')).rows).toHaveLength(0);
  });

  it.each(['missing', 'malformed', 'duplicate', 'wrong'])('restarts a %s cookie without consuming the valid flow', async kind => {
    const flow = await start();
    const name = flow.cookie.split('=')[0];
    const cookie = kind === 'missing' ? undefined : kind === 'malformed' ? `${name}=bad` : kind === 'duplicate' ? `${flow.cookie}; ${flow.cookie}` : `${name}=${'x'.repeat(43)}`;
    expectRestart(await callback(flow.url, cookie));
    expect((await callback(flow.url, flow.cookie)).statusCode).toBe(200);
  });

  it.each(['unknown', 'expired', 'used'])('restarts an %s flow without issuing another ticket', async kind => {
    const flow = await start();
    if (kind === 'expired') await database.query("UPDATE beeline_oidc_flows SET expires_at = NOW() - interval '1 second'");
    if (kind === 'used') expect((await callback(flow.url, flow.cookie)).statusCode).toBe(200);
    const tickets = (await database.query('SELECT * FROM beeline_bind_tickets')).rows.length;
    expectRestart(await callback(kind === 'unknown' ? '/auth/github/callback?state=unknown&code=github-code' : flow.url, flow.cookie));
    expect((await database.query('SELECT * FROM beeline_bind_tickets')).rows).toHaveLength(tickets);
  });

  it('keeps the cookie and stored flow valid for fifteen minutes and completes at minute fourteen', async () => {
    const flow = await start();
    expect(String(flow.response.headers['set-cookie'])).toContain('Max-Age=900; Secure; HttpOnly; SameSite=Lax');
    const rows = await database.query('SELECT EXTRACT(EPOCH FROM (expires_at - created_at)) AS ttl FROM beeline_oidc_flows');
    expect(Number(rows.rows[0]!.ttl)).toBe(900);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 14 * 60_000);
    try {
      const response = await callback(flow.url, flow.cookie);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ provider: 'https://github.com', subject: '123' });
    } finally { vi.useRealTimers(); }
  });
});

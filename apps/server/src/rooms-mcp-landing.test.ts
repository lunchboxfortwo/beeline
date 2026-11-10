import {
  describe,
  expect,
  it,
  phoneFetch,
  opaque,
  tokenHash,
  fixtureScope1,
} from './test-support-rooms-mcp.test-support.js';
import { renderMcpWorkspaceLanding } from './rooms-mcp-landing.js';

describe('New Workspace connector landing', () => {
  const scope = fixtureScope1();
  async function allowNew() {
    const redirect = scope.origin + '/mcp/oauth/handoff';
    const registered = await scope.post('/mcp/oauth/register', {
      client_name: 'Codex',
      redirect_uris: [redirect],
    });
    const { client_id } = (await registered.json()) as { client_id: string };
    const prepared = await scope.prepareAuthorization(
      undefined,
      client_id,
      redirect,
      'local-new-' + opaque(),
    );
    const state = opaque();
    await scope.db.query('UPDATE rooms_mcp_flows SET state=$2 WHERE id=$1', [prepared.flow, state]);
    const allowed = await scope.post(
      '/mcp/oauth/consent',
      { flow: prepared.flow, decision: 'allow', workspace_selection: '1' },
      { cookie: prepared.cookie, origin: scope.origin },
    );
    expect(allowed.status).toBe(302);
    return { ...prepared, state, redirect, target: new URL(allowed.headers.get('location')!) };
  }
  it('opens the created #general, offers installation and keeps the one-shot PKCE handoff', async () => {
    const grant = await allowNew();
    const code = grant.target.searchParams.get('code')!;
    const context = (
      await scope.db.query<{ workspace_id: string; room_id: string }>(
        'SELECT workspace_id,room_id FROM rooms_mcp_workspace_landings WHERE code_hash=$1',
        [tokenHash(code)],
      )
    ).rows[0]!;
    const landed = await phoneFetch(grant.target, {
      headers: { cookie: grant.cookie, 'user-agent': 'iPhone' },
    });
    const html = await landed.text();
    expect(html.includes('Your team is ready')).toBe(true);
    expect(html.includes('Robin&#39;s team · you and Codex')).toBe(true);
    expect(
      html.includes(
        `https://web.usebeeline.app/beeline/chat/${context.room_id}?communityId=${context.workspace_id}`,
      ),
    ).toBe(true);
    expect(html.includes('https://apps.apple.com/app/id6803948500')).toBe(true);
    expect(html.includes('It finishes joining by itself.')).toBe(true);
    expect(landed.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(landed.headers.get('content-security-policy')).not.toContain('script-src');
    expect(await (await scope.post('/mcp/oauth/handoff', { state: grant.state })).json()).toEqual({
      code,
    });
    expect(await (await scope.post('/mcp/oauth/handoff', { state: grant.state })).json()).toEqual({
      error: 'authorization_pending',
    });
    const token = await scope.post('/mcp/oauth/token', {
      grant_type: 'authorization_code',
      client_id: grant.clientId,
      code,
      code_verifier: grant.verifier,
      redirect_uri: grant.redirect,
      resource: scope.origin + '/mcp',
    });
    expect(token.status).toBe(200);
    const refreshed = await phoneFetch(grant.target, { headers: { cookie: grant.cookie } });
    expect((await refreshed.text()).includes('Open #general on the web')).toBe(true);
  });
  it('never exposes first-run context to another browser or trusts query-supplied room/text', async () => {
    const grant = await allowNew();
    grant.target.searchParams.set('room_id', 'foreign-room');
    grant.target.searchParams.set('workspace_name', '<script>evil()</script>');
    const html = await (await phoneFetch(grant.target)).text();
    expect(html.includes('Your team is ready')).toBe(false);
    expect(html.includes('Go back to your session')).toBe(true);
    expect(html.includes('foreign-room')).toBe(false);
    expect(html.includes('evil()')).toBe(false);
  });
  it('expires presentation context without changing the Connected result', async () => {
    const grant = await allowNew();
    await scope.db.query(
      `UPDATE rooms_mcp_workspace_landings SET expires_at=now()-interval '1 second' WHERE code_hash=$1`,
      [tokenHash(grant.target.searchParams.get('code')!)],
    );
    const html = await (
      await phoneFetch(grant.target, { headers: { cookie: grant.cookie } })
    ).text();
    expect(html.includes('Your team is ready')).toBe(false);
    expect(html.includes('Go back to your session')).toBe(true);
  });
  it('keeps existing-account connection and denial pages unchanged', async () => {
    const grant = await scope.authorize();
    expect(
      (
        await scope.db.query('SELECT 1 FROM rooms_mcp_workspace_landings WHERE code_hash=$1', [
          tokenHash(grant.code!),
        ])
      ).rowCount,
    ).toBe(0);
    const html = await (
      await phoneFetch(
        scope.origin + '/mcp/oauth/handoff?state=' + opaque() + '&error=access_denied',
      )
    ).text();
    expect(html.includes('Not connected')).toBe(true);
    expect(html.includes('Open #general')).toBe(false);
  });
});

describe('Device install offers and safe landing text', () => {
  const landing = {
    room_id: 'room',
    workspace_id: 'workspace',
    workspace_name: '<script>bad()</script>',
    client_name: '<img src=x onerror=bad()>',
  };
  it.each([
    ['iPhone', 'apps.apple.com'],
    ['Macintosh Mobile/15 Safari', 'apps.apple.com'],
    ['Android', 'play.google.com'],
    ['Macintosh', 'Beeline-universal.dmg'],
    ['Windows NT', 'Beeline-x86_64-setup.exe'],
    ['X11 Linux', 'Beeline-x86_64.AppImage'],
    ['', 'https://usebeeline.app/#download'],
  ])('offers the right destination for %s', (ua, destination) => {
    const html = renderMcpWorkspaceLanding(landing, ua);
    expect(html.includes(destination)).toBe(true);
    expect(html.includes('<script>')).toBe(false);
    expect(html.includes('<img src=x')).toBe(false);
    expect(html.includes('&lt;script&gt;')).toBe(true);
    expect(html.includes('Example Beeline conversation')).toBe(true);
  });
});

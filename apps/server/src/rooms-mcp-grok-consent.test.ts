import { describe, expect, fixtureScope1, it, USER, OTHER, WORKSPACE, vi, openSecrets, deliverMcpMemberWebhooks } from './test-support-rooms-mcp.test-support.js';

describe('Grok Bot webhook consent', () => {
  const scope = fixtureScope1();
  const redirect = 'https://www.cursor.com/agents/mcp/oauth/callback';

  async function prepare(name = 'Cursor', callback = redirect) {
    const registered = await scope.post('/mcp/oauth/register', { client_name: name, redirect_uris: [callback] });
    const { client_id } = await registered.json() as { client_id: string };
    return scope.prepareAuthorization(undefined, client_id, callback);
  }

  function submit(flow: string, cookie: string, extra: Record<string, unknown> = {}) {
    return scope.post('/mcp/oauth/consent', {
      flow, decision: 'allow', workspace_selection: '1', workspace_ids: [WORKSPACE], ...extra,
    }, { cookie, origin: scope.origin });
  }

  it('refuses missing or blank webhook URLs before creating a member or authorization code', async () => {
    const { flow, cookie, clientId } = await prepare();
    for (const wake of [{}, { wake_url: '' }, { wake_url: '   ' }, { wake_key: 'receiver-token' }]) {
      const response = await submit(flow, cookie, wake);
      expect(response.status).toBe(400);
      expect(response.headers.get('location')).toBeNull();
      expect(await response.text()).toContain('This agent needs a host webhook URL before it can join Beeline.');
      expect((await scope.db.query('SELECT 1 FROM rooms_mcp_members WHERE client_id=$1', [clientId])).rowCount).toBe(0);
      expect((await scope.db.query('SELECT 1 FROM rooms_mcp_codes WHERE client_id=$1', [clientId])).rowCount).toBe(0);
      expect((await scope.db.query('SELECT 1 FROM rooms_mcp_flows WHERE id=$1', [flow])).rowCount).toBe(1);
    }
    for (const wake_url of ['http://localhost', 'https://127.0.0.1/hook', 'https://hooks.example/wake#fragment']) {
      expect((await submit(flow, cookie, { wake_url })).status).toBe(400);
      expect((await scope.db.query('SELECT 1 FROM rooms_mcp_members WHERE client_id=$1', [clientId])).rowCount).toBe(0);
    }
    const response = await submit(flow, cookie, { wake_url: 'https://hooks.example/grok' });
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('location')!).searchParams.get('code')).toBeTruthy();
    expect((await scope.db.query('SELECT callback_url,callback_secret FROM rooms_mcp_members WHERE client_id=$1', [clientId])).rows)
      .toEqual([{ callback_url: 'https://hooks.example/grok', callback_secret: null }]);
  });

  it('requires the URL in the form and permits Cancel without completing required fields', async () => {
    const { flow, cookie, consentHtml, clientId } = await prepare();
    expect(consentHtml).toMatch(/<input id="wake_url"[^>]* required/);
    expect(consentHtml).toContain('Live replies · host webhook URL (required)');
    expect(consentHtml).not.toContain('Blank fields leave live replies unfinished');
    expect(consentHtml).toMatch(/<button[^>]*value="deny"[^>]*formnovalidate/);
    expect((await submit(flow, cookie, { decision: 'deny' })).status).toBe(302);
    expect((await scope.db.query('SELECT 1 FROM rooms_mcp_members WHERE client_id=$1', [clientId])).rowCount).toBe(0);
  });

  it('preserves an existing member and its webhook when reconnect is refused', async () => {
    const first = await prepare();
    expect((await submit(first.flow, first.cookie, { wake_url: 'https://hooks.example/grok' })).status).toBe(302);
    const next = await scope.prepareAuthorization(undefined, first.clientId, redirect);
    expect((await submit(next.flow, next.cookie)).status).toBe(400);
    expect((await scope.db.query('SELECT callback_url FROM rooms_mcp_members WHERE client_id=$1 AND owner_id=$2', [first.clientId, USER])).rows)
      .toEqual([{ callback_url: 'https://hooks.example/grok' }]);
  });

  it.each([
    ['Cursor', 'https://cursor.com/mcp/callback'],
    ['Grok Bot', 'http://127.0.0.1:9876/callback'],
  ])('also requires the webhook for %s through %s', async (name, callback) => {
    const { flow, cookie, consentHtml } = await prepare(name, callback);
    expect(consentHtml).toMatch(/<input id="wake_url"[^>]* required/);
    expect((await submit(flow, cookie)).status).toBe(400);
    expect((await submit(flow, cookie, { wake_url: 'https://hooks.example/receiver' })).status).toBe(302);
  });

  it('requires Cursor automation credentials and a host receipt after OAuth, never HTTP acceptance alone', async () => {
    vi.stubEnv('BEELINE_MCP_WEBHOOK_KEY', 'local-cursor-sealing-key');
    const prepared = await prepare();
    const wake_url = 'https://api2.cursor.sh/automations/webhook/fixture-receiver';
    expect((await submit(prepared.flow, prepared.cookie, { wake_url })).status).toBe(400);
    expect((await scope.db.query('SELECT 1 FROM rooms_mcp_members WHERE client_id=$1', [prepared.clientId])).rowCount).toBe(0);
    const accepted = await submit(prepared.flow, prepared.cookie, { wake_url, wake_key: 'Bearer local-receiver-token' });
    expect(accepted.status).toBe(302);
    const exchanged = await scope.exchange({ ...prepared,
      code: new URL(accepted.headers.get('location')!).searchParams.get('code'), error: null,
    }, { redirect_uri: redirect });
    expect(exchanged.status).toBe(200);
    const { access_token } = await exchanged.json() as { access_token: string };
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await scope.eventCall(access_token, 'tools/call', { name, arguments: args });
      return result.result;
    };
    expect(scope.data(await tool('list_chats')).delivery.state).toBe('setup_unfinished');
    expect((await tool('setup_delivery', { mechanism: 'on_demand', host: 'no receiver', surface: 'web', conversation: 'bot-thread' })).isError).toBe(true);
    const setup = await tool('setup_delivery', { mechanism: 'webhook', host: 'Cursor', surface: 'automation', conversation: 'bot-thread' });
    expect(scope.data(setup).delivery.state).toBe('setup_unfinished');
    expect(JSON.stringify(setup)).not.toContain('local-receiver-token');
    let receipt: Record<string, unknown> | undefined;
    await deliverMcpMemberWebhooks(scope.db, async (url, init) => {
      expect(url).toBe(wake_url);
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer local-receiver-token');
      receipt = JSON.parse(init.body).receipt;
      return new Response(null, { status: 204 });
    });
    expect(scope.data(await tool('list_chats')).delivery.state).toBe('setup_unfinished');
    expect(receipt).toBeDefined();
    expect(scope.data(await tool('confirm_delivery', receipt!)).delivery.state).toBe('proved_ready');
  });

  it('repairs a preexisting Grok Bot through the existing owner-only updateAgentWake operation', async () => {
    vi.stubEnv('BEELINE_MCP_WEBHOOK_KEY', 'local-owner-sealing-key');
    const { member, grant } = await scope.connected();
    await scope.db.query('UPDATE rooms_mcp_clients SET name=$2,redirects=$3::jsonb WHERE id=$1',
      [grant.clientId, 'Cursor', JSON.stringify([redirect])]);
    const input = { workspaceId: WORKSPACE, agentId: member,
      url: 'https://api2.cursor.sh/automations/webhook/fixture-receiver', key: 'Bearer local-owner-token' };
    await expect(scope.phone.execute('updateAgentWake', input, OTHER)).rejects.toThrow();
    await expect(scope.phone.execute('updateAgentWake', { ...input, key: undefined }, USER)).rejects.toThrow('Cursor automation webhooks require their auth token');
    const repaired = await scope.phone.execute('updateAgentWake', input, USER);
    expect(repaired.wake).toEqual({ url: input.url, keySet: true });
    expect(JSON.stringify(repaired)).not.toContain('local-owner-token');
    const stored = (await scope.db.query<{ callback_secret: string }>('SELECT callback_secret FROM rooms_mcp_members WHERE member_id=$1', [member])).rows[0]!;
    expect(openSecrets<string>('local-owner-sealing-key', stored.callback_secret)).toBe('local-owner-token');
  });

  it.each([
    ['Codex', 'http://127.0.0.1:9876/callback'],
    ['Grok', 'http://127.0.0.1:9876/callback'],
    ['Cursor', 'cursor://anysphere.cursor-mcp/oauth/callback'],
  ])('keeps webhook setup optional for %s', async (name, callback) => {
    const { flow, cookie, consentHtml } = await prepare(name, callback);
    expect(consentHtml).not.toMatch(/<input id="wake_url"[^>]* required/);
    expect(consentHtml).toContain('Blank fields leave live replies unfinished');
    expect((await submit(flow, cookie)).status).toBe(302);
  });
});

describe('Join completion follows the host receiver', () => {
  const scope = fixtureScope1();
  const binding = { mechanism: 'on_demand', host: 'claimed host', surface: 'claimed surface', conversation: 'current-thread' };

  it.each(['Codex', 'Claude Code', 'Antigravity', 'Cursor', 'Grok Bot'])('%s cannot skip its receiver with an on-demand binding', async name => {
    const { client, grant } = await scope.connected();
    const callback = name === 'Antigravity' ? 'https://server.usebeeline.app/mcp/oauth/handoff'
      : name === 'Cursor' ? 'https://cursor.com/mcp/callback' : 'http://localhost:8787/callback';
    await scope.db.query('UPDATE rooms_mcp_clients SET name=$2,redirects=$3::jsonb WHERE id=$1',
      [grant.clientId, name, JSON.stringify([callback])]);
    const refused = await client.callTool({ name: 'setup_delivery', arguments: binding });
    expect(refused.isError).toBe(true);
    expect(scope.data(await client.callTool({ name: 'list_chats', arguments: {} })).delivery.state).toBe('setup_unfinished');
  });

  it.each(['Pi', 'OpenCode', 'Hermes', 'ZCode', 'Gemini', 'Grok', 'Muse', 'Claude Duet'])('%s without an automatic receiver may finish on demand', async name => {
    const { client, grant } = await scope.connected();
    await scope.db.query('UPDATE rooms_mcp_clients SET name=$2,redirects=$3::jsonb WHERE id=$1',
      [grant.clientId, name, JSON.stringify(['http://localhost:8787/callback'])]);
    const result = await client.callTool({ name: 'setup_delivery', arguments: binding });
    expect(result.isError).not.toBe(true);
    expect(scope.data(result).delivery).toMatchObject({ state: 'host_without_live_delivery', offline: false });
  });

  it('keeps native Cursor editor connections on demand when no receiver is configured', async () => {
    const { client, grant } = await scope.connected();
    await scope.db.query('UPDATE rooms_mcp_clients SET name=$2,redirects=$3::jsonb WHERE id=$1',
      [grant.clientId, 'Cursor', JSON.stringify(['cursor://anysphere.cursor-mcp/oauth/callback', 'https://cursor.com/mcp/callback'])]);
    const result = await client.callTool({ name: 'setup_delivery', arguments: binding });
    expect(result.isError).not.toBe(true);
    expect(scope.data(result).delivery).toMatchObject({ state: 'host_without_live_delivery', offline: false });
  });

  it('does not accept on-demand completion for any configured webhook or Events receiver', async () => {
    const { client } = await scope.connected();
    await client.callTool({ name: 'set_webhook', arguments: { url: 'https://hooks.example/custom-host' } });
    expect((await client.callTool({ name: 'setup_delivery', arguments: binding })).isError).toBe(true);
    const events = await scope.eventFixture();
    await scope.eventCall(events.token, 'events/subscribe', events.params);
    expect((await events.client.callTool({ name: 'setup_delivery', arguments: binding })).isError).toBe(true);
  });

  it('projects old on-demand bindings as unfinished when that member acquires an inbound route', async () => {
    const { client } = await scope.connected();
    expect(scope.data(await client.callTool({ name: 'setup_delivery', arguments: binding })).delivery.state).toBe('host_without_live_delivery');
    await client.callTool({ name: 'set_webhook', arguments: { url: 'https://hooks.example/new-receiver' } });
    expect(scope.data(await client.callTool({ name: 'list_chats', arguments: {} })).delivery.state).toBe('setup_unfinished');
  });
});

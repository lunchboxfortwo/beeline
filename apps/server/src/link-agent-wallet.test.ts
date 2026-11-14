import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
import { LinkAgentWallet } from './link-agent-wallet.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { createAgentCommand } from './agent-command.js';
import { ensureSystemIdentity } from './system-line.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

const OWNER = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);
const ROOM = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
let database: PgliteDatabase;

beforeEach(async () => {
  database = await migratedDatabase();
  await database.query(`INSERT INTO identities(id,kind,name) VALUES
    ($1,'human','Owner'),($2,'agent','Agent'),($3,'agent','Other')`, [OWNER, AGENT, OTHER]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES ($1,'Test')`, [WORKSPACE]);
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES ($1,$2)`, [AGENT, OWNER]);
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES ($1,NULL,$2,'owner'),($1,NULL,$3,'member')`, [WORKSPACE, OWNER, AGENT]);
  await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name,visibility)
    VALUES ($1,$2,$3,'Purchase','invite-only')`, [ROOM, WORKSPACE, OWNER]);
});

it.each([false, true])('posts the Link approval at its call site only when the owner reads it (owner in Room: %s)', async ownerInRoom => {
  if (ownerInRoom) await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES ($1,$2,$3,'owner')`, [WORKSPACE, ROOM, OWNER]);
  const transport = vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith('/auth/token')) return Response.json({ access_token: 'access',
      refresh_token: 'refresh', expires_in: 3600, scope: 'payment_methods.agentic userinfo:read' });
    if (String(url).endsWith('/userinfo')) return Response.json({ address: { country: 'US' } });
    return Response.json({ id: 'lsrq_private1', status: 'pending_approval',
      approval_url: 'https://app.link.com/activity/approve/lsrq_private1' });
  }) as unknown as typeof fetch;
  const client = wallet(transport);
  const state = new URL(await client.begin(OWNER)).searchParams.get('state')!;
  await client.complete(state, 'code');
  const daemon = new DaemonService(database, new LiveHub(), undefined, undefined,
    true, undefined, false, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, client);
  const result = await daemon.execute('createLinkSpendRequest', { agentId: AGENT, roomId: ROOM,
    merchant: 'Stripe Press', merchantUrl: 'https://press.stripe.com', amount: 3500,
    description: 'A book', idempotencyKey: 'owner-book-1' }, AGENT);
  expect(result).toMatchObject({ id: 'lsrq_private1', status: 'pending_approval' });
  const card = (await database.query<{ room_id: string; card: { tool: string; approvalUrl: string } }>(
    `SELECT room_id,card FROM messages WHERE card_type='squire-approval'`)).rows[0]!;
  expect(card.card).toMatchObject({ tool: 'Link',
    approvalUrl: 'https://app.link.com/activity/approve/lsrq_private1' });
  expect(card.card).toMatchObject({ owner: { pubkey: OWNER } });
  if (ownerInRoom) return expect(card.room_id).toBe(ROOM);
  expect(card.room_id).not.toBe(ROOM);
  const members = (await database.query<{ identity_id: string }>(
    `SELECT identity_id FROM memberships WHERE room_id=$1 ORDER BY identity_id`,
    [card.room_id])).rows.map(row => row.identity_id);
  expect(members).toContain(OWNER);
  expect(members).not.toContain(AGENT);
});
it.each(['approved', 'denied', 'expired'] as const)('settles a Link %s at the original call site and wakes its asking turn once', async status => {
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES ($1,$2,$3,'owner'),($1,$2,$4,'member')`, [WORKSPACE, ROOM, OWNER, AGENT]);
  await ensureSystemIdentity(database);
  const requestId = createHash('sha256').update('link-asking-turn').digest('hex');
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Buy a book')`, [requestId, ROOM, SYSTEM_IDENTITY_ID]);
  const command = await createAgentCommand(database, { roomId: ROOM, agentId: AGENT, sourceMessageId: requestId, id: requestId, reason: 'fixture' });
  let providerStatus = 'pending_approval';
  const transport = vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith('/auth/token')) return Response.json({ access_token: 'access',
      refresh_token: 'refresh', expires_in: 3600, scope: 'payment_methods.agentic userinfo:read' });
    if (String(url).endsWith('/userinfo')) return Response.json({ address: { country: 'US' } });
    return Response.json({ id: 'lsrq_settlement', status: providerStatus,
      ...(providerStatus === 'pending_approval' ? { approval_url: 'https://app.link.com/activity/approve/lsrq_settlement' } : {}),
      ...(providerStatus === 'approved' ? { card: { number: '4000009990001984', exp_month: 6, exp_year: 2029 } } : {}) });
  }) as unknown as typeof fetch;
  const client = wallet(transport);
  await client.complete(new URL(await client.begin(OWNER)).searchParams.get('state')!, 'code');
  const live = new LiveHub();
  const publish = vi.spyOn(live, 'publish');
  const daemon = new DaemonService(database, live, undefined, undefined,
    true, command!, false, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, client);
  await daemon.execute('createLinkSpendRequest', { agentId: AGENT, roomId: ROOM,
    merchant: 'Bookshop', merchantUrl: 'https://bookshop.example.test', amount: 100,
    description: 'Harmless test purchase', idempotencyKey: 'settlement' }, AGENT);
  expect((await daemon.execute('retrieveLinkSpendRequest', { agentId: AGENT, roomId: ROOM, id: 'lsrq_settlement' }, AGENT)).status).toBe('pending_approval');
  expect((await database.query(`SELECT 1 FROM agent_commands WHERE action='resume'`)).rowCount).toBe(0);
  providerStatus = status;
  // Retrieval may run elsewhere; only the creating Room and turn receive the decision.
  const otherRoom = '33333333-3333-4333-8333-333333333333';
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Elsewhere')`, [otherRoom, WORKSPACE]);
  const laterRequestId = createHash('sha256').update('link-retrieving-turn').digest('hex');
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Retrieve the purchase')`, [laterRequestId, otherRoom, SYSTEM_IDENTITY_ID]);
  const laterCommand = await createAgentCommand(database, { roomId: otherRoom, agentId: AGENT,
    sourceMessageId: laterRequestId, id: laterRequestId, reason: 'fixture' });
  const retrieving = new DaemonService(database, live, undefined, undefined,
    true, laterCommand!, false, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, client);
  const input = { agentId: AGENT, roomId: otherRoom, id: 'lsrq_settlement' };
  expect((await retrieving.execute('retrieveLinkSpendRequest', input, AGENT)).status).toBe(status);
  await retrieving.execute('retrieveLinkSpendRequest', input, AGENT);
  expect((await database.query(`SELECT room_id,card->>'status' status FROM messages WHERE card_type='squire-approval'`)).rows)
    .toEqual([{ room_id: ROOM, status }]);
  expect((await database.query(`SELECT room_id,turn_request_id FROM agent_commands WHERE action='resume'`)).rows)
    .toEqual([{ room_id: ROOM, turn_request_id: requestId }]);
  expect((await database.query(`SELECT room_id FROM messages WHERE card_type='squire-approval-decision'`)).rows)
    .toEqual([{ room_id: ROOM }]);
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'invalidate', roomId: ROOM }));
  expect(JSON.stringify((await database.query(`SELECT card FROM messages WHERE card_type IN ('squire-approval','squire-approval-decision')`)).rows))
    .not.toContain('4000009990001984');
});

afterEach(async () => database.close());

function wallet(transport: typeof fetch) {
  return new LinkAgentWallet(database, 'client-id', 'client-secret', 'pk_test_example',
    'https://server.usebeeline.app', randomBytes(32).toString('base64'), transport);
}

it('registers exact hosted OAuth redirect with state and S256 PKCE, then consumes state once', async () => {
  const transport = vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith('/auth/token')) return Response.json({ access_token: 'secret-access',
      refresh_token: 'secret-refresh', expires_in: 3600,
      scope: 'payment_methods.agentic userinfo:read' });
    return Response.json({ address: { country: 'US' } });
  }) as unknown as typeof fetch;
  const client = wallet(transport);
  const url = new URL(await client.begin(OWNER));
  expect(url.origin).toBe('https://login.link.com');
  expect(url.searchParams.get('redirect_uri'))
    .toBe('https://server.usebeeline.app/v1/link/oauth/callback');
  expect(url.searchParams.get('scope')).toBe('payment_methods.agentic userinfo:read');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('key')).toBe('pk_test_example');
  const attempt = (await database.query<{ code_verifier: string }>(
    `SELECT code_verifier FROM link_oauth_accounts WHERE owner_identity_id=$1`, [OWNER])).rows[0]!;
  expect(url.searchParams.get('code_challenge'))
    .toBe(createHash('sha256').update(attempt.code_verifier).digest('base64url'));
  expect(await client.complete(url.searchParams.get('state')!, 'one-use-code'))
    .toEqual({ completed: true, ownerId: OWNER });
  expect(await client.complete(url.searchParams.get('state')!, 'one-use-code'))
    .toEqual({ completed: false });
  const stored = (await database.query<{ sealed_grant: string }>(
    `SELECT sealed_grant FROM link_oauth_accounts WHERE owner_identity_id=$1`, [OWNER])).rows[0]!;
  expect(stored.sealed_grant).not.toContain('secret-access');
  expect(stored.sealed_grant).not.toContain('secret-refresh');
  expect(await client.status(OWNER)).toEqual({ connected: true, pending: false, ineligible: false });
});

it('shows Link ineligibility for a non-US/Canada consumer and refuses a spend request', async () => {
  const transport = vi.fn(async (url: string | URL | Request) =>
    String(url).endsWith('/auth/token')
      ? Response.json({ access_token: 'access', refresh_token: 'refresh',
        expires_in: 3600, scope: 'payment_methods.agentic userinfo:read' })
      : Response.json({ address: { country: 'SG' } })) as unknown as typeof fetch;
  const client = wallet(transport);
  const state = new URL(await client.begin(OWNER)).searchParams.get('state')!;
  await client.complete(state, 'code');
  expect(await client.status(OWNER)).toMatchObject({ connected: true, ineligible: true });
  await expect(client.create(OWNER, AGENT, ROOM, { merchant: 'Example',
    merchantUrl: 'https://example.com', amount: 3500, description: 'A book',
    idempotencyKey: 'purchase-1', test: true })).rejects.toThrow(/US or Canada/);
  expect(transport).toHaveBeenCalledTimes(2);
});

it('uses Link test mode, rotates refresh tokens, and returns card only after approval', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let retrieveCount = 0;
  const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/auth/token')) {
      const body = init?.body as URLSearchParams;
      return Response.json({ access_token: body.get('grant_type') === 'refresh_token'
        ? 'new-access' : 'old-access', refresh_token: body.get('grant_type') === 'refresh_token'
          ? 'new-refresh' : 'old-refresh', expires_in: body.get('grant_type') === 'refresh_token'
            ? 3600 : 1, scope: 'payment_methods.agentic userinfo:read' });
    }
    if (String(url).endsWith('/userinfo')) return Response.json({ address: { country: 'CA' } });
    if (String(url).endsWith('/spend_requests')) return Response.json({ id: 'lsrq_abc123',
      status: 'pending_approval', approval_url: 'https://app.link.com/activity/approve/lsrq_abc123' });
    retrieveCount++;
    return Response.json(retrieveCount === 1 ? { id: 'lsrq_abc123', status: 'pending_approval' }
      : { id: 'lsrq_abc123', status: 'approved', card: { number: '4000009990001984',
        cvc: '100', exp_month: 6, exp_year: 2029,
        billing_address: { name: 'Test Buyer', postal_code: '94015' } } });
  }) as unknown as typeof fetch;
  const client = wallet(transport);
  const state = new URL(await client.begin(OWNER)).searchParams.get('state')!;
  await client.complete(state, 'code');
  const created = await client.create(OWNER, AGENT, ROOM, { merchant: 'Stripe Press',
    merchantUrl: 'https://press.stripe.com', amount: 3500, description: 'A book',
    idempotencyKey: 'book-1', test: true });
  expect(created.status).toBe('pending_approval');
  const createCall = calls.find(call => call.url.endsWith('/spend_requests'))!;
  const body = JSON.parse(String(createCall.init?.body)) as Record<string, unknown>;
  expect(body).toMatchObject({ test: true, amount: 3500, request_approval: true,
    merchant_name: 'Stripe Press', idempotency_key: 'book-1' });
  expect(String(body.context).trim().length).toBeGreaterThanOrEqual(100);
  expect(createCall.init?.headers).toMatchObject({ authorization: 'Bearer new-access' });
  expect(await client.retrieve(OWNER, AGENT, created.id)).toEqual({ id: created.id,
    status: 'pending_approval', approval_url: undefined });
  await expect(client.retrieve(OWNER, OTHER, created.id)).rejects.toThrow(/unavailable/);
  expect((await client.retrieve(OWNER, AGENT, created.id)).card?.number)
    .toBe('4000009990001984');
  await client.create(OWNER, AGENT, ROOM, { merchant: 'MPP seller', amount: 100,
    description: 'A one-time MPP purchase', credentialType: 'shared_payment_token',
    networkId: 'network_example', idempotencyKey: 'mpp-1', test: true });
  const sptBody = JSON.parse(String(calls.filter(call => call.url.endsWith('/spend_requests'))
    .at(-1)?.init?.body)) as Record<string, unknown>;
  expect(sptBody).toMatchObject({ credential_type: 'shared_payment_token',
    network_id: 'network_example', test: true });
  expect(sptBody).not.toHaveProperty('merchant_name');
  expect(sptBody).not.toHaveProperty('merchant_url');
  const stored = (await database.query<{ sealed_grant: string }>(
    `SELECT sealed_grant FROM link_oauth_accounts WHERE owner_identity_id=$1`, [OWNER])).rows[0]!;
  expect(stored.sealed_grant).not.toContain('new-refresh');
});

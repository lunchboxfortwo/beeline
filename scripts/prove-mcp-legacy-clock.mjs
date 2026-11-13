// Build @beeline/server first, then run with node --import tsx.
// Isolated HTTP stand-in for an installed pre-4272 session; no real sign-in or daemon.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { PgliteDatabase } from '../apps/server/src/test-support.ts';
import { migrate } from '../apps/server/dist/database.js';
import { tokenHash, TokenAuth } from '../apps/server/dist/auth.js';
import { RoomsMcpOAuth } from '../apps/server/dist/rooms-mcp-oauth.js';
import { RoomsMcp } from '../apps/server/dist/rooms-mcp.js';
import { PhoneService } from '../apps/server/dist/phone-service.js';
import { LiveHub } from '../apps/server/dist/live.js';

const db = new PgliteDatabase();
let mcp;
const server = createServer(async (request, response) => {
  try {
    if (!await mcp.handle(request, response)) { response.writeHead(404); response.end(); }
  } catch (error) { console.error(error); response.writeHead(500); response.end(); }
});
try {
  await migrate(db);
  const owner = 'a'.repeat(64), workspace = randomUUID();
  await db.query("INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Compat proof','compat-proof')", [owner]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Compat proof')", [workspace]);
  await db.query("INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')", [workspace, owner]);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const live = new LiveHub();
  const auth = new TokenAuth(db, async () => { throw new Error('No real sign-in in proof'); });
  mcp = new RoomsMcp(new RoomsMcpOAuth(db, origin, auth, 'localhost'), new PhoneService(db, origin), live);
  const post = (path, body, headers = {}) => fetch(origin + path, { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const registered = await post('/mcp/oauth/register', { client_name: 'Compat proof',
    redirect_uris: [origin + '/callback'], token_endpoint_auth_method: 'none' });
  assert.equal(registered.status, 201);
  const { client_id } = await registered.json();
  // Stand in for the person's completed consent; exercise the real PKCE exchange.
  const code = randomUUID(), verifier = 'v'.repeat(43);
  await db.query(`INSERT INTO rooms_mcp_codes(hash,client_id,identity_id,redirect_uri,challenge,scope,expires_at)
    VALUES($1,$2,$3,$4,$5,'rooms:read rooms:write',now()+interval '1 minute')`,
  [tokenHash(code), client_id, owner, origin + '/callback', createHash('sha256').update(verifier).digest('base64url')]);
  const exchanged = await post('/mcp/oauth/token', { grant_type: 'authorization_code', client_id, code,
    code_verifier: verifier, redirect_uri: origin + '/callback', resource: origin + '/mcp' });
  assert.equal(exchanged.status, 200);
  const initial = await exchanged.json();
  const refreshToken = randomUUID();
  await db.query(`INSERT INTO rooms_mcp_refresh(hash,family_id)
    SELECT $1,family_id FROM rooms_mcp_tokens WHERE hash=$2`, [tokenHash(refreshToken), tokenHash(initial.access_token)]);
  const session = { accessToken: initial.access_token, refreshToken, accessExpiresAt: 0 };
  let refreshes = 0;
  // Same validity predicate and storage assignments as the pre-4272 accessToken().
  const accessToken = async now => {
    if (session.accessToken && (session.accessExpiresAt ?? 0) > now + 60_000) return session.accessToken;
    refreshes++;
    const response = await post('/mcp/oauth/token', { grant_type: 'refresh_token', client_id,
      refresh_token: session.refreshToken, resource: origin + '/mcp' });
    assert.equal(response.status, 200, 'Beeline disconnected this session');
    const tokens = await response.json();
    session.accessToken = tokens.access_token;
    session.refreshToken = tokens.refresh_token;
    session.accessExpiresAt = now + tokens.expires_in * 1000;
    return tokens.access_token;
  };
  for (const elapsed of [0, 60_000, 86_400_000]) {
    const token = await accessToken(Date.now() + elapsed);
    const response = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'list_rooms', arguments: {} } }, { authorization: `Bearer ${token}`,
      'mcp-protocol-version': '2026-07-28', accept: 'application/json' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.isError, undefined);
  }
  assert.equal(refreshes, 1);
  assert.equal(session.refreshToken, undefined);
  assert.equal(initial.expires_in, 10 * 365 * 24 * 60 * 60);
  assert.equal((await db.query('SELECT expires_at FROM rooms_mcp_tokens WHERE hash=$1',
    [tokenHash(session.accessToken)])).rows[0].expires_at, null);
  const revoked = await post('/mcp/oauth/revoke', { client_id, token: session.accessToken });
  assert.equal(revoked.status, 200);
  assert.equal((await fetch(origin + '/mcp', { headers: { authorization: `Bearer ${session.accessToken}` } })).status, 401);
  console.log('R-MCP-LEGACY-CLOCK PASS: one refresh, repeated tool calls through the next day, no disconnect; revocation returns 401.');
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await db.close();
}

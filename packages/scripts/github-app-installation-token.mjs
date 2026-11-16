// Mint a repository-scoped Beeline GitHub App installation token.
// Release start uses it instead of the workflow token, so Checks traffic
// cannot exhaust the budget those calls need.
import { createSign } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const RELEASE_START_PERMISSIONS = Object.freeze({
  contents: 'write',
  actions: 'read',
  metadata: 'read',
});

const API = 'https://api.github.com';

export function appJwt({ privateKey, appId, now = Math.floor(Date.now() / 1000) }) {
  if (!appId || !privateKey) throw new Error('GitHub App id and private key are required');
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: String(appId),
  })).toString('base64url');
  const body = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(body);
  signer.end();
  const signature = signer.sign(privateKey.replace(/\\n/g, '\n')).toString('base64url');
  return `${body}.${signature}`;
}

export function repositoryName(repository) {
  const name = String(repository ?? '').split('/')[1];
  if (!name || String(repository).split('/').length !== 2) throw new Error('GITHUB_REPOSITORY must be owner/name');
  return name;
}

async function readJson(request, method, url, headers, body) {
  const response = await request(method, url, headers, body);
  if (!response || typeof response !== 'object') throw new Error(`GitHub ${method} ${new URL(url).pathname} failed`);
  return response;
}

/** Installation lookup, then one repository-scoped access token. */
export async function mintInstallationToken({ appId, privateKey, repository, request, now }) {
  const jwt = appJwt({ privateKey, appId, now });
  const headers = {
    authorization: `Bearer ${jwt}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'beeline-release',
  };
  const installation = await readJson(request, 'GET', `${API}/repos/${repository}/installation`, headers);
  if (!Number.isSafeInteger(installation.id) || installation.id <= 0)
    throw new Error('GitHub installation response is invalid');
  const minted = await readJson(request, 'POST', `${API}/app/installations/${installation.id}/access_tokens`, headers, {
    repositories: [repositoryName(repository)],
    permissions: RELEASE_START_PERMISSIONS,
  });
  if (typeof minted.token !== 'string' || !minted.token || typeof minted.expires_at !== 'string')
    throw new Error('GitHub installation token response is invalid');
  return minted.token;
}

export async function githubRequest(method, url, headers, body) {
  const response = await fetch(url, {
    method,
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${new URL(url).pathname} failed: HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const token = await mintInstallationToken({
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    repository: process.env.GITHUB_REPOSITORY,
    request: githubRequest,
  });
  process.stdout.write(`${token}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'GitHub App token mint failed');
    process.exit(1);
  });
}

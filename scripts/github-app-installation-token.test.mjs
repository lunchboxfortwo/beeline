import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { appJwt, mintInstallationToken, RELEASE_START_PERMISSIONS, repositoryName } from './github-app-installation-token.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

test('the app JWT is signed for the app id and stays valid for nine minutes', () => {
  const now = 1_700_000_000;
  const token = appJwt({ privateKey: pem.replaceAll('\n', '\\n'), appId: '1234567', now });
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url').toString()), {
    iat: now - 60, exp: now + 540, iss: '1234567',
  });
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header}.${payload}`);
  verifier.end();
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, 'base64url')), true);
});

test('a release start mints one token for the named repository', async () => {
  const calls = [];
  const token = await mintInstallationToken({
    appId: '1234567',
    privateKey: pem,
    repository: 'Beeline-Work/beeline',
    now: 1_700_000_000,
    request: async (method, url, headers, body) => {
      calls.push({ method, url, authorization: headers.authorization, body });
      if (url.endsWith('/installation')) return { id: 155845498 };
      return { token: 'ghs_scoped', expires_at: '2030-01-01T00:00:00Z' };
    },
  });
  assert.equal(token, 'ghs_scoped');
  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ['GET', 'https://api.github.com/repos/Beeline-Work/beeline/installation'],
    ['POST', 'https://api.github.com/app/installations/155845498/access_tokens'],
  ]);
  assert.match(calls[0].authorization, /^Bearer /);
  assert.deepEqual(calls[1].body, {
    repositories: ['beeline'],
    permissions: RELEASE_START_PERMISSIONS,
  });
  assert.equal(repositoryName('Beeline-Work/beeline'), 'beeline');
});

test('a mint that does not return a token fails without echoing the key', async () => {
  await assert.rejects(() => mintInstallationToken({
    appId: '1234567',
    privateKey: pem,
    repository: 'Beeline-Work/beeline',
    request: async (method, url) => url.endsWith('/installation') ? { id: 1 } : { expires_at: 'no' },
  }), (error) => {
    assert.equal(error.message, 'GitHub installation token response is invalid');
    assert.equal(error.message.includes('BEGIN'), false);
    return true;
  });
});

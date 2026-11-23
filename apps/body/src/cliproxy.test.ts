import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createRequire } from 'node:module';
import { CliProxy, cliProxyDir, installLatestCliProxy } from './cliproxy.js';

const run = promisify(execFile);
const roots: string[] = [];
const proxies: CliProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.stop()));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * A stand-in CLIProxyAPI: it reads the generated config, serves the
 * management routes Beeline calls, and keeps logins in its auth dir the way
 * the real proxy does. The real binary is exercised by the live proof.
 */
const FAKE_PROXY = `#!${process.execPath}
const fs = require('node:fs'); const http = require('node:http'); const path = require('node:path');
const raw = fs.readFileSync(process.argv[3], 'utf8');
const config = require(${JSON.stringify(createRequire(import.meta.url).resolve('yaml'))}).parse(raw);
const port = config.server.port; const auth = config.oauth['auth-dir'];
const management = config.management['secret-key'];
fs.writeFileSync(path.join(path.dirname(process.argv[3]), 'seen-config.yaml'), raw);
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'); let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/v1/models') return json(200, { data: [] });
    if (req.headers.authorization !== 'Bearer ' + management) return json(401, { error: 'unauthorized' });
    const name = url.searchParams.get('name');
    if (url.pathname === '/v0/management/auth-files' && req.method === 'POST') {
      fs.writeFileSync(path.join(auth, name), body); return json(200, { status: 'ok' });
    }
    if (url.pathname === '/v0/management/auth-files')
      return json(200, { files: fs.readdirSync(auth).map((file) => ({ name: file, provider: JSON.parse(fs.readFileSync(path.join(auth, file), 'utf8')).type })) });
    if (url.pathname === '/v0/management/auth-files/download') {
      try { return json(200, JSON.parse(fs.readFileSync(path.join(auth, name), 'utf8'))); } catch { return json(404, {}); }
    }
    json(404, {});
  });
}).listen(port, '127.0.0.1', () => console.log('API server started successfully on: 127.0.0.1:' + port));
`;

async function installFake(home: string, source = FAKE_PROXY): Promise<void> {
  const dir = join(cliProxyDir(home), 'bin', '1.0.0');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'cli-proxy-api'), source);
  await chmod(join(dir, 'cli-proxy-api'), 0o755);
  await writeFile(join(cliProxyDir(home), 'bin', 'current'), '1.0.0\n');
}

async function proxyIn(source?: string): Promise<{ home: string; proxy: CliProxy }> {
  const home = await mkdtemp(join(tmpdir(), 'cliproxy-'));
  roots.push(home);
  await installFake(home, source);
  const proxy = new CliProxy(home);
  proxies.push(proxy);
  return { home, proxy };
}

it('writes private loopback configuration and replaces logins through management', async () => {
  const { home, proxy } = await proxyIn();
  await proxy.start();
  const endpoint = proxy.endpoint!;
  expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const config = parse(await readFile(join(cliProxyDir(home), 'seen-config.yaml'), 'utf8'));
  expect(config).toEqual({
    'config-version': 8,
    server: { host: '127.0.0.1', port: Number(new URL(endpoint.url).port) },
    management: {
      'allow-remote': false,
      'secret-key': expect.any(String),
      'disable-control-panel': true,
    },
    access: { 'api-keys': [endpoint.key] },
    oauth: { 'auth-dir': join(cliProxyDir(home), 'auth') },
  });
  expect(config.management['secret-key']).not.toBe(endpoint.key);
  expect(config.management['secret-key'].length).toBeGreaterThan(0);
  expect((await stat(join(cliProxyDir(home), 'config.yaml'))).mode & 0o777).toBe(0o600);

  await proxy.saveLogin('claude', { access_token: 'first', refresh_token: 'r1' });
  await proxy.saveLogin('claude', { access_token: 'second', refresh_token: 'r2' });
  expect(
    JSON.parse(await readFile(join(cliProxyDir(home), 'auth', 'beeline-claude.json'), 'utf8')),
  ).toEqual({
    access_token: 'second',
    refresh_token: 'r2',
    type: 'claude',
  });
  expect(await proxy.readLogin('claude')).toMatchObject({ access_token: 'second' });
  expect(await proxy.readLogin('codex')).toBeUndefined();
});

it('fails a start whose proxy exits before its ready line, naming its last line', async () => {
  const { proxy } = await proxyIn(
    `#!${process.execPath}\nconsole.error('listen tcp: address already in use'); process.exit(3);\n`,
  );
  await expect(proxy.start()).rejects.toThrow(
    'CLIProxyAPI exited 3: listen tcp: address already in use',
  );
  // A failed start leaves nothing running: the next start launches again.
  await expect(proxy.start()).rejects.toThrow('CLIProxyAPI exited 3');
});

it('is ready on its ready phrase even before the line ends, and stop waits for its exit', async () => {
  const { proxy } = await proxyIn(
    `#!${process.execPath}\nprocess.stdout.write('API server started successfully'); setInterval(() => {}, 1000);\n`,
  );
  await proxy.start();
  await proxy.stop();
  await expect(proxy.stop()).resolves.toBeUndefined();
});

it('keeps its endpoint when the stopped proxy starts again', async () => {
  const { proxy } = await proxyIn();
  await proxy.start();
  const endpoint = proxy.endpoint!;
  await proxy.stop();
  await expect(fetch(`${endpoint.url}/v1/models`)).rejects.toThrow();
  await expect(proxy.readLogin('claude')).resolves.toBeUndefined();
  expect(proxy.endpoint).toBe(endpoint);
  expect(
    (
      await fetch(`${endpoint.url}/v1/models`, {
        headers: { authorization: `Bearer ${endpoint.key}` },
      })
    ).status,
  ).toBe(200);
});

it('installs the latest release only when its published checksum matches', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cliproxy-install-'));
  roots.push(home);
  const cached = join(cliProxyDir(home), 'bin', '1.0.0', 'cli-proxy-api');
  await mkdir(join(cached, '..'), { recursive: true });
  await writeFile(cached, '#!/bin/sh\nprintf retained\n', { mode: 0o755 });
  const staging = join(home, 'staging');
  await mkdir(staging);
  await writeFile(join(staging, 'cli-proxy-api'), '#!/bin/sh\n');
  const arch = process.arch === 'arm64' ? 'aarch64' : 'amd64';
  const name = `CLIProxyAPI_9.9.9_${process.platform === 'darwin' ? 'darwin' : 'linux'}_${arch}.tar.gz`;
  await run('tar', ['-czf', join(home, name), '-C', staging, 'cli-proxy-api']);
  const archive = await readFile(join(home, name));
  const release = (checksum: string) =>
    (async (url: string) => {
      if (url.endsWith('/releases/latest'))
        return Response.json({
          tag_name: 'v9.9.9',
          assets: [
            { name, browser_download_url: 'https://example.test/archive' },
            { name: 'checksums.txt', browser_download_url: 'https://example.test/checksums' },
          ],
        });
      if (url.endsWith('/archive')) return new Response(archive);
      return new Response(`${checksum}  ${name}\n`);
    }) as typeof fetch;
  await expect(installLatestCliProxy(home, release('0'.repeat(64)))).rejects.toThrow(
    'does not match its release checksum',
  );
  await expect(stat(join(cliProxyDir(home), 'bin', '9.9.9'))).rejects.toThrow();
  const binary = await installLatestCliProxy(
    home,
    release(createHash('sha256').update(archive).digest('hex')),
  );
  expect(binary).toBe(join(cliProxyDir(home), 'bin', '9.9.9', 'cli-proxy-api'));
  expect(await readFile(binary, 'utf8')).toBe('#!/bin/sh\n');
  expect((await run(cached, [])).stdout).toBe('retained');
  expect(await readFile(join(cliProxyDir(home), 'bin', 'current'), 'utf8')).toBe('9.9.9\n');
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import worker, { serveDownloads } from '../../apps/infra/helper-downloads/worker.mjs';
import { buildPagesSite } from './pages-site.mjs';
import { publishPagesChannel, MAC_INPUT_FILES } from './pages-channel.mjs';
import { verifyPagesUpdate } from './verify-pages-update.mjs';

const yaml = async path => parse(await readFile(path, 'utf8'));
const request = (path, init) => new Request(`https://usebeeline.app${path}`, init);

async function helperFixture(directory, version = 'v0.1.1', sha = 'a'.repeat(40)) {
  const source = join(directory, 'source');
  await mkdir(join(source, 'lib/beeline/codegraph/bin'), { recursive: true });
  await mkdir(join(source, 'bin'), { recursive: true });
  await writeFile(join(source, 'bin/beeline'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const cli = `console.log(${JSON.stringify(version)});\n`;
  for (const file of ['beeline-cli.mjs', 'recovery-cli.mjs', 'pi-mcp-adapter.mjs',
    'owned-model-provider.mjs', 'codegraph/bin/codegraph']) {
    await writeFile(join(source, 'lib/beeline', file), cli);
  }
  await writeFile(join(source, 'lib/beeline/bundle.json'), JSON.stringify({ commit: sha, version }));
  const manifest = { schemaVersion: 1, version, sourceCommit: sha, bundles: {} }, files = [];
  const file = 'beeline-linux-x64.tar.gz';
  execFileSync('tar', ['-czf', join(directory, file), '-C', source, 'lib', 'bin']);
  const bytes = await readFile(join(directory, file));
  const digest = createHash('sha256').update(bytes).digest('hex');
  for (const platform of ['linux-x64', 'darwin-arm64', 'darwin-x64']) {
    const name = `beeline-${platform}.tar.gz`;
    await writeFile(join(directory, name), bytes);
    await writeFile(join(directory, `${name}.sha256`), `${digest}  ${name}\n`);
    manifest.bundles[platform] = { file: name, sha256: digest, bytes: bytes.length, verified: true, commit: sha, version };
    files.push(name, `${name}.sha256`);
  }
  const recoverySha = createHash('sha256').update(cli).digest('hex');
  manifest.recovery = { file: 'beeline-bootstrap.mjs', sha256: recoverySha, bytes: Buffer.byteLength(cli) };
  await writeFile(join(directory, 'beeline-bootstrap.mjs'), cli);
  await writeFile(join(directory, 'beeline-bootstrap.mjs.sha256'), `${recoverySha}  beeline-bootstrap.mjs\n`);
  for (const name of MAC_INPUT_FILES) await writeFile(join(directory, name), JSON.stringify({ platform: name }));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  files.push('beeline-bootstrap.mjs', 'beeline-bootstrap.mjs.sha256', ...MAC_INPUT_FILES, 'manifest.json');
  return { manifest, bytes, files };
}

test('failed R2 uploads stop before the manifest and GitHub backup without retrying', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'helper-r2-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { files } = await helperFixture(directory);
  for (const failedFile of [files[0], MAC_INPUT_FILES[0], 'manifest.json']) {
    for (const response of [new Response('', { status: 403 }), Response.json({ success: false })]) {
      const uploaded = [];
      await assert.rejects(publishPagesChannel({ directory, repo: {}, channel: 'next',
        token: 'fixture-token', accountId: 'a'.repeat(32),
        github: { rest: { repos: { getReleaseByTag() { assert.fail('GitHub backup must follow R2'); } } } },
        fetchImpl: async (url, options) => {
          for await (const _chunk of options.body) { /* Consume fixture bytes. */ }
          const file = new URL(url).pathname.split('/').at(-1);
          uploaded.push(file);
          return file === failedFile ? response : Response.json({ success: true });
        },
      }), /R2 upload failed/);
      assert.deepEqual(uploaded, files.slice(0, files.indexOf(failedFile) + 1));
    }
  }
});

test('invalid credentials or channel fail before any publication', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'helper-r2-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await helperFixture(directory);
  for (const [args, error] of [
    [{ token: '' }, /CLOUDFLARE_R2_TOKEN/],
    [{ token: 'fixture-token', accountId: 'invalid' }, /CLOUDFLARE_ACCOUNT_ID/],
    [{ channel: '../escape' }, /invalid helper channel/],
  ]) {
    await assert.rejects(publishPagesChannel({ directory, ...args,
      github: { rest: { repos: { getReleaseByTag() { assert.fail('must not publish'); } } } },
      fetchImpl() { assert.fail('must not upload'); },
    }), error);
  }
});

test('preview deployment cannot install the canonical download route', async () => {
  const config = JSON.parse(await readFile('apps/infra/helper-downloads/wrangler.jsonc', 'utf8'));
  assert.deepEqual(config.routes, [{ pattern: 'usebeeline.app/dl/*', zone_name: 'usebeeline.app' }]);
  assert.equal(config.workers_dev, false);
  assert.deepEqual(config.env.preview.routes, []);
  assert.equal(config.env.preview.workers_dev, true);
  assert.equal(config.env.preview.name, 'beeline-helper-downloads-preview');
});

test('both existing channel paths stream R2 objects without forwarding credentials or redirects', async () => {
  for (const channel of ['', 'next/']) {
    for (const file of ['manifest.json', 'beeline-linux-x64.tar.gz', 'beeline-darwin-arm64.tar.gz',
      'beeline-darwin-x64.tar.gz.sha256', 'beeline-bootstrap.mjs', 'beeline-bootstrap.mjs.sha256']) {
      const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('exact bytes')); controller.close(); } });
      const response = await serveDownloads(request(`/dl/${channel}${file}`, {
        headers: { Authorization: 'secret', Cookie: 'session=secret', Range: 'bytes=0-10' },
      }), async (url, options) => {
        const target = new URL(url);
        assert.equal(target.origin, 'https://downloads.usebeeline.app');
        assert.equal(target.pathname, `/dl/${channel}${file}`);
        assert.ok(target.searchParams.has('channel_check'));
        assert.equal(options.redirect, 'follow');
        assert.equal(options.cache, 'no-store');
        assert.equal(options.headers.get('authorization'), null);
        assert.equal(options.headers.get('cookie'), null);
        assert.equal(options.headers.get('range'), 'bytes=0-10');
        return new Response(stream, { status: 206, headers: { 'Content-Range': 'bytes 0-10/100', 'Set-Cookie': 'unsafe=1' } });
      });
      assert.equal(response.body, stream); // Archives remain streamed, never buffered.
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), 'bytes 0-10/100');
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-beeline-downloads'), 'r2');
      assert.equal(await response.text(), 'exact bytes');
    }
  }
});

test('HEAD preserves metadata; upstream absence and failure never fall back to stale Pages', async () => {
  const response = await serveDownloads(request('/dl/manifest.json', { method: 'HEAD' }), async (_url, options) => {
    assert.equal(options.method, 'HEAD');
    return new Response(null, { headers: { 'Content-Length': '100', ETag: 'current' } });
  });
  assert.equal(response.body, null);
  assert.equal(response.headers.get('content-length'), '100');
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal((await serveDownloads(request('/dl/manifest.json'), async () => new Response(null, { status: 404 }))).status, 404);
  assert.equal((await serveDownloads(request('/dl/manifest.json'), async () => { throw Error('network'); })).status, 502);
});

test('route rejects unrecognized files, nested paths and writes before fetching', async () => {
  const forbidden = () => { throw Error('must not fetch'); };
  for (const path of ['/dl/other.json', '/dl/latest/manifest.json', '/dl/next/next/manifest.json', '/index.html', '/dl/manifest.json%2fextra']) {
    assert.equal((await serveDownloads(request(path), forbidden)).status, 404);
  }
  const response = await serveDownloads(request('/dl/manifest.json', { method: 'POST' }), forbidden);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
});

test('helper promote dry run publishes and reads both exact channels through the Worker, without Pages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helper-downloads-'));
  const originalFetch = globalThis.fetch;
  const environmentKeys = ['GITHUB_WORKSPACE', 'BUNDLE_DIR', 'CHANNEL', 'RELEASE_SHA', 'RELEASE_VERSION', 'CLOUDFLARE_R2_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];
  const originalEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  try {
    const action = await yaml('.github/actions/daemon-leg/action.yml');
    assert.equal(action.runs.steps.some(step => /pages-leg|deploy-pages|upload-pages/.test(step.uses ?? step.run ?? '')), false);
    const publish = action.runs.steps.find(step => step.env?.BUNDLE_DIR);
    const releases = new Map(), assets = new Map(), objects = new Map(), uploads = []; let id = 1;
    globalThis.fetch = async (url, options) => {
      const target = new URL(url);
      if (target.origin === 'https://api.cloudflare.com') {
        assert.equal(options.method, 'PUT');
        assert.equal(options.headers.Authorization, 'Bearer fixture-token');
        const key = target.pathname.split('/objects/')[1];
        assert.ok(target.pathname.startsWith(`/client/v4/accounts/${'a'.repeat(32)}/r2/buckets/beeline-downloads/objects/`));
        const chunks = [];
        for await (const chunk of options.body) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        assert.equal(options.headers['Content-Length'], String(bytes.length));
        objects.set(key, bytes);
        uploads.push(key);
        return Response.json({ success: true });
      }
      assert.equal(target.origin, 'https://downloads.usebeeline.app');
      assert.ok(target.searchParams.has('channel_check'));
      const bytes = objects.get(target.pathname.slice(1));
      return new Response(bytes, { status: bytes ? 200 : 404 });
    };
    const github = { rest: { repos: {
      async getReleaseByTag({ tag }) { if (!releases.has(tag)) throw Object.assign(Error('missing'), { status: 404 }); return { data: releases.get(tag) }; },
      async createRelease(input) { const data = { ...input, id: id++, assets: [] }; releases.set(input.tag_name, data); return { data }; },
      async deleteReleaseAsset({ asset_id }) { assets.delete(asset_id); for (const release of releases.values()) release.assets = release.assets.filter(asset => asset.id !== asset_id); },
      async uploadReleaseAsset({ release_id, name, data }) { const asset = { id: id++, name }; assets.set(asset.id, data); [...releases.values()].find(release => release.id === release_id).assets.push(asset); },
    } } };
    // Execute the actual github-script publication step with local fixture bytes.
    const run = new (Object.getPrototypeOf(async function () {}).constructor)('github', 'core', 'context', publish.with.script);
    const channelManifests = [];
    for (const channel of ['latest', 'next']) {
      const sha = 'a'.repeat(40);
      const version = channel === 'next' ? 'v0.1.2-rc.1' : 'v0.1.1';
      const { manifest, bytes, files } = await helperFixture(directory, version, sha);
      Object.assign(process.env, {
        GITHUB_WORKSPACE: process.cwd(), BUNDLE_DIR: directory, CHANNEL: channel, RELEASE_SHA: sha, RELEASE_VERSION: version,
        CLOUDFLARE_R2_TOKEN: 'fixture-token', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
      });
      await run(github, {}, { repo: { owner: 'Beeline-Work', repo: 'beeline' } });
      const prefix = channel === 'next' ? 'dl/next/' : 'dl/';
      assert.deepEqual(uploads.splice(0), files.map(file => `${prefix}${file}`));
      const backup = releases.get(`helper-update-channel${channel === 'next' ? '-next' : ''}`);
      assert.deepEqual(backup.assets.map(asset => asset.name), files);
      for (const asset of backup.assets) assert.deepEqual(assets.get(asset.id), objects.get(`${prefix}${asset.name}`));
      channelManifests.push([channel, manifest, bytes]);
    }
    // All verification requests take the canonical route; the Worker alone
    // reads R2. GitHub is deliberately unavailable to public downloaders.
    const upstreamFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => new URL(url).origin === 'https://usebeeline.app'
      ? serveDownloads(new Request(url, options), upstreamFetch) : upstreamFetch(url, options);
    for (const [channel, expected, bytes] of channelManifests) {
      const path = `/dl/${channel === 'next' ? 'next/' : ''}`;
      assert.deepEqual(await (await worker.fetch(request(`${path}manifest.json`))).json(), expected);
      assert.deepEqual(Buffer.from(await (await worker.fetch(request(`${path}beeline-linux-x64.tar.gz`))).arrayBuffer()), bytes);
      const result = await verifyPagesUpdate({ manifestUrl: `https://usebeeline.app${path}manifest.json`,
        expectedManifest: expected, workDir: join(directory, 'proof') });
      assert.equal(result.version, expected.version);
    }
    const workflow = await yaml('.github/workflows/unified-release.yml');
    const promote = workflow.jobs.helper.steps.find(step => step.with?.phase === 'promote');
    assert.equal(promote.env.CLOUDFLARE_R2_TOKEN, '${{ secrets.CLOUDFLARE_R2_TOKEN }}');
    assert.equal(promote.env.CLOUDFLARE_ACCOUNT_ID, '${{ vars.CLOUDFLARE_ACCOUNT_ID }}');
    assert.equal(workflow.jobs.helper.permissions.pages, undefined);
    assert.equal(workflow.jobs.helper.environment, undefined);
    assert.equal(workflow.jobs.helper.steps.some(step => step.uses?.includes('pages-leg')), false);
    assert.equal(workflow.jobs.website.steps.find(step => step.uses?.includes('pages-leg')).if, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('website publication excludes every download while preserving installers and association files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'static-pages-'));
  try {
    const action = await yaml('.github/actions/pages-leg/action.yml');
    assert.match(action.runs.steps[0].run, /release-steps\/pages-leg\.sh/);
    assert.match(await readFile('packages/scripts/release-steps/pages-leg.sh', 'utf8'), /--static-only/);
    assert.equal(action.runs.steps.some(step => step.with?.script?.includes('downloadPagesChannel')), false);
    await buildPagesSite({ outputRoot: directory, includeDownloads: false });
    await assert.rejects(access(join(directory, 'dl')), { code: 'ENOENT' });
    for (const file of ['index.html', 'install.sh', '.well-known/apple-app-site-association', '.well-known/assetlinks.json']) {
      assert.deepEqual(await readFile(join(directory, file)), await readFile(join('apps/site', file)));
    }
    assert.deepEqual(await readFile(join(directory, 'install')), await readFile('apps/site/install.sh'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import worker, { serveDownloads } from '../infra/helper-downloads/worker.mjs';
import { buildPagesSite } from './pages-site.mjs';

const yaml = async path => parse(await readFile(path, 'utf8'));
const request = (path, init) => new Request(`https://usebeeline.app${path}`, init);

test('preview deployment cannot install the canonical download route', async () => {
  const config = JSON.parse(await readFile('infra/helper-downloads/wrangler.jsonc', 'utf8'));
  assert.deepEqual(config.routes, [{ pattern: 'usebeeline.app/dl/*', zone_name: 'usebeeline.app' }]);
  assert.equal(config.workers_dev, false);
  assert.deepEqual(config.env.preview.routes, []);
  assert.equal(config.env.preview.workers_dev, true);
  assert.equal(config.env.preview.name, 'beeline-helper-downloads-preview');
});

test('both existing channel paths stream public assets without forwarding credentials or redirects', async () => {
  for (const channel of ['', 'next/']) {
    for (const file of ['manifest.json', 'beeline-linux-x64.tar.gz', 'beeline-darwin-arm64.tar.gz',
      'beeline-darwin-x64.tar.gz.sha256', 'beeline-bootstrap.mjs', 'beeline-bootstrap.mjs.sha256']) {
      const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('exact bytes')); controller.close(); } });
      const response = await serveDownloads(request(`/dl/${channel}${file}`, {
        headers: { Authorization: 'secret', Cookie: 'session=secret', Range: 'bytes=0-10' },
      }), async (url, options) => {
        const target = new URL(url);
        assert.equal(target.origin, 'https://github.com');
        assert.equal(target.pathname, `/Beeline-Work/beeline/releases/download/helper-update-channel${channel ? '-next' : ''}/${file}`);
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
      assert.equal(response.headers.get('x-beeline-downloads'), 'github-release');
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
  const environmentKeys = ['GITHUB_WORKSPACE', 'BUNDLE_DIR', 'CHANNEL', 'RELEASE_SHA', 'RELEASE_VERSION'];
  const originalEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  try {
    const action = await yaml('.github/actions/daemon-leg/action.yml');
    assert.equal(action.runs.steps.some(step => /pages-leg|deploy-pages|upload-pages/.test(step.uses ?? step.run ?? '')), false);
    const publish = action.runs.steps.find(step => step.env?.BUNDLE_DIR);
    const releases = new Map(), assets = new Map(); let id = 1;
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
      const bytes = Buffer.from(`verified ${channel} archive`), sha = 'a'.repeat(40);
      const digest = createHash('sha256').update(bytes).digest('hex'), file = 'beeline-linux-x64.tar.gz';
      const version = channel === 'next' ? 'v0.1.2-rc.1' : 'v0.1.1';
      const manifest = { schemaVersion: 1, version, sourceCommit: sha, bundles: { 'linux-x64': { file, sha256: digest, bytes: bytes.length, verified: true, commit: sha, version } } };
      await writeFile(join(directory, file), bytes);
      await writeFile(join(directory, `${file}.sha256`), `${digest}  ${file}\n`);
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
      Object.assign(process.env, {
        GITHUB_WORKSPACE: process.cwd(), BUNDLE_DIR: directory, CHANNEL: channel, RELEASE_SHA: sha, RELEASE_VERSION: version,
      });
      await run(github, {}, { repo: { owner: 'Beeline-Work', repo: 'beeline' } });
      channelManifests.push([channel, manifest, bytes]);
    }
    globalThis.fetch = async url => {
      const [, tag, name] = new URL(url).pathname.match(/\/download\/([^/]+)\/([^/]+)$/);
      const asset = releases.get(tag).assets.find(asset => asset.name === name);
      return new Response(assets.get(asset.id));
    };
    for (const [channel, expected, bytes] of channelManifests) {
      const path = `/dl/${channel === 'next' ? 'next/' : ''}`;
      assert.deepEqual(await (await worker.fetch(request(`${path}manifest.json`))).json(), expected);
      assert.deepEqual(Buffer.from(await (await worker.fetch(request(`${path}beeline-linux-x64.tar.gz`))).arrayBuffer()), bytes);
    }
    const workflow = await yaml('.github/workflows/unified-release.yml');
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
    assert.match(await readFile('scripts/release-steps/pages-leg.sh', 'utf8'), /--static-only/);
    assert.equal(action.runs.steps.some(step => step.with?.script?.includes('downloadPagesChannel')), false);
    await buildPagesSite({ outputRoot: directory, includeDownloads: false });
    await assert.rejects(access(join(directory, 'dl')), { code: 'ENOENT' });
    for (const file of ['index.html', 'install.sh', '.well-known/apple-app-site-association', '.well-known/assetlinks.json']) {
      assert.deepEqual(await readFile(join(directory, file)), await readFile(join('web', file)));
    }
    assert.deepEqual(await readFile(join(directory, 'install')), await readFile('web/install.sh'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { publishDesktopR2 } from './desktop-r2.mjs';
import { createDesktopUpdateManifest } from './desktop-update.mjs';
import { buildPagesSite } from './pages-site.mjs';
import { localHooks } from './release-local.mjs';

const root = resolve(import.meta.dirname, '..');
const origin = 'https://downloads.usebeeline.app';
const tag = 'v1.2.3';
const accountId = 'a'.repeat(32);
const installers = ['Beeline-universal.dmg', 'Beeline-universal.app.tar.gz',
  'Beeline-x86_64.AppImage', 'Beeline-x86_64-setup.exe', 'Beeline-x86_64.msi',
  'Beeline-x86_64.deb', 'Beeline-x86_64.rpm'];
const signed = ['Beeline-universal.app.tar.gz', 'Beeline-x86_64.AppImage', 'Beeline-x86_64-setup.exe'];
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'beeline-r2-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of installers) await writeFile(join(directory, file), `installer:${file}`);
  for (const file of signed) await writeFile(join(directory, `${file}.sig`), `signature:${file}`);
  const manifest = createDesktopUpdateManifest({ directory, version: '1.2.0', releaseTag: tag,
    repository: 'Beeline-Work/beeline', publishedAt: '2026-11-13T00:00:00Z' });
  const manifestPath = join(directory, 'input.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { directory, manifest, manifestPath, output: join(directory, 'Beeline-latest.json'), tag, accountId, token: 'fixture-token' };
}

test('Pages copies the desktop module with R2 download links', async t => {
  const { directory } = await fixture(t);
  await buildPagesSite({ outputRoot: join(directory, 'site'), includeDownloads: false });
  const module = await readFile(join(directory, 'site/desktop-download.mjs'), 'utf8');
  assert.match(module, /const RELEASE_ROOT = 'https:\/\/downloads.usebeeline.app\/latest'/);
  assert.doesNotMatch(module, /github.com/);
  const html = await readFile(join(directory, 'site/index.html'), 'utf8');
  assert.doesNotMatch(html, /github.com\/Beeline-Work\/beeline\/releases\/latest\/download/);
  for (const file of ['Beeline-universal.dmg', 'Beeline-x86_64-setup.exe', 'Beeline-x86_64.AppImage']) {
    assert.ok(html.includes(`${origin}/latest/${file}`));
  }
});

test('production build CLI preserves endpoint priority from the desktop workflow', async t => {
  const { output } = await fixture(t);
  const workflow = parse(await readFile(join(root, '.github/workflows/desktop.yml'), 'utf8'));
  const script = workflow.jobs.build.steps.find(step => step.name === 'Prepare the signed production updater configuration').run;
  const endpoints = [...script.matchAll(/--endpoint '([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(endpoints, [`${origin}/latest/Beeline-latest.json`,
    'https://github.com/Beeline-Work/beeline/releases/latest/download/Beeline-latest.json']);
  execFileSync(process.execPath, [join(root, 'scripts/desktop-update.mjs'), 'config', '--version', '1.2.3',
    ...endpoints.flatMap(endpoint => ['--endpoint', endpoint]), '--output', output], {
    env: { ...process.env, TAURI_UPDATER_PUBLIC_KEY: 'fixture-public-key' },
  });
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')).plugins.updater.endpoints, endpoints);
});

test('R2 publishes all installers and signatures to both prefixes, with manifests last', async t => {
  const args = await fixture(t), calls = [];
  for (const entry of Object.values(args.manifest.platforms)) {
    assert.ok(entry.url.startsWith(`${origin}/${tag}/`));
  }
  // Exercise the local recovery case: old manifest URLs must also move.
  for (const entry of Object.values(args.manifest.platforms)) entry.url = entry.url.replace(`${origin}/${tag}`, 'https://github.com/Beeline-Work/beeline/releases/download/v1.1.0');
  await writeFile(args.manifestPath, JSON.stringify(args.manifest));
  await writeFile(join(args.directory, 'unrelated.txt'), 'do not upload');
  const published = await publishDesktopR2({ ...args, fetchImpl: async (url, request) => {
    const chunks = [];
    for await (const chunk of request.body) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    assert.equal(request.method, 'PUT');
    assert.equal(request.headers.Authorization, 'Bearer fixture-token');
    assert.equal(request.headers['Content-Length'], String(bytes.length));
    calls.push({ key: url.split('/objects/')[1], bytes, type: request.headers['Content-Type'] });
    return Response.json({ success: true });
  } });
  const files = [...installers, ...signed.map(file => `${file}.sig`)].sort();
  assert.deepEqual(calls.map(call => call.key), [tag, 'latest'].flatMap(prefix =>
    [...files, 'Beeline-latest.json'].map(file => `${prefix}/${file}`)));
  for (const call of calls) {
    const file = call.key.split('/')[1];
    assert.deepEqual(call.bytes, await readFile(join(args.directory, file)));
    if (file.endsWith('.json')) assert.equal(call.type, 'application/json');
  }
  assert.equal(published.version, args.manifest.version);
  for (const [platform, entry] of Object.entries(published.platforms)) {
    assert.equal(entry.signature, args.manifest.platforms[platform].signature);
    assert.ok(entry.url.startsWith(`${origin}/${tag}/`));
  }
});

test('R2 upload failure stops immediately without retrying or advancing latest', async t => {
  for (const response of [new Response('', { status: 403 }), Response.json({ success: false })]) {
    const args = await fixture(t), calls = [];
    await assert.rejects(publishDesktopR2({ ...args, fetchImpl: async url => {
      calls.push(url);
      return response;
    } }), /R2 upload failed/);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes(`/objects/${tag}/`));
  }
});

test('unified publication invokes R2 for built and carried sets, and local recovery retains that step', async () => {
  const workflow = parse(await readFile(join(root, '.github/workflows/unified-release.yml'), 'utf8'));
  const step = Object.values(workflow.jobs).flatMap(job => job.steps || [])
    .find(step => step.name === 'Publish the one GitHub release record with its release.json and stable desktop downloads');
  assert.equal(step.env.CLOUDFLARE_R2_TOKEN, '${{ secrets.CLOUDFLARE_R2_TOKEN }}');
  assert.equal(step.env.CLOUDFLARE_ACCOUNT_ID, '${{ vars.CLOUDFLARE_ACCOUNT_ID }}');
  assert.ok(step.run.indexOf('gh release download') < step.run.indexOf('node scripts/desktop-r2.mjs'));
  assert.ok(step.run.indexOf('node scripts/desktop-r2.mjs') < step.run.indexOf('ghr_publish "$RELEASE_VERSION"'));
  const handled = await localHooks(tmpdir(), {}).step({ step, context: { github: { job: 'bookkeeping' } } });
  assert.equal(handled, undefined);
});

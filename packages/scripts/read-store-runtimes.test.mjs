import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStores } from './read-store-runtimes.mjs';

const buildId = '77d880ed-0ed8-4fd8-921f-e78effbcb58d';
const versionsPath = '/v1/apps/6803948500/appStoreVersions?filter[platform]=IOS&include=build&limit=200';
const buildPath = `/v1/builds/${buildId}?include=betaBuildLocalizations`;

async function fixture(run, pins = { android: { runtimeVersion: '53' }, ios: { runtimeVersion: '41' } }) {
  const repository = mkdtempSync(join(tmpdir(), 'ios-source-runtime-'));
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(['init', '--quiet']);
    mkdirSync(join(repository, 'apps/mobile'), { recursive: true });
    writeFileSync(join(repository, 'apps/mobile/native-fingerprint.json'), JSON.stringify(pins));
    git(['add', 'apps/mobile/native-fingerprint.json']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'native build source']);
    const sourceSha = git(['rev-parse', 'HEAD']);
    // A later checkout's pin must never stand in for the uploaded binary's pin.
    writeFileSync(join(repository, 'apps/mobile/native-fingerprint.json'), JSON.stringify({ runtimeVersion: '999' }));
    const marker = `v0.1.230@${sourceSha.slice(0, 12)}`;
    // Shape observed live: READY build 115 is included under a UUID. Local
    // uploads have no EAS entry, and this release has no release.json asset.
    const page = {
      data: [{ type: 'appStoreVersions', id: '469fd755-29c8-46d0-a1ea-f2a69e174ed2',
        attributes: { appVersionState: 'READY_FOR_DISTRIBUTION', versionString: '0.2.27' },
        relationships: { build: { data: { type: 'builds', id: buildId } } } }],
      included: [{ type: 'builds', id: buildId, attributes: { version: '115', processingState: 'VALID' } }],
      links: { self: `https://api.appstoreconnect.apple.com${versionsPath}` },
      meta: { paging: { total: 1, limit: 200 } },
    };
    const detail = {
      data: { ...page.included[0], relationships: { betaBuildLocalizations: {
        data: [{ type: 'betaBuildLocalizations', id: 'notes' }],
      } } },
      included: [{ type: 'betaBuildLocalizations', id: 'notes',
        attributes: { whatsNew: `Beeline release ${marker}`, locale: 'en-US' } }],
    };
    const calls = [];
    const read = (builds = []) => readStores({ builds, repository, env: {}, appleApi: async path => {
      calls.push(path);
      if (path === versionsPath) return page;
      assert.equal(path, buildPath);
      return detail;
    } });
    await run({ page, detail, read, calls, sourceSha, marker });
  } finally { rmSync(repository, { recursive: true, force: true }); }
}

test('local ASC build 115 resolves from its source marker without EAS or release metadata', async () => {
  await fixture(async ({ read, calls, sourceSha, marker }) => {
    const builds = [];
    const stores = await read(builds);
    assert.equal(stores.ios.status, 'readable');
    assert.equal(stores.ios.latestRuntimeVersion, '41');
    assert.deepEqual(stores.ios.buildNumbers, ['115']);
    assert.deepEqual(builds, [{ platform: 'ios', buildNumber: '115', runtimeVersion: '41',
      evidence: `ASC build ${buildId}; source-commit derived from ${marker} (${sourceSha})` }]);
    assert.equal(stores.ios.live[0].evidence, builds[0].evidence);
    assert.deepEqual(calls, [versionsPath, buildPath], 'one observation, no retries or polling');
  });
});

test('recorded iOS runtime wins without a source lookup', async () => {
  await fixture(async ({ read, calls }) => {
    const stores = await read([{ platform: 'ios', buildNumber: '115', runtimeVersion: '40' }]);
    assert.equal(stores.ios.latestRuntimeVersion, '40');
    assert.deepEqual(calls, [versionsPath]);
  });
});

test('conflicting recorded iOS runtimes remain unprovable', async () => {
  await fixture(async ({ read, calls }) => {
    const stores = await read(['40', '41'].map(runtimeVersion => ({ platform: 'ios', buildNumber: '115', runtimeVersion })));
    assert.equal(stores.ios.status, 'unavailable');
    assert.match(stores.ios.unknownRuntime, /ios store build 115.*conflicting/);
    assert.deepEqual(calls, [versionsPath]);
  });
});

test('legacy READY_FOR_SALE and replaced ASC versions can recover source runtime evidence', async () => {
  for (const state of ['READY_FOR_SALE', 'REPLACED_WITH_NEW_VERSION']) {
    await fixture(async ({ page, read }) => {
      page.data[0].attributes = { appStoreState: state };
      const stores = await read();
      assert.equal(stores.ios.status, 'readable');
      const records = state === 'REPLACED_WITH_NEW_VERSION' ? stores.ios.historical : stores.ios.live;
      assert.equal(records[0].runtimeVersion, '41');
    });
  }
});

test('source fallback rejects absent, malformed, unavailable or conflicting release markers', async () => {
  for (const notes of ['', 'Beeline release v0.1.230@../../secret', 'Beeline release v0.1.230@000000000000',
    'prefix Beeline release v0.1.230@dab6af48f030']) {
    await fixture(async ({ detail, read, calls }) => {
      detail.included[0].attributes.whatsNew = notes;
      const stores = await read();
      assert.equal(stores.ios.status, 'unavailable');
      assert.match(stores.ios.unknownRuntime, /Cannot prove runtime of ios store build 115/);
      assert.deepEqual(calls, [versionsPath, buildPath]);
    });
  }
  await fixture(async ({ detail, read }) => {
    detail.data.relationships.betaBuildLocalizations.data.push({ type: 'betaBuildLocalizations', id: 'other' });
    detail.included.push({ type: 'betaBuildLocalizations', id: 'other',
      attributes: { whatsNew: 'Beeline release v0.1.231@000000000000' } });
    assert.match((await read()).ios.unknownRuntime, /no unique source release marker/);
  });
});

test('source fallback rejects a mismatched ASC identity and unrelated included notes', async () => {
  for (const mutate of [
    detail => { detail.data.id = 'different-build'; },
    detail => { detail.data.attributes = { version: '116' }; },
    detail => { detail.data.type = 'apps'; },
    detail => { detail.data.relationships.betaBuildLocalizations.data = []; },
  ]) {
    await fixture(async ({ detail, read }) => {
      mutate(detail);
      assert.match((await read()).ios.unknownRuntime, /Cannot prove runtime of ios store build 115/);
    });
  }
});

test('source fallback rejects nonnumeric source pins', async () => {
  await fixture(async ({ read }) => {
    assert.match((await read()).ios.unknownRuntime, /ios store build 115.*invalid runtime/);
  }, { android: { runtimeVersion: '53' }, ios: { runtimeVersion: 'policy' } });
});

test('Play beta still resolves a missing runtime from the generated APK', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const requests = [];
  const stores = await readStores({
    env: { BEELINE_RELEASE_CHANNEL: 'next', GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({
      type: 'service_account', client_email: 'fixture@example.test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }) },
    appleApi: async () => ({ data: [] }),
    playRuntime: async number => { requests.push(number); return '53'; },
    fetchImpl: async (url, options) => {
      if (url.includes('oauth2')) return Response.json({ access_token: 'fixture' });
      if (options.method === 'POST') return Response.json({ id: 'fixture-edit' });
      if (options.method === 'DELETE') return new Response(null, { status: 204 });
      const track = url.split('/').at(-1);
      return Response.json({ track, releases: track === 'beta' ? [{ status: 'completed', versionCodes: ['165'] }] : [] });
    },
  });
  assert.deepEqual(requests, ['165']);
  assert.equal(stores.android.betaLive[0].runtimeVersion, '53');
  assert.equal(stores.android.betaLive[0].evidence, 'Play generated APK native manifest');
});

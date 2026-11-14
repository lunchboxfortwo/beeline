import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appStoreClient } from './ios-store-build.mjs';
import { mintAccessToken } from './play-token.mjs';
import { readPlayRuntime, easBuildInventory } from './store-build-runtime.mjs';
import { playLiveBuilds, resolveStoreBuilds } from '../apps/mobile/scripts/store-runtime-targets.mjs';

function newestBuildFirst(a, b) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (right[i] ?? 0) - (left[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

async function publishedWindow(platform, numbers, historicalNumbers, builds, resolveRuntime) {
  const ordered = [...new Set([...numbers, ...historicalNumbers])].sort(newestBuildFirst);
  const records = [], runtimes = new Set();
  for (const number of ordered) {
    let target;
    try { target = resolveStoreBuilds(platform, [number], builds)[0]; }
    catch (error) {
      if (!resolveRuntime) throw error;
      try {
        const runtimeVersion = await resolveRuntime(number);
        if (!/^\d+$/.test(runtimeVersion)) throw new Error('invalid runtime');
        target = { platform, buildNumber: number, runtimeVersion, evidence: 'Play generated APK native manifest' };
        builds.push(target);
      } catch (cause) {
        error.message += `: ${cause.message}`;
        throw error;
      }
    }
    records.push(target);
    runtimes.add(target.runtimeVersion);
    // Unknown identities inside this window still fail closed. Older ASC
    // versions cannot change the newest three distinct published runtimes.
    if (runtimes.size === 3) break;
  }
  return records;
}

// Use the same Android package as app.config.js and the Play upload workflow.
// https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks/get
async function readPlayTrack(track, token, fetchImpl) {
  const base = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/app.usebeeline';
  const call = async (method, path) => {
    const url = `${base}${path}`;
    const response = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: '{}' } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const context = `Play ${track} ${method} ${url} HTTP ${response.status}`;
    let body;
    try { body = await response.text(); }
    catch { throw new Error(`${context}: response body read failed`); }
    if (!response.ok) throw new Error(context);
    // edits.delete may return an empty success body. Reads must contain JSON.
    if (method === 'DELETE' && !body.trim()) return;
    if (!body.trim()) throw new Error(`${context}: empty response body`);
    try { return JSON.parse(body); }
    catch {
      throw new Error(`${context}: invalid JSON (${response.headers.get('content-type') ?? 'unknown content type'}, ${body.length} characters)`);
    }
  };
  const edit = await call('POST', '/edits');
  if (typeof edit?.id !== 'string' || !edit.id) throw new Error(`Play ${track} edits.insert returned no edit id`);
  const path = `/edits/${encodeURIComponent(edit.id)}`;
  let readError;
  try {
    return playLiveBuilds(await call('GET', `${path}/tracks/${track}`), track);
  } catch (error) {
    readError = error;
    throw error;
  } finally {
    // Never commit the observation edit, including after a malformed read.
    try { await call('DELETE', path); }
    catch (error) { if (!readError) throw error; }
  }
}

export async function readStores({ builds = [], previouslyLive = [], env = process.env, fetchImpl = fetch, appleApi, playRuntime = readPlayRuntime } = {}) {
  const stores = {};
  await Promise.all(['android', 'ios'].map(async platform => {
    let numbers = [];
    let playToken;
    const historicalNumbers = previouslyLive.filter(build => build.platform === platform && build.buildNumber).map(build => String(build.buildNumber));
    try {
      if (platform === 'android') {
        playToken = await mintAccessToken(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, { fetchImpl });
        numbers = [...new Set(await readPlayTrack('production', playToken, fetchImpl))];
      } else {
        const appleEnv = env.EXPO_ASC_API_KEY_P8?.includes('-----BEGIN')
          ? { ...env, EXPO_ASC_API_KEY_P8: Buffer.from(env.EXPO_ASC_API_KEY_P8).toString('base64') } : env;
        const api = appleApi ?? appStoreClient(appleEnv, fetchImpl);
        let path = '/v1/apps/6803948500/appStoreVersions?filter[platform]=IOS&include=build&limit=200';
        numbers = [];
        while (path) {
          const page = await api(path);
          if (!Array.isArray(page?.data)) throw new Error('Unreadable App Store versions');
          for (const version of page.data) {
            const state = version.attributes?.appVersionState ?? version.attributes?.appStoreState;
            if (!['READY_FOR_DISTRIBUTION', 'READY_FOR_SALE', 'REPLACED_WITH_NEW_VERSION'].includes(state)) continue;
            const id = version.relationships?.build?.data?.id;
            const build = page.included?.find(b => b.type === 'builds' && b.id === id);
            if (!build?.attributes?.version) {
              const error = new Error(`Cannot prove runtime of ios store build ${id ?? '(missing build identity)'}`);
              error.code = 'UNKNOWN_STORE_RUNTIME';
              throw error;
            }
            (state === 'REPLACED_WITH_NEW_VERSION' ? historicalNumbers : numbers).push(build.attributes.version);
          }
          path = page.links?.next ? new URL(page.links.next).pathname + new URL(page.links.next).search : null;
        }
      }
      const observedAt = new Date().toISOString();
      const resolved = await publishedWindow(platform, numbers, historicalNumbers, builds,
        platform === 'android' ? number => playRuntime(number, playToken, { fetchImpl }) : undefined);
      const live = resolved.filter(t => numbers.includes(t.buildNumber)).map(t => ({ ...t, observedLiveAt: observedAt }));
      const historical = resolved.filter(t => !numbers.includes(t.buildNumber)).map(t => ({ ...t, publicationEvidence: platform === 'ios' ? 'ASC REPLACED_WITH_NEW_VERSION' : 'previous Play production observation', observedAt }));
      const newest = [...live].sort((a, b) => newestBuildFirst(a.buildNumber, b.buildNumber))[0];
      stores[platform] = { status: 'readable', live, historical, latestRuntimeVersion: newest?.runtimeVersion, buildNumbers: numbers };
    } catch (error) {
      stores[platform] = { status: 'unavailable', unknownRuntime: error.code === 'UNKNOWN_STORE_RUNTIME' ? error.message : undefined,
        reason: platform === 'android' ? `Play production runtime lookup failed: ${error.message}` : error.message,
        buildNumbers: numbers, historicalBuildNumbers: historicalNumbers };
    }
    // Beta is an additional audience, not the production retention anchor.
    // Read it even if production failed; neither track can discard the other
    // track's verified runtimes. A failed observation retains recorded targets.
    if (platform === 'android' && env.BEELINE_RELEASE_CHANNEL === 'next' && playToken) {
      try {
        const betaNumbers = await readPlayTrack('beta', playToken, fetchImpl);
        stores.android.betaLive = (await publishedWindow('android', betaNumbers, [], builds,
          number => playRuntime(number, playToken, { fetchImpl })))
          .map(target => ({ ...target, observedLiveAt: new Date().toISOString() }));
      } catch (error) {
        if (error.code === 'UNKNOWN_STORE_RUNTIME') stores.android.unknownRuntime = error.message;
        stores.android.warnings = [`Play beta runtime lookup failed: ${error.message}`];
      }
    }
  }));
  return stores;
}

async function main() {
  const previous = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : {};
  const builds = [...(previous.builds ?? []), ...(previous.previouslyLive ?? []).filter(build => build.buildNumber)];
  try { builds.push(...await easBuildInventory()); } catch { /* Missing identities fail closed when selected. */ }
  const previouslyLive = previous.previouslyLive ?? [];
  const stores = await readStores({ builds, previouslyLive });
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), stores, builds, previouslyLive }));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

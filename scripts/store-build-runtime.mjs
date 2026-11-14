import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Play's track/bundle APIs expose version codes, not Expo's custom runtime.
// Read the native stamp in Play's generated base APK when no upload record exists.
// https://developers.google.com/android-publisher/api-ref/rest/v3/generatedapks/list
export async function readPlayRuntime(buildNumber, token, { fetchImpl = fetch, inspect = apkRuntime } = {}) {
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/app.usebeeline/generatedApks/${encodeURIComponent(buildNumber)}`;
  const get = async url => {
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Play generated APK HTTP ${response.status}`);
    return response;
  };
  const metadata = await (await get(base)).json();
  const keys = metadata.generatedApks ?? [];
  // Variant 1 is Play's archived-app stub; the newest variant carries the real manifest.
  const apk = keys.flatMap(key => key.generatedSplitApks ?? []).filter(apk => apk.moduleName === 'base' && !apk.splitId)
    .sort((a, b) => b.variantId - a.variantId)[0]
    ?? keys.find(key => key.generatedUniversalApk)?.generatedUniversalApk
    ?? keys.flatMap(key => key.generatedStandaloneApks ?? [])[0];
  if (!apk?.downloadId) throw new Error('Play has no downloadable base APK');
  const bytes = Buffer.from(await (await get(`${base}/downloads/${encodeURIComponent(apk.downloadId)}:download?alt=media`)).arrayBuffer());
  return inspect(bytes);
}

export function runtimeFromApkDump(manifest, resources) {
  const metadata = manifest.split(/\n(?=\s*E: )/).find(block => block.includes('expo.modules.updates.EXPO_RUNTIME_VERSION'));
  const value = metadata?.match(/android:value[^=]*=([^\n]+)/)?.[1];
  const literal = value?.match(/(?:Raw: |^)"(\d+)"/)?.[1];
  if (literal) return literal;
  const reference = value?.match(/@(0x[0-9a-f]+)/i)?.[1];
  const resource = reference && resources.split(/\n(?=\s*resource )/).find(block => new RegExp(`resource ${reference}\\b`, 'i').test(block));
  const runtime = resource?.match(/\(\) "(\d+)"/)?.[1];
  if (!runtime) throw new Error('APK has no numeric Expo runtime stamp');
  return runtime;
}

function apkRuntime(bytes) {
  const directory = mkdtempSync(join(tmpdir(), 'beeline-store-apk-'));
  try {
    const path = join(directory, 'base.apk');
    writeFileSync(path, bytes, { mode: 0o600 });
    const dump = args => execFileSync('aapt2', ['dump', ...args, path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return runtimeFromApkDump(dump(['xmltree', '--file', 'AndroidManifest.xml']), dump(['resources']));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

// EAS records the embedded runtime at build/upload time. ASC supplies the exact
// distributed build identity; its public API does not expose Expo.plist.
export async function easBuildInventory(env = process.env, fetchImpl = fetch) {
  if (!env.EXPO_TOKEN) return [];
  const builds = [];
  for (let offset = 0; ; offset += 100) {
    const response = await fetchImpl('https://api.expo.dev/graphql', {
      method: 'POST', headers: { Authorization: `Bearer ${env.EXPO_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `query { app { byId(appId:"58f1e94e-5ce5-475e-9dde-3eaa9e36699c") { builds(limit:100,offset:${offset}) { platform appBuildVersion runtimeVersion } } } }` }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`EAS build inventory HTTP ${response.status}`);
    const page = (await response.json()).data?.app?.byId?.builds;
    if (!Array.isArray(page)) throw new Error('Unreadable EAS build inventory');
    builds.push(...page.filter(build => build.appBuildVersion && /^\d+$/.test(build.runtimeVersion)));
    if (page.length < 100) return builds;
  }
}

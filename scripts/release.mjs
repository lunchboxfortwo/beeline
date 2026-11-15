#!/usr/bin/env node
// One operator command: current main -> next -> latest. Nothing dispatches CI.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function releaseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-store') options.noStore = true;
    else if (argv[i] === '--dispatched-by' && i + 1 < argv.length) options.dispatchedBy = JSON.parse(argv[++i]);
    else throw new Error('Usage: node scripts/release.mjs [--no-store] [--dispatched-by <JSON>]');
  }
  return options;
}

// Store binaries are needed when a platform's pinned native runtime is not the
// newest one live in its production store: phones on the store build cannot
// take an OTA for the new runtime. An unreadable store counts as needed.
export function pinnedRuntimes(appConfig) {
  const pin = platform => new RegExp(`\\b${platform}: \\{[^]*?runtimeVersion: runtimeVersionOverride \\|\\| "(\\d+)"`).exec(appConfig)?.[1];
  return { android: pin('android'), ios: pin('ios') };
}

export function storeReleaseNeeded(pins, stores) {
  return ['android', 'ios'].some(platform => stores[platform]?.status !== 'readable'
    || stores[platform].latestRuntimeVersion !== pins[platform]);
}

export function localAttribution({ username = userInfo().username || 'firstmate', now = new Date() } = {}) {
  const id = `squire-release-${now.toISOString()}`;
  return { agentId: username, handle: username, place: 'squire', humanCommandMessageId: id, auditMessageId: id };
}

export function acquireReleaseLock(lock, directory, { alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
} } = {}) {
  if (existsSync(lock)) {
    if (statSync(lock).uid !== process.getuid()) throw new Error('Release lock belongs to another user');
    const pid = Number(readFileSync(join(lock, 'owner'), 'utf8').split('\n')[0]);
    if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) throw new Error('A local release is already active');
    rmSync(lock, { recursive: true });
  }
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'owner'), `${process.pid}\n${directory}\n`, { mode: 0o600 });
  return () => rmSync(lock, { recursive: true });
}

export function prepareReleaseSource(repository, directory, run = execFileSync) {
  const git = (args, cwd = repository) => run('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const source = join(directory, 'source');
  const origin = git(['remote', 'get-url', 'origin']);
  git(['clone', '--quiet', '--no-checkout', '--no-hardlinks', repository, source]);
  git(['remote', 'set-url', 'origin', origin], source);
  git(['fetch', '--tags', 'origin'], source);
  const sha = git(['rev-parse', 'refs/remotes/origin/main'], source);
  git(['checkout', '--quiet', '--detach', sha], source);
  git(['branch', '--force', 'main', sha], source);
  return { source, sha };
}

export async function readOtaVersions(env, fetchImpl = fetch) {
  const versions = [];
  for (let offset = 0; ; offset += 100) {
    const response = await fetchImpl('https://api.expo.dev/graphql', {
      method: 'POST', headers: { Authorization: `Bearer ${env.EXPO_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `query { app { byId(appId:"58f1e94e-5ce5-475e-9dde-3eaa9e36699c") { updateBranches(limit:100,offset:${offset}) { name } } } }` }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`OTA branch inventory HTTP ${response.status}`);
    const page = (await response.json()).data?.app?.byId?.updateBranches;
    if (!Array.isArray(page)) throw new Error('Unreadable OTA branch inventory');
    versions.push(...page.map(branch => /^release-(v\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?)$/.exec(branch.name)?.[1]).filter(Boolean));
    if (page.length < 100) return versions;
  }
}

// Next is the OTA beta only; store binaries go to production, with latest.
// The release list is empty during the outage, so each leg finds the previous
// release through git tags. Latest must see the tag Next just created.
const fetchTags = source => execFileSync('git', ['fetch', '--tags', 'origin'], { cwd: source, stdio: 'ignore' });

export async function releaseSequence({ source, sha, directory, secrets, dispatchedBy, otaVersions, store }, runLocalRelease, refreshTags = fetchTags) {
  for (const channel of ['next', 'latest']) {
    if (channel === 'latest') refreshTags(source);
    await runLocalRelease({ mode: 'execute', channel, 'release-sha': sha,
      'state-dir': join(directory, channel), 'dispatched-by': JSON.stringify(dispatchedBy),
      'store-track': channel === 'latest' && store ? 'production' : 'none', otaVersions,
    }, { repository: source, secrets });
  }
}

// Every release leaves full source copies, overlay layers and node_modules in its
// state directory (hundreds of GB over a day). Logs and records stay.
export function pruneReleaseWorkspaces(directory, run = execFileSync) {
  run('sudo', ['-n', 'find', directory, '-type', 'd', '(', '-name', 'source', '-o', '-name', 'upper', '-o', '-name', 'overlay-work',
    '-o', '-name', 'merged', '-o', '-name', 'node_modules', ')', '-prune', '-exec', 'rm', '-rf', '{}', '+'], { stdio: 'ignore' });
}

async function main(argv) {
  const options = releaseArguments(argv);
  const directory = mkdtempSync(join(tmpdir(), 'beeline-release-'));
  const unlock = acquireReleaseLock(join(tmpdir(), `beeline-unified-release-${userInfo().uid}.lock`), directory);
  try {
    const { source, sha } = prepareReleaseSource(root, directory);
    execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: source, stdio: 'inherit' });
    const { loadEnvironment, attribution, runLocalRelease } = await import(pathToFileURL(join(source, 'scripts/release-local.mjs')));
    const secrets = loadEnvironment(join(homedir(), '.config/beeline-release.env'), source);
    const dispatchedBy = attribution(JSON.stringify(options.dispatchedBy ?? localAttribution()));
    const otaVersions = await readOtaVersions(secrets);
    let store = false;
    if (!options.noStore) {
      const { readStores } = await import(pathToFileURL(join(source, 'scripts/read-store-runtimes.mjs')));
      const { easBuildInventory } = await import(pathToFileURL(join(source, 'scripts/store-build-runtime.mjs')));
      const stores = await readStores({ builds: await easBuildInventory(secrets).catch(() => []), env: secrets });
      store = storeReleaseNeeded(pinnedRuntimes(readFileSync(join(source, 'apps/mobile/app.config.js'), 'utf8')), stores);
    }
    console.log(store ? 'Store release: production; a pinned native runtime is not live in its store.' : 'Store release: none.');
    await releaseSequence({ source, sha, directory, secrets, dispatchedBy, otaVersions, store }, runLocalRelease);
    console.log(`Released ${sha} to next and latest${store ? ' with production store builds' : ''}. Private results: ${directory}`);
  } finally {
    try { pruneReleaseWorkspaces(directory); } catch { /* leftovers are retried by the next release's own prune */ }
    unlock();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}

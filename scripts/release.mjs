#!/usr/bin/env node
// One operator command: current main -> next -> latest. Nothing dispatches CI.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function releaseArguments(argv) {
  if (!argv.length) return {};
  if (argv.length === 2 && argv[0] === '--dispatched-by') return { dispatchedBy: JSON.parse(argv[1]) };
  throw new Error('Usage: node scripts/release.mjs [--dispatched-by <JSON>]');
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

export async function releaseSequence({ source, sha, directory, secrets, dispatchedBy, otaVersions }, runLocalRelease) {
  for (const channel of ['next', 'latest']) {
    await runLocalRelease({ mode: 'execute', channel, 'release-sha': sha,
      'state-dir': join(directory, channel), 'dispatched-by': JSON.stringify(dispatchedBy),
      'store-track': channel === 'next' ? 'beta' : 'production', otaVersions,
    }, { repository: source, secrets });
  }
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
    await releaseSequence({ source, sha, directory, secrets, dispatchedBy, otaVersions }, runLocalRelease);
    console.log(`Released ${sha} to next and latest. Private results: ${directory}`);
  } finally { unlock(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}

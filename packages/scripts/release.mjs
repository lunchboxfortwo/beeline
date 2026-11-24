#!/usr/bin/env node
// Deliver current main to next, or promote the published next on owner command.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnvironment } from './release-local-process.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function releaseArguments(argv) {
  const options = {};
  const usage = 'Usage: node packages/scripts/release.mjs [--promote --dispatched-by <JSON>] [--skip-full-checks <owner message id>] [--desktop-mode build] [--mac-helpers build|carry]';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skip-full-checks' && argv[i + 1]?.trim() && !argv[i + 1].startsWith('--')) options.skipFullChecks = argv[++i].trim();
    else if (argv[i] === '--promote') options.promote = true;
    else if (argv[i] === '--no-store') options.noStore = true;
    else if (argv[i] === '--desktop-mode' && argv[i + 1] === 'build') options.desktopMode = argv[++i];
    else if (argv[i] === '--mac-helpers' && ['build', 'carry'].includes(argv[i + 1])) options.macHelpers = argv[++i];
    else if (argv[i] === '--dispatched-by' && i + 1 < argv.length) options.dispatchedBy = JSON.parse(argv[++i]);
    else throw new Error(usage);
  }
  if (options.promote && (!options.dispatchedBy || options.skipFullChecks || options.desktopMode || options.macHelpers)) throw new Error(usage);
  return options;
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
  git(['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main'], source);
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

export function dispatchPromotion(dispatchedBy, secrets, run = execFileSync) {
  const started = performance.now();
  const env = { ...process.env, GH_TOKEN: secrets.GITHUB_TOKEN || secrets.GH_TOKEN };
  const repository = 'lunchboxfortwo/beeline';
  const result = run('gh', ['workflow', 'run', 'unified-release.yml', '-R', repository, '--ref', 'main',
    '-f', 'channel=latest', '-f', `dispatched_by=${JSON.stringify(dispatchedBy)}`],
    { env, encoding: 'utf8', timeout: 60_000 }).trim();
  const url = result.match(/https:\/\/github\.com\/lunchboxfortwo\/beeline\/actions\/runs\/(\d+)/);
  if (!url) throw new Error(`Promotion dispatch returned no workflow URL: ${result}`);
  console.log(`Promotion workflow: ${url[0]}`);
  run('gh', ['run', 'watch', url[1], '-R', repository, '--exit-status'], { env, stdio: 'inherit' });
  console.log(`Promotion wall time: ${Math.round((performance.now() - started) / 1000)}s`);
}

export async function releaseSequence({ source, sha, directory, secrets, dispatchedBy, otaVersions,
  desktopMode = 'build', macHelpers = 'build', skipFullChecks }, runLocalRelease) {
  await runLocalRelease({ mode: 'execute', channel: 'next', 'release-sha': sha,
    'state-dir': join(directory, 'next'), 'dispatched-by': JSON.stringify(dispatchedBy),
    'store-track': 'none', otaVersions, 'desktop-mode': desktopMode, 'mac-helpers': macHelpers, skipFullChecks,
  }, { repository: source, secrets });
}

// A finished release keeps only what it published (release.json,
// release-checks.json and the check evidence on its GitHub release). Its working directory holds full
// source copies, overlays, node_modules and logs (tens of GB per release).
export function removeReleaseDirectory(directory, run = execFileSync) {
  run('sudo', ['-n', 'rm', '-rf', directory], { stdio: 'ignore' });
}

// Docker image ownership and retention: docs/release-pipeline.md.
const RELEASE_IMAGES = ['registry.fly.io/beeline-server', 'registry.fly.io/beeline-free-agents'];
const releaseTag = tag => RELEASE_IMAGES.some(repository => tag.startsWith(`${repository}:`));
export function staleReleaseImages(images, sha) {
  const built = images.filter(image => image.sha && (image.tags.length === 0 || image.tags.some(releaseTag)));
  const previous = built.filter(image => image.sha !== sha && image.tags.some(releaseTag))
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))[0]?.sha;
  return built.filter(image => image.sha !== sha && image.sha !== previous)
    .flatMap(image => image.tags.length ? image.tags.filter(releaseTag) : [image.id]);
}

export function removeStaleReleaseImages(sha, run = execFileSync) {
  try {
    const ids = [...new Set(run('docker', ['images', '--all', '--quiet', '--no-trunc', '--filter', 'label=app.usebeeline.release.sha'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\n').filter(Boolean))];
    if (!ids.length) return;
    const images = run('docker', ['image', 'inspect', '--format', '{"id":{{json .Id}},"tags":{{json .RepoTags}},"created":{{json .Created}},"sha":{{json (index .Config.Labels "app.usebeeline.release.sha")}}}', ...ids], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\n').filter(Boolean).map(line => JSON.parse(line))
      .map(image => ({ ...image, tags: image.tags ?? [], sha: image.sha ?? '' }));
    const stale = staleReleaseImages(images, sha);
    // An image still used by a container, or still the parent of a kept image, stays.
    if (stale.length) try { run('docker', ['image', 'rm', ...stale], { stdio: 'ignore' }); } catch { /* in use */ }
  } finally {
    try { run('docker', ['image', 'prune', '-f'], { stdio: 'ignore' }); } catch {}
  }
}

async function main(argv) {
  const options = releaseArguments(argv);
  const directory = mkdtempSync(join(tmpdir(), 'beeline-release-'));
  const unlock = acquireReleaseLock(join(tmpdir(), `beeline-unified-release-${userInfo().uid}.lock`), directory);
  let sha;
  try {
    const secrets = loadEnvironment(join(homedir(), '.config/beeline-release.env'), root);
    if (options.promote) {
      dispatchPromotion(options.dispatchedBy, secrets);
      return;
    }
    const { source, sha: releaseSha } = prepareReleaseSource(root, directory);
    sha = releaseSha;
    execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: source, stdio: 'inherit' });
    const { attribution, runLocalRelease } = await import(pathToFileURL(join(source, 'packages/scripts/release-local.mjs')));
    const dispatchedBy = attribution(JSON.stringify(options.dispatchedBy ?? localAttribution()));
    const otaVersions = await readOtaVersions(secrets);
    await releaseSequence({ source, sha, directory, secrets, dispatchedBy, otaVersions, desktopMode: options.desktopMode, macHelpers: options.macHelpers, skipFullChecks: options.skipFullChecks }, runLocalRelease);
    console.log(`Released ${sha} to next.`);
  } finally {
    // Cleanup never changes the release outcome, whether it succeeded or failed.
    if (sha) try { removeStaleReleaseImages(sha); } catch { /* Docker unavailable */ }
    try {
      if (options.promote) rmSync(directory, { recursive: true });
      else removeReleaseDirectory(directory);
    } catch { /* not removable */ }
    unlock();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}

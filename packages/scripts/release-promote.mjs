import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promotionSource } from './release-channel.mjs';
import { downloadAsset, listIdentityReleases, latestPublished, readPublishedRecord, PROMOTION_RECORD_ASSET } from './release-record.mjs';
import { createR2Uploader } from './r2-client.mjs';
import { preparePagesPromotion } from './deploy-pages.mjs';
import { planOtaPromotion, runEas } from '../../apps/mobile/scripts/ota-release.mjs';

const root = resolve(import.meta.dirname, '../..');
const downloads = 'https://downloads.usebeeline.app';
const helperPlatforms = ['linux-x64', 'darwin-arm64', 'darwin-x64'];
const mobile = join(root, 'apps/mobile');
const desktopPlatforms = ['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64'];
const installers = ['Beeline-universal.dmg', 'Beeline-x86_64.AppImage', 'Beeline-x86_64-setup.exe'];
const parse = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const github = (args, work) => work('gh', args, { encoding: 'utf8', timeout: 120_000 }).trim();

function stageWebsite(record, deployment, pages) {
  // EAS returns the deployment identifier placed after the preview subdomain.
  const url = new URL(deployment.url);
  const match = /^([a-z0-9-]+)--([a-z0-9-]+)\.expo\.app$/.exec(url.hostname);
  if (!match || deployment.identifier !== match[2] || url.protocol !== 'https:' || url.href !== `https://${url.hostname}/`) throw new Error('Invalid EAS Hosting preview URL');
  return { sourceSha: record.sourceSha, version: record.version, webDeployment: match[2], webOrigin: url.origin, pages };
}

// EAS address and signing policy come from Expo's resolved config at next.
// Promotion gives eas-cli that project identity in a private directory so it
// can move pointers without resolving the app's native build plugins.
function stagedEasProject(deployment) {
  const { getConfig } = createRequire(join(mobile, 'package.json'))('@expo/config');
  const { exp } = getConfig(mobile, { skipPlugins: true });
  const projectId = exp.extra?.eas?.projectId;
  if (new URL(deployment.dashboardUrl).pathname !== `/projects/${projectId}/hosting/deployments`)
    throw new Error('EAS Hosting deployment belongs to another project');
  return { name: exp.name, slug: exp.slug, owner: exp.owner, version: exp.version,
    extra: { eas: { projectId } }, ...(exp.updates?.codeSigningCertificate && { updates: {
      codeSigningCertificate: exp.updates.codeSigningCertificate,
    } }) };
}

function prepareEasProject(directory, project) {
  if (!project?.name || !project.slug || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(project.extra?.eas?.projectId ?? ''))
    throw new Error('Missing staged Expo project identity');
  if (project.updates?.codeSigningCertificate) throw new Error('The staged project requires OTA signing credentials');
  const cwd = join(directory, 'eas-project');
  mkdirSync(cwd, { recursive: true });
  write(join(cwd, 'app.json'), { expo: project });
  write(join(cwd, 'package.json'), { name: project.slug, version: project.version, private: true });
  return cwd;
}

export function validateCandidate(next, release, { requestedSha, requestedVersion } = {}) {
  promotionSource(next, requestedSha);
  const { sourceSha, version } = next;
  if (requestedVersion && requestedVersion !== version) throw new Error('Promotion uses the published next version');
  const missing = key => new Error(`${version} lacks ${key} for ${sourceSha}. Publish a complete next candidate first.`);
  if (release?.draft || release?.tag_name !== version) throw missing('a published GitHub release');
  for (const component of ['helper', 'mobile-ota', 'desktop', 'website']) {
    const entry = next.components?.[component];
    if (entry?.sourceSha !== sourceSha || entry.version !== version) throw missing(component);
  }
  const staged = next.staged;
  if (staged?.sourceSha !== sourceSha || staged.version !== version || !/^[a-z0-9-]+$/.test(staged.webDeployment ?? ''))
    throw missing('staged website metadata');
  stageWebsite(next, { url: staged.webOrigin, identifier: staged.webDeployment }, staged.pages);
  if (staged.pages?.sourceSha !== sourceSha || staged.pages.branch !== `next-${version}`) throw missing('a Pages deployment');
  const assets = new Set(release.assets?.map(asset => asset.name));
  for (const asset of ['Beeline-latest.json', ...installers]) {
    if (!assets.has(asset)) throw missing(asset);
  }
  return next;
}

function attribution(text) {
  const value = JSON.parse(text ?? '{}');
  for (const key of ['agentId', 'handle', 'place', 'humanCommandMessageId', 'auditMessageId']) {
    if (typeof value?.[key] !== 'string' || !value[key].trim()) throw new Error(`Release requires dispatched_by.${key}`);
  }
  return value;
}

function prepare(directory, env = process.env, run = execFileSync) {
  const dispatch = attribution(env.DISPATCHED_BY);
  if ((env.STORE_TRACK && env.STORE_TRACK !== 'none') || (env.SELECTION && env.SELECTION !== 'auto') ||
    env.RUN_RELEASE_PROOF === 'true' || env.MOBILE_STORE_MINIMUM || env.PUBLISH_LISTING === 'true') {
    throw new Error('Promotion accepts only an existing next identity and owner attribution');
  }
  const repository = env.GITHUB_REPOSITORY;
  if (env.GITHUB_REF !== 'refs/heads/main') throw new Error('Promote from the main workflow');
  const releases = listIdentityReleases(repository);
  const source = releases.filter(release => /-rc\.\d+$/.test(release.tag_name ?? ''));
  const release = latestPublished(source, 'next');
  const next = readPublishedRecord(repository, source, 'next', { candidate: true });
  const website = release && downloadAsset(repository, release, 'website-staging.json');
  if (next && website) next.staged = JSON.parse(website.toString('utf8'));
  const previous = readPublishedRecord(repository, releases, 'latest');
  validateCandidate(next, release, { requestedSha: env.REQUESTED_SHA, requestedVersion: env.REQUESTED_VERSION });
  const sha = run('git', ['rev-parse', '--verify', `refs/tags/${next.version}^{commit}`], { encoding: 'utf8', cwd: root }).trim();
  if (sha !== next.sourceSha) throw new Error('The next tag and release record name different commits');
  run('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { cwd: root });
  if (!release.prerelease && previous?.version !== next.version) throw new Error('The candidate has already been superseded in latest');
  if (release.prerelease && latestPublished(releases)?.published_at > release.published_at)
    throw new Error('The candidate predates the current latest release');
  mkdirSync(directory, { recursive: true });
  write(join(directory, 'candidate.json'), { next, previous, dispatch, alreadyPromoted: !release.prerelease && previous?.channel === 'latest' });
}

async function get(url, fetchImpl, method = 'GET') {
  const response = await fetchImpl(url, { method, signal: AbortSignal.timeout(30_000), cache: 'no-store' });
  if (!response.ok) throw new Error(`Published artifact ${url} returned HTTP ${response.status}`);
  return response;
}

export async function prepareProductionMoves(next, { run, eas, fetchImpl }) {
  const { sourceSha, version, staged } = next;
  const packageVersion = version.slice(1);
  const tags = JSON.parse(run('npm', ['view', 'usebeeline', 'dist-tags', '--json', '--prefer-online'], { encoding: 'utf8', timeout: 30_000 }));
  if (tags.next !== packageVersion) throw new Error(`npm next is ${tags.next}, expected ${packageVersion}`);
  const helperPrefix = `${downloads}/dl/releases/${version}`;
  const desktopPrefix = `${downloads}/${version}`;
  const [helper, desktop, web, helperRoute, desktopRoute] = await Promise.all([
    get(`${helperPrefix}/manifest.json`, fetchImpl).then(response => response.json()),
    get(`${desktopPrefix}/Beeline-latest.json`, fetchImpl).then(response => response.json()),
    get(`${staged.webOrigin}/beeline-web-release.json`, fetchImpl).then(response => response.json()),
    get('https://usebeeline.app/dl/manifest.json', fetchImpl, 'HEAD'),
    get(`${downloads}/latest/Beeline-latest.json`, fetchImpl, 'HEAD'),
  ]);
  if (helper.sourceCommit !== sourceSha || helper.version !== version || helperPlatforms.some(platform => {
    const bundle = helper.bundles?.[platform];
    return bundle?.verified !== true || ((bundle.commit !== sourceSha || bundle.version !== version) &&
      (platform === 'linux-x64' || bundle.carriedFrom?.commit !== bundle.commit || bundle.carriedFrom?.version !== bundle.version || bundle.carriedFrom?.sha256 !== bundle.sha256));
  }))
    throw new Error('Immutable helper manifest differs from the published candidate');
  if (desktop.version !== next.components.desktop.desktopVersion || desktopPlatforms.some(platform =>
    !desktop.platforms?.[platform]?.signature || !desktop.platforms[platform].url.startsWith(`${desktopPrefix}/Beeline-`)))
    throw new Error('Immutable desktop manifest differs from the published candidate');
  if (web.version !== version || web.sourceSha !== sourceSha) throw new Error('EAS Hosting preview differs from the published candidate');
  if ([helperRoute, desktopRoute].some(response => response.headers.get('X-Beeline-Release-Pointer') !== '1'))
    throw new Error('Deploy the download pointer Worker before promoting');
  const ota = planOtaPromotion({ sourceSha, version, ota: next.components['mobile-ota'], run: eas });
  return { ota, packageVersion, needsNpmTag: tags.latest !== packageVersion };
}

export async function promote(directory, env = process.env, run = execFileSync, fetchImpl = fetch, eas = runEas) {
  const started = performance.now();
  const { next, previous, dispatch, alreadyPromoted } = parse(join(directory, 'candidate.json'));
  const { version, sourceSha, staged } = next;
  if (alreadyPromoted) { console.log(`${version} is already latest.`); return; }
  if (!env.EXPO_TOKEN || !env.EAS_CLI_PATH) throw new Error('Promotion requires the existing Expo token and pinned EAS CLI');
  const cwd = prepareEasProject(directory, staged.easProject);
  const mobileEas = (args, options) => eas(args, { ...options, cwd, timeout: 60_000, env: { ...options?.env, EAS_NO_VCS: '1' } });
  const put = createR2Uploader({ token: env.CLOUDFLARE_R2_TOKEN, accountId: env.CLOUDFLARE_ACCOUNT_ID, fetchImpl });
  const [moves, promotePages] = await Promise.all([
    prepareProductionMoves(next, { run, eas: mobileEas, fetchImpl }),
    preparePagesPromotion({ staged: staged.pages, version, sourceSha, token: env.CLOUDFLARE_PAGES_TOKEN,
      accountId: env.CLOUDFLARE_ACCOUNT_ID, fetchImpl }),
  ]);
  const gh = args => github([...args, '-R', env.GITHUB_REPOSITORY], run);
  moves.ota.republish();
  if (moves.needsNpmTag) {
    run('npm', ['dist-tag', 'add', `usebeeline@${moves.packageVersion}`, 'latest'], { stdio: 'inherit', timeout: 60_000 });
  }
  const elapsed = () => Math.round((performance.now() - started) / 1000);
  moves.ota.pointProduction();
  mobileEas(['deploy:alias', '--prod', '--id', staged.webDeployment, '--json', '--non-interactive']);
  await promotePages();
  const pointer = join(directory, 'latest-release.json');
  write(pointer, { version, sourceSha });
  await put('', 'latest-release.json', pointer);

  const priorOta = previous?.components?.['mobile-ota'];
  const record = {
    ...next, channel: 'latest', promotedFrom: version, promotedAt: new Date().toISOString(), promotion: { dispatch, elapsedSeconds: elapsed() },
    ...(previous && { supersedes: { version: previous.version, sourceSha: previous.sourceSha } }),
    components: { ...next.components, 'mobile-ota': { ...next.components['mobile-ota'],
      otaBranch: moves.ota.branch,
      previousOtaBranch: moves.ota.production === moves.ota.branch ? priorOta?.otaBranch : moves.ota.production } },
  };
  write(join(directory, PROMOTION_RECORD_ASSET), record);
  gh(['release', 'upload', version, join(directory, PROMOTION_RECORD_ASSET), '--clobber']);
  gh(['release', 'edit', version, '--prerelease=false', '--latest', '--notes', `Promoted the published next candidate at ${sourceSha}.`]);
  const summary = `Promoted ${version}@${sourceSha} in ${elapsed()}s`;
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [, , command, path, deployment, pages, version, sourceSha] = process.argv;
  Promise.resolve().then(() => {
    if (command === 'stage') {
      const web = parse(deployment);
      write(path, { ...stageWebsite({ version, sourceSha }, web, parse(pages)), easProject: stagedEasProject(web) });
    } else if (command === 'prepare') prepare(path);
    else if (command === 'promote') return promote(path);
    else throw new Error('Expected stage, prepare or promote');
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { downloadAsset, latestPublished, listIdentityReleases, readPublishedRecord, PROMOTION_RECORD_ASSET } from './release-record.mjs';
import { createR2Uploader } from './r2-client.mjs';
import { publishPages } from './deploy-pages.mjs';
import { republishOta, runEas } from '../../apps/mobile/scripts/ota-release.mjs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value) + '\n');

export async function promote(directory, next, staged, previous, dispatchedBy, env = process.env,
  run = execFileSync, eas = runEas, fetchImpl = fetch) {
  const start = performance.now();
  const { version, sourceSha } = next;
  if (staged?.version !== version || staged.sourceSha !== sourceSha || !staged.pages?.manifest ||
      !staged.webDeployment || !staged.easProject?.extra?.eas?.projectId) {
    throw new Error(`Publish a complete next candidate before promoting ${version}`);
  }
  mkdirSync(directory, { recursive: true });
  write(join(directory, 'app.json'), { expo: staged.easProject });
  write(join(directory, 'package.json'), { name: staged.easProject.slug, version: staged.easProject.version, private: true });
  const expo = (args, options) => eas(args, { ...options, cwd: directory, env: { EAS_NO_VCS: '1' }, timeout: 60_000 });
  const put = createR2Uploader({ token: env.CLOUDFLARE_R2_TOKEN, accountId: env.CLOUDFLARE_ACCOUNT_ID, fetchImpl });
  if (!env.CLOUDFLARE_PAGES_TOKEN) throw new Error('CLOUDFLARE_PAGES_TOKEN is required');
  const ota = republishOta(next, expo);
  run('npm', ['dist-tag', 'add', `usebeeline@${version.slice(1)}`, 'latest'], { stdio: 'inherit', timeout: 60_000 });
  if (ota.previousBranch !== ota.branch) expo(['channel:edit', 'production', '--branch', ota.branch, '--json', '--non-interactive']);
  expo(['deploy:alias', '--prod', '--id', staged.webDeployment, '--json', '--non-interactive']);
  await publishPages(staged.pages, sourceSha, env, fetchImpl);
  const pointer = join(directory, 'latest-release.json');
  write(pointer, { version, sourceSha });
  await put('', 'latest-release.json', pointer);
  const record = join(directory, PROMOTION_RECORD_ASSET);
  write(record, { ...next, channel: 'latest', promotedFrom: version, promotedAt: new Date().toISOString(), promotion: { dispatchedBy },
    components: { ...next.components, 'mobile-ota': { ...next.components['mobile-ota'], otaBranch: ota.branch,
      previousOtaBranch: ota.previousBranch === ota.branch ? previous?.components?.['mobile-ota']?.otaBranch : ota.previousBranch } } });
  run('gh', ['release', 'upload', version, record, '--clobber'], { stdio: 'inherit', timeout: 60_000 });
  run('gh', ['release', 'edit', version, '--prerelease=false', '--latest', '--notes', `Promoted ${version} at ${sourceSha}.`],
    { stdio: 'inherit', timeout: 60_000 });
  console.log(`Promoted ${version}@${sourceSha} in ${Math.round((performance.now() - start) / 1000)}s`);
}

async function main([command, directory, web, pages, version, sourceSha], env) {
  if (command === 'stage') {
    const mobile = join(import.meta.dirname, '../../apps/mobile');
    const { getConfig } = createRequire(join(mobile, 'package.json'))('@expo/config');
    const { exp } = getConfig(mobile, { skipPlugins: true });
    const { identifier, dashboardUrl } = json(web);
    const projectId = exp.extra.eas.projectId;
    if (new URL(dashboardUrl).pathname !== `/projects/${projectId}/hosting/deployments` || exp.updates?.codeSigningCertificate) {
      throw new Error('The staged EAS project must match the web deployment and support unsigned OTA republishing');
    }
    write(directory, { version, sourceSha, webDeployment: identifier, pages: json(pages),
      easProject: { name: exp.name, slug: exp.slug, owner: exp.owner, version: exp.version, extra: { eas: { projectId } } } });
    return;
  }
  const dispatch = JSON.parse(env.DISPATCHED_BY || '{}');
  if (command !== 'promote' || env.GITHUB_REF !== 'refs/heads/main' || env.STORE_TRACK !== 'none' || env.SELECTION !== 'auto' ||
      env.RUN_RELEASE_PROOF === 'true' || env.MOBILE_STORE_MINIMUM || env.PUBLISH_LISTING === 'true' ||
      !['agentId', 'handle', 'place', 'humanCommandMessageId', 'auditMessageId'].every(key => typeof dispatch[key] === 'string' && dispatch[key].trim())) {
    throw new Error('Promotion requires the main workflow, complete owner attribution and no build overrides');
  }
  const repo = env.GITHUB_REPOSITORY;
  const releases = listIdentityReleases(repo);
  const candidates = releases.filter(release => /^v\d+\.\d+\.\d+-rc\.[1-9]\d*$/.test(release.tag_name));
  const release = latestPublished(candidates, 'next');
  const next = readPublishedRecord(repo, candidates, 'next', { candidate: true });
  if (next?.state !== 'delivered' || next.channel !== 'next' ||
      (env.REQUESTED_SHA && env.REQUESTED_SHA !== next.sourceSha) || (env.REQUESTED_VERSION && env.REQUESTED_VERSION !== next.version)) {
    throw new Error('Promotion requires the exact published next identity');
  }
  const latest = latestPublished(releases);
  if (latest?.id === release.id && !release.prerelease) return console.log(`${next.version} is already latest`);
  if (latest?.published_at > release.published_at || !release.prerelease) throw new Error('The candidate is older than latest');
  const sha = execFileSync('git', ['rev-parse', '--verify', `refs/tags/${next.version}^{commit}`], { encoding: 'utf8' }).trim();
  if (sha !== next.sourceSha) throw new Error('Candidate tag differs from its record');
  const staged = downloadAsset(repo, release, 'website-staging.json');
  if (!staged) throw new Error(`Publish a complete next candidate before promoting ${next.version}`);
  await promote(directory, next, JSON.parse(staged), readPublishedRecord(repo, releases), dispatch, env);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2), process.env).catch(error => { console.error(error.message); process.exitCode = 1; });
}

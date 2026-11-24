import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promote, validateCandidate } from './release-promote.mjs';
import { assignReleaseVersion } from './release-record.mjs';

const version = 'v0.1.245-rc.10';
const sourceSha = 'a'.repeat(40);
const source = `release-${version}`;
const target = `release-promoted-${version}`;
const old = 'release-v0.1.244';
const desktopVersion = '0.2.11';
const webOrigin = 'https://beeline--sample.expo.app';
const desktopOrigin = 'https://downloads.usebeeline.app';
const pages = { id: 'a1-b2', sourceSha, branch: `next-${version}`, manifest: { '/index.html': 'prepared-hash' }, files: { _headers: 'prepared headers' } };
const easProject = { name: 'Beeline', slug: 'beeline', version: '0.0.0', extra: { eas: { projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } } };
const website = { webOrigin, webDeployment: 'sample', sourceSha, version, pages, easProject };
const delivered = {
  channel: 'next', state: 'delivered', version, sourceSha, staged: website,
  components: {
    helper: { version, sourceSha },
    'mobile-ota': { version, sourceSha, otaBranch: source, otaTargets: ['ios@41', 'android@53'] },
    desktop: { version, sourceSha, desktopVersion },
    website: { version, sourceSha },
  },
};
const release = { tag_name: version, prerelease: true,
  assets: ['Beeline-latest.json', 'Beeline-universal.dmg', 'Beeline-x86_64.AppImage', 'Beeline-x86_64-setup.exe'].map(name => ({ name })) };

test('promotion fails closed on an old candidate or a different artifact identity', () => {
  assert.equal(validateCandidate(delivered, release), delivered);
  assert.throws(() => validateCandidate({ ...delivered, staged: undefined }, release), /Publish a complete next candidate first/);
  assert.throws(() => validateCandidate(delivered, release, { requestedSha: 'b'.repeat(40) }), /current next source SHA/);
  assert.throws(() => validateCandidate(delivered, { ...release, assets: [] }), /Beeline-latest.json/);
  assert.throws(() => validateCandidate(delivered, release, { requestedVersion: 'v0.1.245' }), /published next version/);
  assert.equal(assignReleaseVersion({ releases: [release], previous: { ...delivered, channel: 'latest' }, sha: sourceSha }).version, 'v0.1.246-rc.1');
});

test('promotion reuses published bytes and resumes after a partial OTA republish', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'release-promotion-fixture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dispatch = { auditMessageId: 'owner-audit' };
  writeFileSync(join(directory, 'candidate.json'), JSON.stringify({ next: delivered, dispatch,
    previous: { version: 'v0.1.244', components: { 'mobile-ota': { otaBranch: old } } } }));
  const env = { GITHUB_REPOSITORY: 'owner/repo', CLOUDFLARE_PAGES_TOKEN: 'fixture', CLOUDFLARE_R2_TOKEN: 'fixture',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), EXPO_TOKEN: 'fixture', EAS_CLI_PATH: 'fixture' };
  const writes = [], republished = [];
  let npmLatest = '0.1.244', branchExists = false, production = old, failAndroid = true;
  const channel = branch => ({ branchMapping: { data: [{ branchId: 'b', branchMappingLogic: 'true' }] }, updateBranches: [{ id: 'b', name: branch }] });
  const original = ['ios', 'android'].map((platform, i) => {
    const runtimeVersion = ['41', '53'][i];
    return { group: platform + '-source-group', platform, runtimeVersion, message: `release ${sourceSha.slice(0, 12)} ${platform}@${runtimeVersion}` };
  });
  const run = (tool, args) => {
    if (tool === 'npm' && args[0] === 'view') return JSON.stringify({ next: version.slice(1), latest: npmLatest });
    if (tool === 'npm') {
      assert.deepEqual(args, ['dist-tag', 'add', `usebeeline@${version.slice(1)}`, 'latest']);
      npmLatest = version.slice(1);
      writes.push('npm tag');
    } else {
      assert.equal(tool, 'gh');
      assert.equal(args[0], 'release');
      if (args[1] === 'upload') {
        assert.equal(args[2], version);
        const record = JSON.parse(readFileSync(args[3], 'utf8'));
        assert.equal(record.channel, 'latest');
        assert.equal(record.sourceSha, sourceSha);
        assert.equal(record.components['mobile-ota'].previousOtaBranch, old);
        assert.equal(record.components['mobile-ota'].otaBranch, target);
        writes.push('promotion record');
      } else {
        assert.deepEqual(args.slice(1, 5), ['edit', version, '--prerelease=false', '--latest']);
        writes.push('GitHub latest');
      }
    }
    return '';
  };
  const eas = (args, options) => {
    assert.equal(options.env.EAS_NO_VCS, '1');
    assert.deepEqual(JSON.parse(readFileSync(join(options.cwd, 'app.json'), 'utf8')), { expo: easProject });
    switch (args[0]) {
      case 'channel:view': return channel(args[1] === 'next' ? source : production);
      case 'update:list': return args[2] === source ? original : branchExists ? republished : null;
      case 'branch:create':
        assert.equal(args[1], target);
        branchExists = true;
        writes.push('OTA branch');
        return {};
      case 'update:republish': {
        assert.equal(args[4], target);
        const group = original.find(row => row.group === args[2]);
        assert.equal(args[6], group.platform);
        if (group.platform === 'android' && failAndroid) throw new Error('temporary Expo failure');
        republished.push({ ...group, group: 'republished-' + group.group, message: args[8] });
        writes.push(group.platform);
        return {};
      }
      case 'channel:edit':
        assert.deepEqual(args.slice(1, 4), ['production', '--branch', target]);
        production = target;
        writes.push('production OTA');
        return {};
      case 'deploy:alias':
        assert.deepEqual(args.slice(1, 4), ['--prod', '--id', 'sample']);
        writes.push('EAS alias');
        return {};
      default: assert.fail(`Unexpected EAS command ${args.join(' ')}`);
    }
  };
  const cloudflare = (result) => Response.json({ success: true, result });
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    if (options.method === 'HEAD') return new Response(null, { headers: { 'X-Beeline-Release-Pointer': '1' } });
    if (url === `${webOrigin}/beeline-web-release.json`) return Response.json({ version, sourceSha });
    if (url === `${desktopOrigin}/dl/releases/${version}/manifest.json`) {
      return Response.json({ version, sourceCommit: sourceSha, bundles: Object.fromEntries(
        ['linux-x64', 'darwin-arm64', 'darwin-x64'].map(platform => [platform, { verified: true, commit: sourceSha, version }])), });
    }
    if (url === `${desktopOrigin}/${version}/Beeline-latest.json`) {
      return Response.json({ version: desktopVersion, platforms: Object.fromEntries(
        ['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64'].map(platform => [platform, { signature: 'signed', url: `${desktopOrigin}/${version}/Beeline-package` }])), });
    }
    if (path.endsWith('/projects/usebeeline')) return cloudflare({ production_branch: 'main' });
    if (path.endsWith('/deployments/' + pages.id)) {
      return cloudflare({ environment: 'preview', latest_stage: { status: 'success' }, deployment_trigger: { metadata: { commit_hash: sourceSha, branch: pages.branch } } });
    }
    if (path.endsWith('/deployments') && options.method === 'POST') {
      assert.equal(options.body.get('branch'), 'main');
      assert.equal(options.body.get('manifest'), JSON.stringify(pages.manifest));
      assert.equal(await options.body.get('_headers').text(), pages.files._headers);
      writes.push('Pages manifest');
      return cloudflare({ id: 'c3-d4' });
    }
    if (path.endsWith('/deployments/c3-d4')) return cloudflare({ latest_stage: { name: 'deploy', status: 'success' } });
    if (options.method === 'PUT' && path.endsWith('/objects/latest-release.json')) {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { version, sourceSha });
      writes.push('download pointer');
      return cloudflare({});
    }
    assert.fail(`Unexpected URL ${url}`);
  };
  await assert.rejects(promote(directory, env, run, fetchImpl, eas), /temporary Expo failure/);
  assert.equal(production, old);
  assert.deepEqual(writes, ['OTA branch', 'ios']);
  failAndroid = false;
  const start = performance.now();
  await promote(directory, env, run, fetchImpl, eas);
  t.diagnostic(`Promotion fixture wall time ${Math.round(performance.now() - start)} ms`);
  assert.deepEqual(writes, ['OTA branch', 'ios', 'android', 'npm tag', 'production OTA', 'EAS alias',
    'Pages manifest', 'download pointer', 'promotion record', 'GitHub latest']);
});

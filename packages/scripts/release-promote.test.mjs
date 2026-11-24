import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promote } from './release-promote.mjs';
import { assignReleaseVersion } from './release-record.mjs';

const version = 'v0.1.245-rc.10';
const sourceSha = 'a'.repeat(40);
const source = `release-${version}`;
const target = `release-promoted-${version}`;
const old = 'release-v0.1.244';
const desktopVersion = '0.2.11';
const pages = { id: 'a1-b2', sourceSha, branch: `next-${version}`, manifest: { '/index.html': 'prepared-hash' }, files: { _headers: 'prepared headers' } };
const easProject = { name: 'Beeline', slug: 'beeline', version: '0.0.0', extra: { eas: { projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } } };
const website = { webDeployment: 'sample', sourceSha, version, pages, easProject };
const delivered = {
  channel: 'next', state: 'delivered', version, sourceSha, staged: website,
  components: {
    helper: { version, sourceSha },
    'mobile-ota': { version, sourceSha, otaBranch: source, otaTargets: ['ios@41', 'android@53'] },
    desktop: { version, sourceSha, desktopVersion },
    website: { version, sourceSha },
  },
};
test('promotion refuses a missing or mismatched staged candidate before calling a provider', async () => {
  const unexpected = () => assert.fail('Promotion started with an incomplete candidate');
  for (const staged of [undefined, { ...website, sourceSha: 'b'.repeat(40) }]) {
    await assert.rejects(promote('/unused', delivered, staged, {}, {}, {}, unexpected, unexpected, unexpected), /Publish a complete next candidate/);
  }
  assert.equal(assignReleaseVersion({ releases: [], previous: { ...delivered, channel: 'latest' }, sha: sourceSha }).version, 'v0.1.246-rc.1');
});

test('promotion reuses published bytes and resumes after a partial OTA republish', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'release-promotion-fixture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dispatch = { auditMessageId: 'owner-audit' };
  const previous = { version: 'v0.1.244', components: { 'mobile-ota': { otaBranch: old } } };
  const env = { GITHUB_REPOSITORY: 'owner/repo', CLOUDFLARE_PAGES_TOKEN: 'fixture', CLOUDFLARE_R2_TOKEN: 'fixture',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), EXPO_TOKEN: 'fixture', EAS_CLI_PATH: 'fixture' };
  const writes = [], republished = [];
  let branchExists = false, production = old, failAndroid = true;
  const channel = branch => ({ branchMapping: { data: [{ branchId: 'b', branchMappingLogic: 'true' }] }, updateBranches: [{ id: 'b', name: branch }] });
  const original = ['ios', 'android'].map((platform, i) => {
    const runtimeVersion = ['41', '53'][i];
    return { group: platform + '-source-group', platform, runtimeVersion, message: `release ${sourceSha.slice(0, 12)} ${platform}@${runtimeVersion}` };
  });
  const run = (tool, args) => {
    if (tool === 'npm') {
      assert.deepEqual(args, ['dist-tag', 'add', `usebeeline@${version.slice(1)}`, 'latest']);
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
  await assert.rejects(promote(directory, delivered, website, previous, dispatch, env, run, eas, fetchImpl), /temporary Expo failure/);
  assert.equal(production, old);
  assert.deepEqual(writes, ['OTA branch', 'ios']);
  failAndroid = false;
  const start = performance.now();
  await promote(directory, delivered, website, previous, dispatch, env, run, eas, fetchImpl);
  t.diagnostic(`Promotion fixture wall time ${Math.round(performance.now() - start)} ms`);
  assert.deepEqual(writes, ['OTA branch', 'ios', 'android', 'npm tag', 'production OTA', 'EAS alias',
    'Pages manifest', 'download pointer', 'promotion record', 'GitHub latest']);
});

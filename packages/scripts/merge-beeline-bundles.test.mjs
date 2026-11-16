import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { mergeBeelineBundles } from './merge-beeline-bundles.mjs';
import { downloadPagesChannel, MAC_INPUT_FILES } from './pages-channel.mjs';

const root = resolve(import.meta.dirname, '../..');
const sha = 'a'.repeat(40), oldSha = 'b'.repeat(40);

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'beeline-carry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const linux = join(directory, 'linux'), mac = join(directory, 'mac');
  for (const [path, platforms, commit, version] of [
    [linux, ['linux-x64'], sha, 'v1.2.3'], [mac, ['darwin-arm64', 'darwin-x64'], oldSha, 'v1.2.2'],
  ]) {
    mkdirSync(path);
    const bundles = {};
    for (const platform of platforms) {
      const file = `beeline-${platform}.tar.gz`, bytes = Buffer.from(`published-${platform}`);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      writeFileSync(join(path, file), bytes);
      writeFileSync(join(path, `${file}.sha256`), `${sha256}  ${file}\n`);
      bundles[platform] = { file, bytes: bytes.length, sha256, commit, version, verified: true };
    }
    writeFileSync(join(path, 'manifest.json'), JSON.stringify({ schemaVersion: 1, sourceCommit: commit, version, bundles }));
  }
  return { directory, linux, mac, outputDir: join(directory, 'merged') };
}

test('both carry flags preserve published Mac bytes and identities beside a new Linux helper', async t => {
  const { linux, mac, outputDir } = fixture(t);
  execFileSync(process.execPath, ['packages/scripts/merge-beeline-bundles.mjs', '--output-dir', outputDir,
    '--input-dir', linux, '--carry-arm64-dir', mac, '--carry-x64-dir', mac], { cwd: root });
  const manifest = JSON.parse(readFileSync(join(outputDir, 'manifest.json')));
  assert.equal(manifest.sourceCommit, sha);
  assert.equal(manifest.version, 'v1.2.3');
  assert.equal(manifest.bundles['linux-x64'].commit, sha);
  const previous = JSON.parse(readFileSync(join(mac, 'manifest.json')));
  for (const [platform, bundle] of Object.entries(previous.bundles)) {
    assert.deepEqual(manifest.bundles[platform], { ...bundle,
      carriedFrom: { commit: oldSha, version: bundle.version, sha256: bundle.sha256 } });
    for (const name of [bundle.file, `${bundle.file}.sha256`])
      assert.deepEqual(readFileSync(join(outputDir, name)), readFileSync(join(mac, name)));
  }
  await assert.rejects(mergeBeelineBundles({ outputDir, inputDirs: [linux, mac], carriedX64Dir: mac }), /identity differs/);
  await assert.rejects(mergeBeelineBundles({ outputDir, inputDirs: [linux], carriedX64Dir: linux }), /expected one carried darwin-x64 helper/);
});

test('daemon merge accepts empty Mac build dirs only for explicitly carried platforms', t => {
  const { directory, linux, mac } = fixture(t);
  const runner = join(directory, 'runner');
  mkdirSync(runner);
  const env = { ...process.env, RUNNER_TEMP: runner, BEELINE_ACTION_VALUE_0: linux,
    BEELINE_ACTION_VALUE_1: '', BEELINE_ACTION_VALUE_2: '',
    BEELINE_RELEASE_CARRIED_ARM64_DIR: mac, BEELINE_RELEASE_CARRIED_X64_DIR: mac };
  execFileSync('bash', ['packages/scripts/release-steps/daemon-leg.sh', 'step0'], { cwd: root, env });
  const manifest = JSON.parse(readFileSync(join(runner, 'daemon-release/manifest.json')));
  assert.deepEqual(Object.keys(manifest.bundles).sort(), ['darwin-arm64', 'darwin-x64', 'linux-x64']);
  for (const [arm64, x64] of [['', ''], [mac, ''], ['', mac]]) {
    const result = spawnSync('bash', ['packages/scripts/release-steps/daemon-leg.sh', 'step0'], { cwd: root, encoding: 'utf8',
      env: { ...env, BEELINE_RELEASE_CARRIED_ARM64_DIR: arm64, BEELINE_RELEASE_CARRIED_X64_DIR: x64 } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /A three-platform merge needs/);
  }
});

test('published carried Mac helpers download without either optional Mac input-hash asset', async t => {
  const { directory, linux, mac, outputDir } = fixture(t);
  const manifest = await mergeBeelineBundles({ outputDir, inputDirs: [linux], carriedArm64Dir: mac, carriedX64Dir: mac });
  const names = ['manifest.json', ...Object.values(manifest.bundles).flatMap(bundle => [bundle.file, `${bundle.file}.sha256`])];
  const github = { rest: { repos: {
    async getReleaseByTag() { return { data: { assets: names.map(name => ({ name, id: name })) } }; },
    async getReleaseAsset({ asset_id }) { return { data: readFileSync(join(outputDir, asset_id)) }; },
  } } };
  const downloaded = join(directory, 'downloaded');
  assert.deepEqual(await downloadPagesChannel({ github, repo: {}, directory: downloaded }), manifest);
  for (const name of names) assert.deepEqual(readFileSync(join(downloaded, name)), readFileSync(join(outputDir, name)));
  for (const name of MAC_INPUT_FILES) assert.throws(() => readFileSync(join(downloaded, name)), { code: 'ENOENT' });
});

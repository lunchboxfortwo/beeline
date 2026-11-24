import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../..');
const workflow = parse(readFileSync(join(root, '.github/workflows/unified-release.yml'), 'utf8'));
const temporary = () => mkdtempSync(join(tmpdir(), 'beeline-store-release-test-'));

function mobileFixture(directory) {
  const mobile = join(directory, 'apps/mobile');
  mkdirSync(join(mobile, 'scripts'), { recursive: true });
  copyFileSync(join(root, 'apps/mobile/scripts/check-release-version.cjs'), join(mobile, 'scripts/check-release-version.cjs'));
  writeFileSync(join(mobile, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.2.22' }) + '\n');
  const git = (...args) => execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  git('tag', 'v0.1.223-rc.2');
  return mobile;
}

for (const platform of ['android']) {
  test(`${platform} applies the resolved store version at an independently tagged release HEAD`, () => {
    const directory = temporary();
    try {
      const mobile = mobileFixture(directory);
      assert.equal(execFileSync(process.execPath, ['scripts/check-release-version.cjs'], { cwd: mobile, encoding: 'utf8' }).trim(), '0.2.22');
      const step = workflow.jobs[`mobile_native_${platform}`].steps.find(step => step.name === 'Apply the resolved native store version');
      assert.equal(step.env.NATIVE_APP_VERSION, '${{ needs.initialize.outputs.native_app_version }}');
      execFileSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], { cwd: mobile, env: { ...process.env, NATIVE_APP_VERSION: '0.2.30' } });
      assert.deepEqual(JSON.parse(readFileSync(join(mobile, 'package.json'), 'utf8')), { name: 'fixture', version: '0.2.30' });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test('invalid or absent resolved store versions fail before changing the package', () => {
  const directory = temporary();
  try {
    const mobile = mobileFixture(directory), path = join(mobile, 'package.json');
    const before = readFileSync(path, 'utf8');
    for (const candidate of [undefined, '', 'v0.1.223', '0.1.223-rc.2', '1.2.3.4']) {
      const env = { ...process.env };
      delete env.NATIVE_APP_VERSION;
      if (candidate !== undefined) env.NATIVE_APP_VERSION = candidate;
      const result = spawnSync(process.execPath, ['scripts/check-release-version.cjs', '--apply-store-version'], { cwd: mobile, env, encoding: 'utf8' });
      assert.notEqual(result.status, 0, String(candidate));
      assert.match(result.stderr, /iOS display version/);
      assert.equal(readFileSync(path, 'utf8'), before);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

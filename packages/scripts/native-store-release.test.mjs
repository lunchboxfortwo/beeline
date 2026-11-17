import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { LocalActions } from './release-local-actions.mjs';
import { privateIosJob } from './release-local.mjs';
import { Processes } from './release-local-process.mjs';

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

for (const platform of ['android', 'ios']) {
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

// Model security's per-HOME preferences, including its failure when a fresh
// SSH job HOME has no default. Execute the actual adapted workflow steps.
const securityFixture = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), command = args[0];
const file = process.env.KEYCHAIN_STATE, state = JSON.parse(fs.readFileSync(file, 'utf8'));
state.calls.push(args);
function save() { fs.writeFileSync(file, JSON.stringify(state)); }
save();
if (command === 'list-keychains') {
  if (args.includes('-s')) state.search = args.slice(args.indexOf('-s') + 1);
  else console.log(state.search.map(path => JSON.stringify(path)).join('\\n'));
} else if (command === 'default-keychain') {
  if (args.includes('-s')) {
    const value = args[args.indexOf('-s') + 1];
    if (!value) { console.error('missing default path'); process.exit(1); }
    state.default = value;
  } else if (process.env.KEYCHAIN_QUERY_ERROR) {
    console.error('security: permission denied'); process.exit(1);
  } else if (state.default) console.log(JSON.stringify(state.default));
  else { console.error('security: SecKeychainCopyDomainDefault user: A default keychain could not be found.'); process.exit(1); }
} else if (command === 'create-keychain') fs.writeFileSync(args.at(-1), 'fixture');
else if (command === 'set-keychain-settings' && process.env.KEYCHAIN_SETUP_ERROR) process.exit(1);
else if (command === 'delete-keychain') {
  fs.unlinkSync(args.at(-1));
  if (state.default === args.at(-1)) state.default = null;
}
save();
`;

for (const priorDefault of [null, '/Users/fixture/Library/Keychains/old login.keychain-db']) {
  for (const failBuild of [false, true]) {
    test(`private iOS keychain restores ${priorDefault ? 'existing' : 'absent'} default after build ${failBuild ? 'failure' : 'success'}`, async () => {
      await keychainProof({ priorDefault, failBuild });
    });
  }
}
test('private iOS keychain cleans up after setup fails partway through', async () => {
  await keychainProof({ setupError: true });
});
test('private iOS keychain does not treat permission errors as an absent default', async () => {
  await keychainProof({ queryError: true });
});

async function keychainProof({ priorDefault = null, failBuild = false, setupError = false, queryError = false }) {
  const directory = temporary();
  try {
    const stateFile = join(directory, 'keychains.json');
    const original = { default: priorDefault, search: priorDefault ? [priorDefault, '/Library/Keychains/System.keychain'] : [] };
    writeFileSync(stateFile, JSON.stringify({ ...original, calls: [] }));
    mkdirSync(join(directory, 'bin'));
    const security = join(directory, 'bin/security');
    writeFileSync(security, securityFixture); chmodSync(security, 0o700);
    const adapted = privateIosJob(workflow.jobs.mobile_native_ios);
    const step = name => adapted.steps.find(step => step.name === name);
    const engine = new LocalActions({ root, directory, processes: new Processes({}, () => {}), secrets: {},
      baseEnv: { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}` } });
    const result = await engine.job({ env: { KEYCHAIN_STATE: stateFile,
      BEELINE_SIGNING_TOOLS: join(directory, 'bin'), BEELINE_OPERATOR_HOME: '/Users/fixture',
      KEYCHAIN_SETUP_ERROR: setupError ? 'true' : '', KEYCHAIN_QUERY_ERROR: queryError ? 'true' : '' }, steps: [
      step('Isolate the iOS signing keychain'),
      { run: failBuild ? 'exit 1' : `test -f "$HOME/Library/Keychains/login.keychain-db"
security list-keychains -d user > "$RUNNER_TEMP/during-build.json"` },
      step('Restore the runner user keychains'),
    ] }, { github: { repository: 'fixture/repo', sha: 'a'.repeat(40), job: 'mobile_native_ios' }, inputs: {}, needs: {}, steps: {}, matrix: {}, job: { status: 'success' } }, 'ios-keychain-proof');
    assert.equal(result.result, failBuild || setupError || queryError ? 'failure' : 'success');
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(state.default, original.default);
    assert.deepEqual(state.search, original.search);
    assert.equal(state.calls.filter(args => args[0] === 'create-keychain').length, queryError ? 0 : 1);
    assert.equal(state.calls.filter(args => args[0] === 'delete-keychain').length, queryError ? 0 : 1);
    if (!failBuild && !setupError && !queryError) {
      const search = readFileSync(join(directory, 'jobs/ios-keychain-proof/during-build.json'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(search, [join(directory, 'jobs/ios-keychain-proof/home/Library/Keychains/login.keychain-db'), '/Users/fixture/Library/Keychains/login.keychain-db']);
    }
    // Never invoke default-keychain -s without an explicit prior path.
    assert.ok(state.calls.filter(args => args[0] === 'default-keychain' && args.includes('-s')).every(args => args[4]));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('private iOS build PATH resets keep signing tools first and Apple rsync before Homebrew', () => {
  const original = workflow.jobs.mobile_native_ios;
  const adapted = privateIosJob(original);
  const build = adapted.steps.find(step => step.name === 'Build immutable iOS store binary locally');
  const reset = build.run.split('\n').filter(line => line.startsWith('PATH=') || line.startsWith('export PATH')).join('\n');
  const result = execFileSync('bash', ['-euc', `${reset}\nprintf '%s' "$PATH"`], {
    env: { ...process.env, BEELINE_SIGNING_TOOLS: '/private/signing-tools' }, encoding: 'utf8',
  }).split(':');
  assert.equal(result[0], '/private/signing-tools');
  assert.ok(result.indexOf('/usr/bin') < result.indexOf('/usr/local/bin'));
  assert.ok(!original.steps.find(step => step.name === build.name).run.includes('BEELINE_SIGNING_TOOLS'));
});

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { DesktopBuild, WINDOWS_DESKTOP, carryWindowsInstallers, stageDesktopSet, verifyUpdaterFile } from './release-local-desktop.mjs';
import { verifyDesktopUpdateManifest } from './desktop-update.mjs';
import { localHooks, parseArguments } from './release-local.mjs';
import { releaseArguments, releaseSequence } from './release.mjs';
import { LocalDelivery } from './release-local-delivery.mjs';
import { desktopBuildEnvironment, desktopSigningStep, macSigningTools } from './release-local-desktop-worker.mjs';
import { WindowsGuest } from './release-local-windows.mjs';
import { Processes } from './release-local-process.mjs';

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const id = randomBytes(8);
  const key = Buffer.concat([Buffer.from('Ed'), id, publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)]);
  const encodedKey = Buffer.from(`untrusted comment: test\n${key.toString('base64')}\n`).toString('base64');
  return { publicKey: encodedKey, sign(file) {
    const signature = sign(null, createHash('blake2b512').update(readFileSync(file)).digest(), privateKey);
    const packet = Buffer.concat([Buffer.from('ED'), id, signature]);
    const comment = 'timestamp:123\tfile:test';
    const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
    writeFileSync(`${file}.sig`, Buffer.from(`untrusted comment: test\n${packet.toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`).toString('base64'));
  } };
}

test('updater verification checks payload bytes, key identity and trusted comments', () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-signature-'));
  try {
    const file = join(directory, 'payload'), key = signer();
    writeFileSync(file, 'installer bytes'); key.sign(file);
    assert.equal(verifyUpdaterFile(file, key.publicKey), true);
    assert.throws(() => verifyUpdaterFile(file, signer().publicKey), /key mismatch/);
    const original = readFileSync(`${file}.sig`, 'utf8');
    writeFileSync(`${file}.sig`, Buffer.from(Buffer.from(original, 'base64').toString().replace('timestamp:123', 'timestamp:456')).toString('base64'));
    assert.throws(() => verifyUpdaterFile(file, key.publicKey), /trusted comment/);
    writeFileSync(`${file}.sig`, original);
    writeFileSync(file, 'changed after signing');
    assert.throws(() => verifyUpdaterFile(file, key.publicKey), /Invalid updater signature/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a full staged set has one desktop version, four platform entries and verified signatures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-stage-'));
  try {
    const key = signer();
    const names = ['Beeline-universal.dmg', 'Beeline-universal.app.tar.gz', 'Beeline-x86_64.AppImage', 'Beeline-x86_64.deb', 'Beeline-x86_64.rpm', 'Beeline-x86_64-setup.exe', 'Beeline-x86_64.msi'];
    for (const name of names) writeFileSync(join(directory, name), name);
    for (const name of [names[1], names[2], names[5]]) key.sign(join(directory, name));
    const spec = { directories: [], directory, version: '0.2.166', releaseVersion: 'v0.1.217', sha: 'a'.repeat(40), publicKey: key.publicKey, windows: 'build' };
    const manifest = stageDesktopSet(spec);
    assert.equal(manifest.version, '0.2.166');
    assert.equal(Object.keys(manifest.platforms).length, 4);
    // A skipped Windows build keeps its carried installers but gives Windows no newer updater entry.
    const skipped = stageDesktopSet({ ...spec, windows: 'skip' });
    assert.deepEqual(Object.keys(skipped.platforms), ['darwin-x86_64', 'darwin-aarch64', 'linux-x86_64']);
    assert.equal(verifyDesktopUpdateManifest(skipped, skipped), skipped);
    assert.throws(() => verifyDesktopUpdateManifest(skipped, manifest), /differs/);
    assert.equal(manifest.platforms['darwin-aarch64'].url, manifest.platforms['darwin-x86_64'].url);
    assert.equal(JSON.parse(readFileSync(join(directory, 'desktop-stage.json'))).updaterSignaturesVerified, true);
    rmSync(join(directory, names[4]));
    assert.throws(() => stageDesktopSet(spec), /Incomplete desktop set: Beeline-x86_64.rpm/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('normal full release builds desktop while the explicit carry option survives both channels', async () => {
  assert.deepEqual(releaseArguments(['--no-store', '--desktop-mode', 'carry']), { noStore: true, desktopMode: 'carry' });
  assert.equal(parseArguments(['--dry-run', '--leg', 'desktop', '--release-version', 'v1.2.3']).leg, 'desktop');
  assert.throws(() => parseArguments(['--desktop-mode', 'partial']), /desktop-mode/);
  for (const mode of [undefined, 'carry']) {
    const calls = [];
    await releaseSequence({ source: '/source', sha: 'a'.repeat(40), directory: '/state', desktopMode: mode }, async args => { if (!args.leg) calls.push(args); }, () => {}, () => {});
    assert.deepEqual(calls.map(args => args['desktop-mode']), [mode || 'build', mode || 'build']);
  }
});

test('build planning preserves the workflow-assigned desktop version; carry restores the whole published version', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-plan-'));
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(directory, 'previous'));
    writeFileSync(join(directory, 'previous/release.json'), JSON.stringify({ components: { desktop: { version: 'v1.2.3', desktopVersion: '0.2.165' } } }));
    for (const mode of ['build', 'carry']) {
      const result = { outputs: { run_desktop: 'true', desktop_version: '0.2.166' } };
      await localHooks(directory, { log() {} }).afterStep({ step: { name: 'Produce the inspectable release plan' }, result,
        context: { runner: { temp: directory } }, engine: { variables: { desktopMode: mode } } });
      assert.equal(result.outputs.run_desktop, mode === 'build' ? 'true' : 'false');
      assert.equal(result.outputs.desktop_version, mode === 'build' ? '0.2.166' : '0.2.165');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a skipped Windows build carries the published installers and omits Windows from the new manifest', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-windows-carry-'));
  const original = globalThis.fetch, requested = [];
  globalThis.fetch = async url => { requested.push(url); return new Response(`published ${url.split('/').at(-1)}`); };
  try {
    const release = parse(readFileSync(join(import.meta.dirname, '../../.github/workflows/unified-release.yml'), 'utf8'));
    const step = structuredClone(release.jobs.release_result.steps.find(candidate => candidate.name === 'Build the signed desktop update manifest'));
    const run = step.run;
    const hooks = localHooks(directory, { log() {} });
    for (let attempt = 0; attempt < 2; attempt++) await hooks.step({ step, context: { github: { job: 'release_result' } }, env: { RUNNER_TEMP: directory }, result: { outputs: {} } });
    assert.equal(step.run, run.replace('manifest \\', 'manifest --omit windows-x86_64 \\'));
    assert.deepEqual(requested.slice(0, 3), ['Beeline-x86_64-setup.exe', 'Beeline-x86_64-setup.exe.sig', 'Beeline-x86_64.msi'].map(name => `https://downloads.usebeeline.app/latest/${name}`));
    assert.equal(readFileSync(join(directory, 'desktop-release/Beeline-x86_64.msi'), 'utf8'), 'published Beeline-x86_64.msi');
    await assert.rejects(carryWindowsInstallers(directory, async () => new Response('', { status: 404 })), /Beeline-x86_64-setup.exe: HTTP 404/);
  } finally { globalThis.fetch = original; rmSync(directory, { recursive: true, force: true }); }
});

test('both Mac helper architectures share the one Mac orchestration slot', async () => {
  const delivery = new LocalDelivery({ variables: { macHelperMode: 'build' } }), placements = [];
  delivery.execute = async (slot, _job, context) => { placements.push([context.matrix.platform, slot]); return { result: 'success' }; };
  await delivery.run({}, { github: { job: 'helper_macos' }, matrix: { platform: 'darwin-x64' } });
  await delivery.run({}, { github: { job: 'helper_macos' }, matrix: { platform: 'darwin-arm64' } });
  assert.deepEqual(placements, [['darwin-x64', 4], ['darwin-arm64', 4]]);
});

test('release entrypoint executes through a symlink, including macOS /tmp aliases', () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-entrypoint-'));
  try {
    const entrypoint = join(directory, 'release.mjs');
    symlinkSync(join(import.meta.dirname, 'release-local.mjs'), entrypoint);
    assert.match(execFileSync(process.execPath, [entrypoint, '--help'], { encoding: 'utf8' }), /node packages\/scripts\/release-local.mjs/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('SSH diagnostics cannot become part of the temporary certificate export', async () => {
  const masked = [];
  const build = new DesktopBuild({ processes: { mask: value => masked.push(value) } });
  build.command = async (_command, _args, { input }) => {
    assert.match(input, /^[a-f0-9]{48}\n$/);
    return 'Warning: host key diagnostic\nBEELINE_CERTIFICATE=Zml4dHVyZQ==\n';
  };
  const credentials = await build.appleSecrets('/tmp/build', { EXPO_ASC_KEY_ID: 'id', EXPO_ASC_ISSUER_ID: 'issuer', EXPO_ASC_API_KEY_P8: 'api-key' });
  assert.equal(credentials.APPLE_CERTIFICATE, 'Zml4dHVyZQ==');
  assert.ok(masked.includes(credentials.APPLE_CERTIFICATE));
  assert.ok(masked.includes(credentials.APPLE_CERTIFICATE_PASSWORD));
  assert.equal(credentials.APPLE_SIGNING_IDENTITY, 'Developer ID Application: Moon Rice Limited (89KT3SWYAF)');
});

test('the committed Desktop job runs through the shared delivery queue without rewriting its steps', async () => {
  const calls = [];
  const engine = { localDelivery: { run: async (...args) => { calls.push(args); return { result: 'success' }; } } };
  const include = ['macos-universal', 'linux-x86_64', 'windows-x86_64'].map(label => ({ label }));
  const workflow = { jobs: { build: { strategy: { matrix: { include } }, steps: [{ name: 'Build the desktop bundle', run: 'workflow-owned build command' }] } } };
  const hooks = await localHooks('/state', {}).workflow({ file: '.github/workflows/desktop.yml', workflow, engine });
  const context = { github: { job: 'build', sha: 'a'.repeat(40) }, matrix: { label: 'macos-universal' } };
  assert.equal(WINDOWS_DESKTOP, 'skip');
  // Skipping Windows removes only its row, so the Windows VM is never contacted.
  assert.deepEqual(hooks.workflow.jobs.build.strategy.matrix.include.map(row => row.label), ['macos-universal', 'linux-x86_64']);
  assert.deepEqual(hooks.workflow.jobs.build.steps, workflow.jobs.build.steps);
  assert.equal(include.length, 3);
  await hooks.job(hooks.workflow.jobs.build, context, 'desktop/mac', { VARIANT: 'production' });
  assert.equal(calls[0][0], hooks.workflow.jobs.build);
  assert.equal(calls[0][1].github.job, 'desktop_build');
  assert.equal(calls[0][1].matrix.label, 'macos-universal');
  assert.equal(context.github.job, 'build');
});

test('private-HOME native builds do not forward release authorities into their base environment', () => {
  const paths = { directory: '/task/state', cargoHome: '/task/cargo', home: '/task/private-home' };
  const mac = desktopBuildEnvironment(paths);
  assert.equal(mac.APPLE_CERTIFICATE, undefined);
  assert.equal(mac.APPLE_CERTIFICATE_PASSWORD, undefined);
  assert.equal(mac.NPM_CONFIG_USERCONFIG, '/task/private-home/.npmrc');
  assert.equal(mac.RUSTUP_HOME, '/task/state/tools/rustup');
  assert.equal(mac.GITHUB_TOKEN, undefined);
  assert.equal(mac.CLOUDFLARE_R2_TOKEN, undefined);
});

test('universal Mac compilation uses four Cargo jobs without increasing other native host limits', () => {
  const paths = { directory: '/task/state', cargoHome: '/task/cargo', home: '/task/private-home' };
  for (const platform of ['darwin', 'linux', 'win32']) {
    const env = desktopBuildEnvironment(paths, platform);
    assert.equal(env.CARGO_BUILD_JOBS, platform === 'darwin' ? '4' : '2');
    assert.equal(env.CI_TEST_WORKERS, '2');
  }
});

test('only Apple signing tools receive the operator HOME, preserving arguments and failures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-signing-home-'));
  try {
    const fake = join(directory, 'os-tool');
    writeFileSync(fake, `#!${process.execPath}\nconsole.log(JSON.stringify({home:process.env.HOME,xdg:process.env.XDG_CONFIG_HOME,args:process.argv.slice(2)}));process.exit(process.argv.includes('--fail')?7:0);\n`, { mode: 0o700 });
    const bin = macSigningTools(join(directory, 'bin'), { security: fake, codesign: fake });
    const env = { ...process.env, HOME: '/private-build-home', XDG_CONFIG_HOME: '/private-config', BEELINE_OPERATOR_HOME: '/operator-home' };
    const result = JSON.parse(execFileSync(join(bin, 'codesign'), ['--sign', 'identity with spaces'], { env, encoding: 'utf8' }));
    assert.deepEqual(result, { home: '/operator-home', xdg: '/private-config', args: ['--sign', 'identity with spaces'] });
    assert.equal(env.HOME, '/private-build-home');
    assert.throws(() => execFileSync(join(bin, 'security'), ['--fail'], { env, stdio: 'pipe' }), error => error.status === 7);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('local Mac signing uses the real keychain database and explicit login/system search paths', () => {
  const workflow = readFileSync(join(import.meta.dirname, '../../.github/workflows/desktop.yml'), 'utf8');
  const materialization = workflow.slice(workflow.indexOf('      - name: Materialize the macOS signing credentials'), workflow.indexOf('      - name: Clear stale bundle'));
  const adapted = desktopSigningStep({ name: 'Materialize the macOS signing credentials', run: materialization });
  assert.match(adapted.run, /keychain_path="\$RUNNER_TEMP\/build\.keychain-db"/);
  assert.match(adapted.run, /"\$BEELINE_OPERATOR_HOME\/Library\/Keychains\/login\.keychain-db" \/Library\/Keychains\/System\.keychain/);
  assert.match(adapted.run, /security unlock-keychain -p "\$keychain_password" "\$keychain_path"/);
  assert.match(materialization, /keychain_path="\$RUNNER_TEMP\/build\.keychain"/);
});

test('guest-agent failures report the provider reason without leaking release credentials', async () => {
  const processes = new Processes({ token: 'private-test-token' }, () => {});
  processes.run = async () => JSON.stringify({ transport_error: 'guest synchronization failed private-test-token' });
  const guest = new WindowsGuest(processes, '/task/windows');
  await assert.rejects(guest.request({ command: 'guest-ping' }), error => /guest synchronization failed \*\*\*/.test(error.message) && !error.message.includes('private-test-token'));
});

test('Apple build launchers share signing HOME with native children and avoid adapter recursion', () => {
  const directory = mkdtempSync(join(tmpdir(), 'apple-build-home-'));
  try {
    const bin = macSigningTools(join(directory, 'bin'));
    for (const name of ['security', 'codesign', 'xcodebuild', 'xcrun', 'fastlane']) {
      assert.ok(existsSync(join(bin, name)), `${name} must enter the operator signing environment`);
    }
    const native = join(directory, 'native');
    mkdirSync(native);
    const command = join(native, 'fastlane');
    writeFileSync(command, `#!${process.execPath}
const {execFileSync}=require('node:child_process');
console.log(JSON.stringify({home:process.env.HOME,path:process.env.PATH,cache:process.env.NPM_CONFIG_CACHE,config:process.env.NPM_CONFIG_USERCONFIG,args:process.argv.slice(2),child:execFileSync(process.execPath,['-e','process.stdout.write(process.env.HOME)'],{encoding:'utf8'})}));
`, { mode: 0o700 });
    macSigningTools(bin, { fastlane: 'fastlane' });
    const alias = join(directory, 'alias');
    symlinkSync(bin, alias);
    const env = { ...process.env, HOME: '/private-build-home', BEELINE_OPERATOR_HOME: '/operator-home', NPM_CONFIG_CACHE: '', NPM_CONFIG_USERCONFIG: '', PATH: `${alias}:${bin}:${native}:${process.env.PATH}` };
    const result = JSON.parse(execFileSync(join(bin, 'fastlane'), ['gym', 'identity with spaces'], { env, encoding: 'utf8', timeout: 5000 }));
    assert.equal(result.home, '/operator-home');
    assert.equal(result.child, '/operator-home');
    assert.equal(result.cache, '/private-build-home/.npm');
    assert.equal(result.config, '/private-build-home/.npmrc');
    assert.deepEqual(result.args, ['gym', 'identity with spaces']);
    assert.equal(result.path, `${native}:${process.env.PATH}`);
    assert.equal(env.HOME, '/private-build-home');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

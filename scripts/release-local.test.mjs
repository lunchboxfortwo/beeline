import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { LocalActions, matrixRows } from './release-local-actions.mjs';
import { attribution, dryInitializeJob, dryRun, loadEnvironment, localHooks, missingReleaseCredentials, parseArguments, releaseChecks, remoteJob } from './release-local.mjs';
import { setupJava } from './release-local-java.mjs';
import { condition, evaluate, readCommandFile, render } from './release-local-expressions.mjs';
import { Processes } from './release-local-process.mjs';
import { mergeBeelineBundles } from './merge-beeline-bundles.mjs';
import { validateBundleDirectory } from './pages-site.mjs';
import { initializeRelease, planOutputs, restoreReleasePlan } from './unified-release.mjs';
import { run as bookkeeping } from './release-bookkeeping.mjs';
import { localGithub } from './release-local-github.mjs';
import { assignReleaseVersion, latestPublished, recoverTaggedReleases } from './release-record.mjs';
import { CheckQueue, checkPlan, checkWorkspace, LocalChecks } from './release-local-checks.mjs';
import { acquireReleaseLock, localAttribution, prepareReleaseSource, readOtaVersions, releaseArguments, releaseSequence } from './release.mjs';

const repository = resolve(import.meta.dirname, '..');
const temporary = () => mkdtempSync(join(tmpdir(), 'beeline-local-test-'));
const sha = 'a'.repeat(40), oldSha = 'b'.repeat(40);
test('execution is explicit and requires immutable identity and complete attribution', () => {
  assert.equal(parseArguments([]).mode, 'plan');
  assert.throws(() => parseArguments(['--execute']), /scripts\/release.mjs/);
  assert.deepEqual(releaseArguments([]), {});
  assert.throws(() => releaseArguments(['--release-sha', sha]), /Usage/);
  assert.equal(localAttribution({ username: 'firstmate', now: new Date('2026-11-14T00:00:00Z') }).auditMessageId,
    'squire-release-2026-11-14T00:00:00.000Z');
  assert.throws(() => parseArguments(['--execute', '--dry-run']), /exactly one/);
  assert.throws(() => parseArguments(['--release-sha', 'main']), /full commit/);
  assert.throws(() => parseArguments(['--channel', 'production']), /next or latest/);
  assert.throws(() => attribution('{}'), /agentId/);
  const provenance = Object.fromEntries(['agentId', 'handle', 'place', 'humanCommandMessageId', 'auditMessageId'].map(k => [k, k]));
  assert.deepEqual(attribution(JSON.stringify(provenance)), provenance);
});
test('one command completes next before promoting the same SHA with automatic store pairing', async () => {
  const calls = [], dispatchedBy = localAttribution();
  const spec = { source: '/fixture/source', sha, directory: '/fixture/state', secrets: {}, dispatchedBy, otaVersions: ['v0.1.2-rc.9'] };
  await releaseSequence(spec, async (args, options) => calls.push({ args, options }));
  assert.deepEqual(calls.map(c => [c.args.channel, c.args['store-track'], c.args['release-sha']]),
    [['next', 'beta', sha], ['latest', 'production', sha]]);
  assert.deepEqual(calls.map(c => c.args['state-dir']), ['/fixture/state/next', '/fixture/state/latest']);
  assert.ok(calls.every(c => c.options.repository === spec.source && c.args['dispatched-by'] === JSON.stringify(dispatchedBy)));
  const failed = [];
  await assert.rejects(releaseSequence(spec, async args => { failed.push(args.channel); throw new Error('next failed'); }), /next failed/);
  assert.deepEqual(failed, ['next']);
});
test('release lock clears only a dead owner and spans both channel runs', async () => {
  const directory = temporary(), lock = join(directory, 'release.lock');
  try {
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), '123\nold-state\n');
    assert.throws(() => acquireReleaseLock(lock, directory, { alive: () => true }), /already active/);
    assert.equal(readFileSync(join(lock, 'owner'), 'utf8'), '123\nold-state\n');
    const unlock = acquireReleaseLock(lock, directory, { alive: () => false });
    assert.equal(readFileSync(join(lock, 'owner'), 'utf8').split('\n')[0], String(process.pid));
    unlock();
    assert.throws(() => readFileSync(join(lock, 'owner')), /ENOENT/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('release source refreshes main and sees the rc tag created before promotion', async () => {
  const directory = temporary();
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    const upstream = join(directory, 'upstream'), operator = join(directory, 'operator'), state = join(directory, 'state');
    mkdirSync(upstream); mkdirSync(state);
    git(upstream, 'init', '--quiet', '-b', 'main');
    const commit = text => {
      writeFileSync(join(upstream, 'source'), text);
      git(upstream, 'add', 'source');
      git(upstream, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', text);
      return git(upstream, 'rev-parse', 'HEAD');
    };
    const old = commit('old');
    git(directory, 'clone', '--quiet', upstream, operator);
    const current = commit('current main');
    const prepared = prepareReleaseSource(operator, state);
    assert.equal(prepared.sha, current);
    for (const ref of ['HEAD', 'main', 'origin/main']) assert.equal(git(prepared.source, 'rev-parse', ref), current);
    assert.equal(readFileSync(join(prepared.source, 'source'), 'utf8'), 'current main');
    assert.equal(git(operator, 'rev-parse', 'HEAD'), old);
    git(upstream, 'tag', 'v0.1.2-rc.1');
    assert.throws(() => git(prepared.source, 'rev-parse', '--verify', 'refs/tags/v0.1.2-rc.1'));
    const hook = localHooks(state, new Processes({}, () => {}));
    await hook.step({ step: { id: 'identity', run: 'node scripts/release-record.mjs identity' },
      context: { github: { job: 'initialize' }, inputs: { channel: 'latest' } },
      env: { ...process.env, GITHUB_WORKSPACE: prepared.source } });
    assert.equal(git(prepared.source, 'rev-parse', 'refs/tags/v0.1.2-rc.1'), current);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('OTA branch inventory paginates so orphaned high rc numbers are reserved', async () => {
  const offsets = [];
  const versions = await readOtaVersions({ EXPO_TOKEN: 'fixture' }, async (_url, options) => {
    const offset = Number(JSON.parse(options.body).query.match(/offset:(\d+)/)[1]); offsets.push(offset);
    return Response.json({ data: { app: { byId: { updateBranches: offset === 0 ? Array.from({ length: 100 }, (_, i) => ({ name: `release-v0.1.2-rc.${i + 1}` })) : [{ name: 'release-v0.1.2-rc.110' }] } } } });
  });
  assert.deepEqual(offsets, [0, 100]);
  assert.equal(assignReleaseVersion({ releases: [], previous: { version: 'v0.1.1' }, sha, occupiedVersions: versions }).version, 'v0.1.2-rc.111');
  assert.equal(assignReleaseVersion({ releases: [], previous: { version: 'v0.1.1' }, sha, occupiedVersions: ['v0.1.2'] }).version, 'v0.1.3-rc.1');
});
test('local preflight requires user GitHub authority instead of App credentials', async () => {
  const missing = missingReleaseCredentials({ channel: 'next' }, {});
  assert.equal(missing.includes('BEELINE_GITHUB_APP_ID'), false);
  assert.equal(missing.includes('BEELINE_GITHUB_APP_PRIVATE_KEY'), false);
  assert.equal(missing.includes('GITHUB_TOKEN or GH_TOKEN'), true);
  const policy = localHooks(tmpdir(), new Processes({}, () => {}));
  await assert.rejects(policy.step({ step: { id: 'app_token' }, context: { github: { job: 'initialize' } }, result: { outputs: {} } }), /requires GITHUB_TOKEN or GH_TOKEN/);
});
test('iOS store jobs use the authorized Mac transport with only scoped credentials', async () => {
  const directory = temporary(), calls = [], messages = [];
  const secrets = { EXPO_TOKEN: 'fixture-expo-token', EXPO_ASC_KEY_ID: 'fixture-key-id', EXPO_ASC_ISSUER_ID: 'fixture-issuer',
    EXPO_ASC_API_KEY_P8: 'fixture-base64-key', FLY_API_TOKEN: 'must-stay-local' };
  const processes = new Processes(secrets, message => messages.push(message));
  processes.run = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === 'scp' && args.some(arg => arg.endsWith('/result.json'))) {
      writeFileSync(args.at(-1), JSON.stringify({ job: { result: 'success', outputs: { build_number: '109' } }, artifacts: [] }));
    }
    return '';
  };
  try {
    const engine = { directory, root: repository, secrets, variables: {}, artifacts: new Map(), macTools: '/fixture/mac-tools', processes };
    const job = parse(readFileSync(join(repository, '.github/workflows/unified-release.yml'), 'utf8')).jobs.mobile_native_ios;
    const result = await localHooks(directory, processes).job({ job, context: {
      env: {}, secrets, inputs: { channel: 'latest', store_track: 'production' }, needs: {}, matrix: {}, github: { job: 'mobile_native_ios', sha, token: 'github-fixture' },
    }, label: 'mobile_native_ios-local', engine });
    assert.equal(result?.result, 'success');
    assert.equal(result.outputs.build_number, '109');
    const remote = calls.find(call => call.command === 'ssh' && call.options.input);
    assert.ok(remote.args.includes('dani@100.104.88.126'));
    const spec = JSON.parse(remote.options.input);
    assert.deepEqual(Object.keys(spec.secrets).sort(), Object.keys(secrets).filter(name => name !== 'FLY_API_TOKEN').sort());
    assert.deepEqual(spec.context.secrets, {});
    assert.equal(spec.label, 'mobile_native_ios-local');
    assert.match(spec.job.steps.find(step => step.name === 'Isolate the iOS signing keychain').run, /security create-keychain/);
    assert.match(remote.args.at(-1), /trap .*job.json.*EXIT/);
    assert.equal(remote.options.timeout, 90 * 60_000);
    assert.ok(!messages.some(message => Object.values(secrets).some(secret => message.includes(secret))));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('remote native runner receives scoped secrets and keeps HOME and temporary output private', async () => {
  const directory = temporary(), path = join(directory, 'job.json');
  try {
    const secret = 'fixture-expo-token';
    writeFileSync(path, JSON.stringify({ label: 'mobile_native_ios-local', secrets: { EXPO_TOKEN: secret },
      variables: { BEELINE_MOBILE_SENTRY_DSN: 'fixture-dsn' }, workflowEnv: { EXPO_PUBLIC_SENTRY_DSN: '${{ vars.BEELINE_MOBILE_SENTRY_DSN }}' },
      context: { github: { job: 'mobile_native_ios', repository: 'fixture/repo', sha, run_id: 'fixture' }, inputs: {}, needs: {}, matrix: {}, steps: {}, job: { status: 'success', services: {} } },
      job: { steps: [{ id: 'upload', env: { EXPO_TOKEN: '${{ secrets.EXPO_TOKEN }}' }, run: [
        `test "$EXPO_TOKEN" = '${secret}'`,
        'test "$EXPO_PUBLIC_SENTRY_DSN" = fixture-dsn',
        'test "$HOME" = "$RUNNER_TEMP/home"',
        'test "$TMPDIR" = "$RUNNER_TEMP/tmp"',
        'echo build_number=109 >> "$GITHUB_OUTPUT"',
      ].join('\n') }], outputs: { build_number: '${{ steps.upload.outputs.build_number }}' } },
    }));
    await assert.rejects(remoteJob(path, { platform: 'linux', arch: 'x64' }), /authorized Intel Mac/);
    await remoteJob(path, { platform: 'darwin', arch: 'x64' });
    const result = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
    assert.equal(result.job.result, 'success');
    assert.equal(result.job.outputs.build_number, '109');
    assert.ok(!readFileSync(join(directory, 'state/jobs/mobile_native_ios-local/output.log'), 'utf8').includes(secret));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('both channel identity reads fetch newly published tags before consulting release records', async () => {
  const calls = [], processes = new Processes({}, () => {});
  processes.run = async (...args) => { calls.push(args); };
  const hook = localHooks('/fixture/state', processes);
  for (const channel of ['next', 'latest']) {
    const env = { GITHUB_WORKSPACE: '/fixture/source', GH_TOKEN: 'fixture-token' };
    await hook.step({ step: { id: 'identity', run: 'node scripts/release-record.mjs identity' },
      context: { github: { job: 'initialize' }, inputs: { channel } }, env });
    assert.deepEqual(calls.at(-1), ['git', ['fetch', '--tags', 'origin'], { cwd: '/fixture/source', env, quiet: true }]);
  }
});
test('local initialization routes App-token consumers through the user token without minting an installation token', async () => {
  const directory = temporary(), token = 'fixture-local-user-token', messages = [], authenticated = [];
  try {
    const workflow = parse(readFileSync(join(repository, '.github/workflows/unified-release.yml'), 'utf8'));
    const original = workflow.jobs.initialize.steps;
    const identity = original.find(step => step.id === 'identity');
    writeFileSync(join(directory, 'workflow.yml'), JSON.stringify({ jobs: { initialize: {
      steps: [
        original.find(step => step.id === 'app_token'),
        original.find(step => step.id === 'clock'),
        { id: 'read', uses: 'actions/github-script@v7', with: {
          'github-token': '${{ steps.app_token.outputs.token }}',
          script: "const r=await github.rest.repos.getReleaseByTag({tag:'vfixture'});core.setOutput('verified',r.data.tag_name==='vfixture');",
        } },
        { ...identity, env: { ...identity.env, EXPECTED_TOKEN: '${{ github.token }}' }, run: 'test "$GH_TOKEN" = "$EXPECTED_TOKEN"\necho verified=true >> "$GITHUB_OUTPUT"' },
      ],
      outputs: { shell: '${{ steps.identity.outputs.verified }}', api: '${{ steps.read.outputs.verified }}', clock: '${{ steps.clock.outputs.trigger_epoch }}' },
    } } }));
    const processes = new Processes({ GITHUB_TOKEN: token }, line => messages.push(line));
    const engine = new LocalActions({ root: directory, directory: join(directory, 'state'), secrets: { GITHUB_TOKEN: token }, processes, hooks: localHooks(directory, processes),
      github: provided => {
        authenticated.push(provided);
        return { rest: { repos: { getReleaseByTag: async ({ tag }) => ({ data: { tag_name: tag } }) } } };
      },
    });
    const results = await engine.workflow('workflow.yml', { channel: 'next' }, { github: { token, sha, repository: 'Beeline-Work/beeline', event_name: 'workflow_dispatch', run_id: '123' } });
    assert.equal(results.initialize.result, 'success');
    assert.equal(results.initialize.outputs.shell, 'true');
    assert.equal(results.initialize.outputs.api, 'true');
    assert.match(results.initialize.outputs.clock, /^\d+$/);
    assert.deepEqual(authenticated, [token]);
    assert.equal(messages.some(line => line.includes(token)), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('Play credentials are optional for OTA and required only for selected native Android delivery', async () => {
  const args = { channel: 'next' };
  assert.equal(missingReleaseCredentials(args, {}).includes('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'), false);
  assert.equal(missingReleaseCredentials(args, {}, { run_mobile_native: 'true', native_android: 'false' }).includes('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'), false);
  assert.equal(missingReleaseCredentials(args, {}, { run_mobile_native: 'true', native_android: 'true' }).includes('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'), true);
  const policy = localHooks(tmpdir(), new Processes({}, () => {}));
  const context = { secrets: {} }, step = { name: 'Produce the inspectable release plan' };
  await policy.afterStep({ step, context, result: { outputs: { run_mobile_native: 'false', native_android: 'true' } } });
  await assert.rejects(policy.afterStep({ step, context, result: { outputs: { run_mobile_native: 'true', native_android: 'true' } } }), /GOOGLE_PLAY_SERVICE_ACCOUNT_JSON/);
  context.secrets.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = 'test-only-key';
  await policy.afterStep({ step, context, result: { outputs: { run_mobile_native: 'true', native_android: 'true' } } });
});
test('Node selection honors an installed compatible repository pin through fnm', async () => {
  const directory = temporary(), calls = [];
  try {
    writeFileSync(join(directory, '.nvmrc'), '22\n');
    const processes = new Processes({}, () => {});
    processes.run = async (command, args) => { calls.push([command, args]); return JSON.stringify({ version: '22.23.2', path: '/installed/node22/bin/node' }); };
    const engine = new LocalActions({ root: directory, directory, secrets: {}, processes });
    const selected = await engine.nodeEnvironment({ PATH: '/operator/bin' });
    assert.equal(calls[0][0], 'fnm');
    assert.deepEqual(calls[0][1].slice(0, 4), ['exec', '--using', '22', 'node']);
    assert.equal(selected.PATH, '/installed/node22/bin:/operator/bin');
    writeFileSync(join(directory, '.nvmrc'), '20.11.0\n');
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ engines: { node: '24.16.0' } }));
    await engine.nodeEnvironment({ PATH: '/operator/bin' });
    assert.deepEqual(calls[1][1].slice(0, 4), ['exec', '--using', '24.16.0', 'node']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('local setup-node accepts Node 24 without fnm and rejects Node below 22', async () => {
  const directory = temporary();
  try {
    writeFileSync(join(directory, '.nvmrc'), '20.11.0\n');
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ engines: { node: '>=20.11.0' } }));
    let version = '24.16.0';
    const processes = new Processes({}, () => {});
    processes.run = async command => {
      if (command === 'fnm') throw new Error('not installed');
      return JSON.stringify({ version, path: '/installed/node/bin/node' });
    };
    const engine = new LocalActions({ root: directory, directory, secrets: {}, processes });
    const context = { env: { PATH: '/operator/bin' }, job: { status: 'success' } };
    await engine.action({ uses: 'actions/setup-node@v4', with: { 'node-version': '22' } }, context, context.env, { outputs: {} }, 1000);
    assert.equal(context.env.PATH, '/installed/node/bin:/operator/bin');
    version = '20.19.6';
    await assert.rejects(engine.nodeEnvironment({ PATH: '/operator/bin' }), /requires Node >=22/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('secret input is private data outside the checkout, never shell execution', () => {
  const directory = temporary(), env = join(directory, 'release.env');
  try {
    writeFileSync(env, 'TOKEN=$(touch never-executed)\nPRIVATE_KEY="line1\\nline2"\n', { mode: 0o600 });
    assert.deepEqual(loadEnvironment(env), { TOKEN: '$(touch never-executed)', PRIVATE_KEY: 'line1\nline2' });
    assert.throws(() => loadEnvironment(env, directory), /outside/);
    chmodSync(env, 0o644);
    assert.throws(() => loadEnvironment(env), /mode 600/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('setup-java selects a matching JDK outside PATH despite a JAVA_TOOL_OPTIONS notice', async () => {
  const directory = temporary(), home = join(directory, 'temurin');
  try {
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(join(home, 'release'), 'JAVA_VERSION="17.0.21"\nIMPLEMENTOR="Eclipse Adoptium"\n');
    for (const command of ['java', 'javac']) {
      writeFileSync(join(home, 'bin', command), '#!/bin/sh\necho "Picked up JAVA_TOOL_OPTIONS: $JAVA_TOOL_OPTIONS" >&2\necho "openjdk 17.0.21"\n', { mode: 0o700 });
    }
    writeFileSync(join(directory, 'workflow.yml'), JSON.stringify({ jobs: { java: { env: { JAVA_TOOL_OPTIONS: '-XX:ActiveProcessorCount=2' }, steps: [
      { uses: 'actions/setup-java@v4', id: 'jdk', with: { distribution: 'temurin', 'java-version': '17' } },
      { run: 'test "$(command -v java)" = "$JAVA_HOME/bin/java"\ntest "$(command -v javac)" = "$JAVA_HOME/bin/javac"\njava -version' },
    ], outputs: { version: '${{ steps.jdk.outputs.version }}', path: '${{ steps.jdk.outputs.path }}' } } } }));
    const engine = new LocalActions({ root: directory, directory: join(directory, 'state'), secrets: {}, processes: new Processes({}, () => {}), baseEnv: { PATH: '/usr/bin:/bin', JAVA_HOME: home } });
    const results = await engine.workflow('workflow.yml', {}, { github: { sha, repository: 'owner/repo' } });
    assert.equal(results.java.result, 'success');
    assert.deepEqual(results.java.outputs, { version: '17.0.21', path: home });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('setup-java uses the requested CI action for missing, wrong-version and wrong-distribution JDKs', async () => {
  const directory = temporary(), home = join(directory, 'jdk'), downloads = [], calls = [];
  try {
    mkdirSync(join(home, 'bin'), { recursive: true });
    for (const command of ['java', 'javac']) writeFileSync(join(home, 'bin', command), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    const env = { PATH: process.env.PATH, HOME: directory, JAVA_HOME: home, GITHUB_ENV: join(directory, 'env'), GITHUB_PATH: join(directory, 'path'), GITHUB_OUTPUT: join(directory, 'output') };
    const processes = new Processes({}, () => {}), originalRun = processes.run.bind(processes);
    processes.run = async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      if (command === 'tar') {
        const target = args[args.indexOf('-C') + 1];
        writeFileSync(join(target, 'action.yml'), JSON.stringify({ inputs: { 'java-package': { default: 'jdk' }, 'check-latest': { default: false } }, runs: { main: 'setup.cjs' } }));
        writeFileSync(join(target, 'setup.cjs'), `const fs=require('node:fs');
fs.writeFileSync(process.env.GITHUB_ENV, 'JAVA_HOME=/installed/temurin\\n');
fs.writeFileSync(process.env.GITHUB_PATH, '/installed/temurin/bin\\n');
fs.writeFileSync(process.env.GITHUB_OUTPUT, 'version=21.0.1\\n');`);
        return '';
      }
      return originalRun(command, args, options);
    };
    const fetchImpl = async (url, options) => { downloads.push({ url, options }); return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }; };
    for (const release of ['', 'JAVA_VERSION="17.0.21"\nIMPLEMENTOR="Eclipse Adoptium"\n', 'JAVA_VERSION="21.0.1"\nIMPLEMENTOR="Ubuntu"\n', 'JAVA_VERSION="21.0.1"\nIMPLEMENTOR="AdoptOpenJDK"\n']) {
      writeFileSync(join(home, 'release'), release);
      await setupJava({ action: 'actions/setup-java@v4', inputs: { distribution: 'temurin', 'java-version': '21' }, env, directory, processes, token: 'fixture-token', timeout: 2000, fetchImpl });
      assert.equal(readFileSync(env.GITHUB_ENV, 'utf8'), 'JAVA_HOME=/installed/temurin\n');
      assert.equal(readFileSync(env.GITHUB_PATH, 'utf8'), '/installed/temurin/bin\n');
    }
    assert.equal(downloads.length, 1);
    assert.match(downloads[0].url, /actions\/setup-java\/tarball\/v4$/);
    assert.equal(downloads[0].options.headers.Authorization, 'Bearer fixture-token');
    const setups = calls.filter(call => call.command === process.execPath);
    assert.equal(setups.length, 4);
    for (const call of setups) {
      assert.equal(call.env['INPUT_JAVA-VERSION'], '21');
      assert.equal(call.env.INPUT_DISTRIBUTION, 'temurin');
      assert.equal(call.env['INPUT_JAVA-PACKAGE'], 'jdk');
      assert.equal(call.env.RUNNER_TOOL_CACHE, join(directory, 'tool-cache'));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('nightly dispatch is unavailable locally without a network attempt or failing dependent jobs', async () => {
  const directory = temporary(), messages = [];
  try {
    const original = parse(readFileSync(join(repository, '.github/workflows/unified-release.yml'), 'utf8')).jobs.nightly_checks;
    writeFileSync(join(directory, 'workflow.yml'), JSON.stringify({ jobs: {
      nightly_checks: { ...original, needs: [], if: true },
      following: { needs: 'nightly_checks', steps: [{ run: 'true' }] },
    } }));
    const processes = new Processes({}, line => messages.push(line));
    const engine = new LocalActions({ root: directory, directory: join(directory, 'state'), secrets: {}, processes, hooks: localHooks(directory, processes) });
    const results = await engine.workflow('workflow.yml', { channel: 'next' }, { github: { sha, repository: 'owner/repo' } });
    assert.equal(results.nightly_checks.result, 'success');
    assert.equal(results.following.result, 'success');
    assert.match(messages.join('\n'), /dispatch is not available/);
    assert.match(readFileSync(join(directory, 'state/jobs/nightly_checks-local/summary.md'), 'utf8'), /GitHub Actions unavailable/);
    const hosted = new LocalActions({ root: directory, directory, secrets: {}, processes });
    let intercepted = false;
    processes.run = async () => { intercepted = true; throw new Error('hosted dispatch still runs'); };
    const hostedResults = await hosted.workflow('workflow.yml', {}, { github: { sha } });
    assert.equal(intercepted, true);
    assert.equal(hostedResults.nightly_checks.result, 'failure');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('checks-only execution uses the complete reusable release gate without initialization or delivery', async () => {
  const directory = temporary(), calls = [];
  try {
    assert.equal(parseArguments(['--execute', '--leg', 'release_checks']).leg, 'release_checks');
    assert.throws(() => parseArguments(['--execute', '--leg', 'server']), /--leg requires/);
    const workflow = parse(readFileSync(join(repository, '.github/workflows/unified-release.yml'), 'utf8'));
    const engine = {
      directory, read: () => workflow, value: render, processes: new Processes({}, () => {}),
      workflow: async (...args) => { calls.push(args); return { mobile: { result: 'success' }, optional: { result: 'skipped' } }; },
    };
    await releaseChecks(engine, { github: { sha } });
    assert.deepEqual(calls[0], [workflow.jobs.release_checks.uses, { suite: 'all', release_sha: sha }, { github: { sha } }, 'release_checks/']);
    assert.equal(JSON.parse(readFileSync(join(directory, 'release-checks.json'), 'utf8')).mobile.result, 'success');
    engine.workflow = async () => ({ mobile: { result: 'failure' } });
    await assert.rejects(releaseChecks(engine, { github: { sha } }), /Release checks failed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('the four shard queue never overlaps jobs on a shard and drains after failures', async () => {
  const active = new Set(), completed = [], starts = [], releases = [];
  let peak = 0;
  const queue = new CheckQueue({ execute: async (slot, id) => {
    assert.equal(active.has(slot), false);
    active.add(slot); starts.push(id); peak = Math.max(peak, active.size);
    await new Promise(resolveRun => releases.push(resolveRun));
    active.delete(slot); completed.push(id);
    if (id === 1) throw new Error('fixture failure');
    return slot;
  } });
  const pending = Array.from({ length: 10 }, (_, id) => queue.run(id));
  const results = Promise.allSettled(pending);
  while (completed.length < 10) {
    await new Promise(resolveRun => setImmediate(resolveRun));
    assert.ok(active.size <= 4);
    releases.splice(0).forEach(release => release());
  }
  assert.equal(peak, 4);
  assert.deepEqual(starts, Array.from({ length: 10 }, (_, id) => id));
  assert.equal((await results).filter(result => result.status === 'rejected').length, 1);
  assert.equal(active.size, 0);
});
test('parallel Checks wait for dependencies and every matrix verdict while unconfigured workflows stay sequential', async () => {
  const directory = temporary(), starts = [], releases = new Map();
  try {
    writeFileSync(join(directory, 'checks.yml'), JSON.stringify({ jobs: {
      shards: { strategy: { matrix: { shard: [1, 2, 3, 4, 5, 6, 7, 8] } }, steps: [] },
      independent: { steps: [] },
      report: { needs: ['shards', 'independent'], if: 'always()', steps: [] },
      promotion: { needs: 'shards', steps: [] },
    } }));
    const engine = new LocalActions({ root: directory, directory: join(directory, 'state'), secrets: {}, processes: new Processes({}, () => {}),
      hooks: { workflow: () => ({ parallel: true, job: async (_job, context, label) => {
        starts.push(label);
        if (context.github.job !== 'report') await new Promise(resolveRun => releases.set(label, resolveRun));
        else assert.equal(context.needs.shards.result, 'failure');
        if (context.matrix.shard === 2) throw new Error('fixture transport failure');
        return { result: 'success', outputs: { shard: String(context.matrix.shard || '') } };
      } }) },
    });
    const pending = engine.workflow('checks.yml', {}, { github: { sha, repository: 'owner/repo' } });
    await new Promise(resolveRun => setImmediate(resolveRun));
    assert.equal(starts.length, 9);
    releases.get('independent-local')();
    for (let shard = 1; shard <= 7; shard++) releases.get(`shards-${shard}`)();
    await new Promise(resolveRun => setImmediate(resolveRun));
    assert.equal(starts.includes('report-local'), false);
    releases.get('shards-8')();
    const result = await pending;
    assert.equal(result.shards.result, 'failure');
    assert.equal(result.report.result, 'success');
    assert.equal(result.promotion.result, 'skipped');
    assert.equal(starts.includes('promotion-local'), false);

    writeFileSync(join(directory, 'release.yml'), JSON.stringify({ jobs: { server: { steps: [] }, helper: { steps: [] } } }));
    engine.hooks = {};
    let concurrent = 0;
    engine.job = async () => {
      assert.equal(concurrent++, 0);
      await new Promise(resolveRun => setImmediate(resolveRun));
      concurrent--;
      return { result: 'success', outputs: {} };
    };
    await engine.workflow('release.yml', {}, { github: { sha } });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('concurrent job logs and temporary files stay private and retain secret masking', async () => {
  const directory = temporary();
  try {
    const engine = new LocalActions({ root: directory, directory, secrets: {}, processes: new Processes({ TOKEN: 'secret-fixture-token' }, () => {}), isolateTemporary: true });
    const context = { github: { sha, repository: 'owner/repo', job: 'fixture' }, job: { status: 'success' }, steps: {} };
    const results = await Promise.all(['one', 'two'].map(label => engine.job({ steps: [{ run: `echo '${label} secret-fixture-token'; sleep 0.05; echo '${label} done'; echo private > "$TMPDIR/fixture"` }] }, context, label)));
    assert.equal(results.every(result => result.result === 'success'), true);
    for (const label of ['one', 'two']) {
      const log = readFileSync(join(directory, 'jobs', label, 'output.log'), 'utf8');
      assert.match(log, new RegExp(`${label} \\*\\*\\*`));
      assert.match(log, new RegExp(`${label} done`));
      assert.doesNotMatch(log, new RegExp(`^${label === 'one' ? 'two' : 'one'} `, 'm'));
      assert.equal(log.includes('secret-fixture-token'), false);
      assert.equal(readFileSync(join(directory, 'jobs', label, 'tmp/fixture'), 'utf8'), 'private\n');
    }
    assert.equal(JSON.parse(readFileSync(join(directory, 'records.json'), 'utf8')).length, 2);
    const delivery = new LocalActions({ root: directory, directory, secrets: {}, processes: new Processes({}, () => {}), baseEnv: { PATH: process.env.PATH, TMPDIR: '/tmp' } });
    const ordinary = await delivery.job({ steps: [{ run: 'test "$TMPDIR" = /tmp' }] }, context, 'delivery');
    assert.equal(ordinary.result, 'success');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('the dry Checks plan keeps the quick release gate and lists omitted PR suites', async () => {
  const messages = [], engine = new LocalActions({ root: repository, directory: tmpdir(), secrets: {}, processes: new Processes({}, message => messages.push(message)) });
  const plan = checkPlan(engine);
  assert.deepEqual(plan.jobs.map(job => job.id), ['typecheck', 'dead-code', 'codecs']);
  for (const dropped of ['body-suite', 'server-suite-shard', 'mobile-suite', 'production-corpus-replay', 'server-claim-latency']) assert.ok(plan.dropped.includes(dropped));
  assert.equal(checkWorkspace('server-suite-shard'), 'shared build with private write layer');
  for (const writer of ['typecheck', 'dead-code', 'mobile-suite', 'mobile-export-reachability', 'native-fingerprint']) assert.equal(checkWorkspace(writer), 'private copy of build');
  engine.job = () => { throw new Error('A dry plan must not execute jobs'); };
  await dryRun({ leg: 'release_checks' }, engine, { github: { sha } });
  assert.deepEqual(JSON.parse(messages[0]), plan);
  assert.match(plan.execution, /three independent quick-check jobs/);
});
test('shard transport inherits existing slices and jails without changing their budgets or services', async () => {
  const directory = temporary(), calls = [];
  try {
    const engine = new LocalActions({ root: repository, directory, secrets: {}, processes: new Processes({}, () => {}) });
    const checks = new LocalChecks(engine);
    checks.source = directory;
    checks.shards.set(1, { name: 'beeline-ci-shard-1', slice: 'beeline-ci1.slice', pid: '123' });
    checks.privileged = async args => {
      calls.push(args);
      if (args[0] === 'systemd-run') {
        const jobDirectory = join(directory, 'jobs/release_checks-server-suite-shard-1');
        writeFileSync(join(jobDirectory, 'result.json'), JSON.stringify({ job: { result: 'success', outputs: {} }, records: [], artifacts: [] }));
      }
      return '';
    };
    const result = await checks.execute(1, { steps: [] }, { github: { sha, job: 'server-suite-shard' }, matrix: { shard: 1 } }, 'release_checks/server-suite-shard-1');
    assert.equal(result.result, 'success');
    const command = calls.find(args => args[0] === 'systemd-run');
    assert.ok(command.includes('--slice=beeline-ci1.slice'));
    assert.ok(command.includes('--user') && command.includes('--net'));
    assert.ok(command.includes(`BindReadOnlyPaths=${directory}:/build`));
    assert.ok(command.some(arg => arg.includes('lowerdir=/build,upperdir=/state/upper,workdir=/state/overlay-work')));
    assert.equal(command.some(arg => /CPUQuota|MemoryMax|registration|restart/.test(arg)), false);
    assert.equal(calls.some(args => args[0] === 'systemctl'), false);
    checks.privileged = async args => {
      if (args[0] === 'systemd-run') {
        writeFileSync(join(directory, 'jobs/release_checks-server-suite-shard-2/output.log'), 'FAIL src/fixture.test.ts > fixture failure\n');
        throw new Error('worker crashed');
      }
      if (args[0] === 'systemctl') assert.match(args[2], /^beeline-release-check-[a-f0-9]+\.service$/);
      return '';
    };
    const failed = await checks.execute(1, { steps: [] }, { github: { sha, job: 'server-suite-shard' } }, 'release_checks/server-suite-shard-2');
    assert.equal(failed.result, 'failure');
    assert.match(readFileSync(join(directory, 'jobs/release_checks-server-suite-shard-2/output.log'), 'utf8'), /FAIL src\/fixture.test.ts/);
    assert.equal(engine.records.get('release_checks/server-suite-shard-2').conclusion, 'failure');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('private HOME GitHub fetches use ephemeral credentials and redact their encoded form', async () => {
  const directory = temporary(), messages = [], token = 'fixture-private-home-token';
  const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
  try {
    const processes = new Processes({ TOKEN: token }, line => messages.push(line));
    const engine = new LocalActions({ root: directory, directory, secrets: {}, processes, hooks: localHooks(directory, processes), isolateTemporary: true });
    const result = await engine.job({ steps: [{ run: 'git config --get http.https://github.com/.extraheader > "$TMPDIR/header"; cat "$TMPDIR/header"' }] },
      { github: { sha, token, job: 'fixture', repository: 'owner/repo' }, job: { status: 'success' }, steps: {} }, 'git-auth');
    assert.equal(result.result, 'success');
    assert.equal(readFileSync(join(directory, 'jobs/git-auth/tmp/header'), 'utf8').trim(), `AUTHORIZATION: basic ${encoded}`);
    assert.equal(messages.some(line => line.includes(token) || line.includes(encoded)), false);
    assert.throws(() => readFileSync(join(directory, 'jobs/git-auth/home/.gitconfig')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('Body occupies a queue slot through a bounded host-user scope with private source and HOME', async () => {
  const directory = temporary(), calls = [];
  try {
    const engine = new LocalActions({ root: repository, directory, secrets: {}, processes: new Processes({}, () => {}) });
    const checks = new LocalChecks(engine);
    checks.shards.set(4, { name: 'beeline-ci-shard-4', slice: 'beeline-ci4.slice', pid: '456' });
    checks.privileged = async args => { calls.push(args); return ''; };
    checks.command = async (command, args) => {
      assert.equal(command, 'systemd-run');
      assert.ok(args.includes('--user') && args.includes('--scope'));
      assert.ok(args.includes('CPUQuota=300%') && args.includes('MemoryMax=12G'));
      assert.equal(args.some(arg => /nsenter|setfcap/.test(arg)), false);
      const jobDirectory = join(directory, 'jobs/release_checks-body-suite-local');
      const spec = JSON.parse(readFileSync(join(jobDirectory, 'spec.json'), 'utf8'));
      assert.equal(spec.root, join(jobDirectory, 'source'));
      assert.equal(spec.directory, jobDirectory);
      assert.match(spec.temporary, /^\/tmp\/beeline-check-[\w-]+$/);
      assert.ok(spec.temporary.length < 40);
      assert.equal(spec.context.secrets, undefined);
      writeFileSync(join(jobDirectory, 'result.json'), JSON.stringify({ job: { result: 'success', outputs: {} }, records: [], artifacts: [] }));
      return '';
    };
    const result = await checks.execute(4, { steps: [] }, { github: { sha, job: 'body-suite' }, secrets: { PRIVATE: 'never-forward' } }, 'release_checks/body-suite-local');
    assert.equal(result.result, 'success');
    assert.ok(calls.some(args => args[0] === 'cp'));
    assert.ok(calls.some(args => args[0] === 'chown' && args[2] === `${process.getuid()}:${process.getgid()}`));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('workflow expressions preserve hyphenated identifiers, booleans, defaults and failure semantics', () => {
  const context = { inputs: { run_release_proof: false }, steps: { 'local-root': { outputs: { 'cache-hit': 'true' } } }, needs: { proof: { result: 'failure' } } };
  assert.equal(evaluate("steps.local-root.outputs.cache-hit == 'true'", context), true);
  assert.equal(render('${{ inputs.run_release_proof }}', context), false);
  assert.equal(render('${{ inputs.missing || \'next\' }}', context), 'next');
  assert.equal(condition("needs.proof.result != 'success'", context, { success: false }), false);
  assert.equal(condition("always() && needs.proof.result != 'success'", context, { success: false }), true);
  assert.equal(evaluate('!cancelled()', context, { cancelled: true }), false);
  assert.deepEqual(matrixRows({ shard: [1, 2] }), [{ shard: 1 }, { shard: 2 }]);
  assert.deepEqual(readCommandFile('key<<EOF\nline1\nline2\nEOF\nnext=true\n'), { key: 'line1\nline2', next: 'true' });
});
test('adjacent workflow expressions interpolate independently while a single expression retains its type', () => {
  const context = { steps: { identity: { outputs: { version: 'v0.1.209-rc.1', release_sha: sha } } }, inputs: { enabled: false, count: 3 } };
  assert.equal(render('${{ steps.identity.outputs.version }}-${{ steps.identity.outputs.release_sha }}', context), `v0.1.209-rc.1-${sha}`);
  assert.equal(render('${{ inputs.count }}${{ inputs.enabled }}', context), '3false');
  assert.deepEqual(render({ values: ['prefix ${{ inputs.count }} / ${{ inputs.enabled }} suffix', '${{ inputs.enabled }}', '${{ inputs.count }}'] }, context), { values: ['prefix 3 / false suffix', false, 3] });
});
test('git tags discover actual published records without treating tags as successful releases', () => {
  const current = { tag_name: 'v0.1.208', draft: false, published_at: '2026-11-13T00:31:05Z' };
  const olderLine = { tag_name: 'v0.2.10', draft: false, published_at: '2026-08-01T00:00:00Z' };
  const draft = { tag_name: 'v0.1.209-rc.1', draft: true, target_commitish: oldSha };
  const called = [];
  const releases = recoverTaggedReleases(['helper-update-channel', 'v0.1.209-rc.1', 'v0.1.208', 'v0.1.208', 'v0.1.207', 'v0.2.10'], tag => {
    called.push(tag);
    return [current, olderLine, draft].find(release => release.tag_name === tag) ?? null;
  });
  assert.deepEqual(called, ['v0.1.209-rc.1', 'v0.1.208', 'v0.1.207', 'v0.2.10']);
  assert.equal(latestPublished(releases, 'next'), current);
  assert.equal(assignReleaseVersion({ releases, previous: { version: current.tag_name, sourceSha: oldSha }, sha }).version, 'v0.1.209-rc.2');
  assert.throws(() => recoverTaggedReleases(['v0.1.208'], () => null), /no published release/);
  assert.throws(() => recoverTaggedReleases(['v0.1.208'], () => { throw new Error('HTTP 403'); }), /HTTP 403/);
  assert.throws(() => recoverTaggedReleases(['v0.1.208'], () => olderLine), /another identity/);
  const tags = Array.from({ length: 120 }, (_, i) => `v0.1.${300 - i}`);
  let reads = 0;
  recoverTaggedReleases(tags, tag => { reads++; return { ...current, tag_name: tag }; });
  assert.equal(reads, 100);
});
test('empty local release listing recovers release.json and the next patch identity via direct tag reads', () => {
  const directory = temporary(), bin = join(directory, 'bin'), previousPath = join(directory, 'previous.json');
  try {
    mkdirSync(bin);
    const previous = initializeRelease({ version: 'v0.1.208', sourceSha: oldSha });
    previous.state = 'delivered';
    const git = join(bin, 'git'), gh = join(bin, 'gh');
    writeFileSync(git, '#!/bin/sh\necho v0.1.208\n');
    writeFileSync(gh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== 'api') throw new Error('Mutation is forbidden');
const endpoint = args.find(arg => arg.startsWith('repos/'));
if (endpoint.endsWith('releases?per_page=100')) console.log('[]');
else if (endpoint.endsWith('releases/tags/v0.1.208')) console.log(JSON.stringify({tag_name:'v0.1.208',draft:false,published_at:'2026-11-13T00:31:05Z',assets:[{id:42,name:'release.json'}]}));
else if (endpoint.endsWith('releases/assets/42')) console.log(${JSON.stringify(JSON.stringify(previous))});
else throw new Error('Unexpected GitHub call');
`);
    chmodSync(git, 0o700); chmodSync(gh, 0o700);
    const args = ['scripts/release-record.mjs', 'identity', '--repository', 'owner/repo', '--channel', 'next', '--sha', sha, '--previous', previousPath];
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, BEELINE_LOCAL_RELEASE: 'true' };
    const output = execFileSync(process.execPath, args, { cwd: repository, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(output, /version=v0\.1\.209-rc\.1/);
    assert.match(output, /has_release=false/);
    assert.deepEqual(JSON.parse(readFileSync(previousPath, 'utf8')), previous);
    // Hosted identity retains its original one-page behavior.
    const hosted = execFileSync(process.execPath, args, { cwd: repository, env: { ...env, BEELINE_LOCAL_RELEASE: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(hosted, /version=v0\.0\.1-rc\.1/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('dry initialize runs the committed identity and plan without creating a release', async () => {
  const workflow = parse(readFileSync(join(repository, '.github/workflows/unified-release.yml'), 'utf8'));
  const original = workflow.jobs.initialize.steps.find(step => step.id === 'identity').run;
  const job = dryInitializeJob(workflow);
  assert.match(original, /gh release create/);
  assert.doesNotMatch(job.steps.find(step => step.id === 'identity').run, /gh release create/);
  assert.match(job.steps.find(step => step.id === 'identity').run, /release-record.mjs identity/);
  assert.deepEqual(job.steps.find(step => step.id === 'plan'), workflow.jobs.initialize.steps.find(step => step.id === 'plan'));
  assert.equal(workflow.jobs.initialize.steps.find(step => step.id === 'identity').run, original);
  const directory = temporary(), labels = [];
  try {
    const engine = {
      directory, processes: { log: () => {} }, read: () => workflow,
      job: async (_job, context, label) => {
        labels.push(label);
        assert.deepEqual(context.vars, {});
        assert.deepEqual(context.secrets, {});
        if (label === 'dry-initialize') return { result: 'success', outputs: { release_version: 'v0.1.209-rc.1' } };
        assert.equal(context.inputs.release_version, 'v0.1.209-rc.1');
        return { result: 'success', outputs: {} };
      },
    };
    // Stub only costly build execution; the default ordering and the identity
    // passed to every build are exercised through the real dry-run driver.
    engine.read = file => file.endsWith('unified-release.yml') ? workflow : { runs: { steps: [] } };
    await dryRun({ channel: 'next' }, engine, { github: { sha, token: 'fixture-token' } });
    assert.deepEqual(labels, ['dry-initialize', 'dry-require-tools', 'dry-eas-cli', 'dry-server', 'dry-helper', 'dry-mobile-ota', 'dry-pages', 'dry-web-app']);
    engine.job = async () => ({ result: 'failure', outputs: {} });
    await assert.rejects(dryRun({ channel: 'next', leg: 'initialize' }, engine, { github: { sha, token: 'fixture-token' } }), /initialize failed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('workflow hashFiles hashes files in recursive inputs and ignores directory entries', () => {
  const directory = temporary();
  try {
    mkdirSync(join(directory, 'patches'));
    writeFileSync(join(directory, 'patches/change.patch'), 'bytes');
    assert.match(evaluate("hashFiles('patches/**')", {}, { root: directory }), /^[a-f0-9]{64}$/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('shell failure blocks promotion while always cleanup and failure reporting still execute', async () => {
  const directory = temporary();
  try {
    const processes = new Processes({}, () => {});
    const engine = new LocalActions({ root: directory, directory: join(directory, 'state'), secrets: {}, processes });
    writeFileSync(join(directory, 'workflow.yml'), `jobs:
  proof:
    steps:
      - run: exit 1
      - if: always()
        run: touch cleaned
  promote:
    needs: proof
    steps:
      - run: touch promoted
  report:
    needs: [proof, promote]
    if: always()
    steps:
      - id: result
        run: echo 'proof=failed' >> "$GITHUB_OUTPUT"
    outputs:
      proof: \${{ steps.result.outputs.proof }}
`);
    const results = await engine.workflow('workflow.yml', {}, { github: { sha, repository: 'owner/repo', event_name: 'workflow_dispatch', run_id: '123' } });
    assert.equal(results.proof.result, 'failure');
    assert.equal(results.promote.result, 'skipped');
    assert.equal(results.report.outputs.proof, 'failed');
    assert.equal(readFileSync(join(directory, 'cleaned'), 'utf8'), '');
    assert.throws(() => readFileSync(join(directory, 'promoted')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('composite outputs, command-file environment and artifact transfers survive local execution', async () => {
  const directory = temporary();
  try {
    mkdirSync(join(directory, '.github/actions/example'), { recursive: true });
    writeFileSync(join(directory, '.github/actions/example/action.yml'), `outputs:
  value:
    value: \${{ steps.result.outputs.value }}
runs:
  using: composite
  steps:
    - id: result
      run: |
        echo 'value=delivered' >> "$GITHUB_OUTPUT"
        echo 'COMPOSITE_VALUE=visible' >> "$GITHUB_ENV"
`);
    writeFileSync(join(directory, 'workflow.yml'), `jobs:
  build:
    steps:
      - uses: ./.github/actions/example
        id: example
      - run: test "$COMPOSITE_VALUE" = visible; mkdir out; echo artifact > out/result.txt
      - uses: actions/upload-artifact@v4
        with: {name: candidate, path: out}
    outputs:
      value: \${{ steps.example.outputs.value }}
  consume:
    needs: build
    steps:
      - uses: actions/download-artifact@v4
        with: {name: candidate, path: received}
      - run: test "$(cat received/result.txt)" = artifact
`);
    const engine = new LocalActions({ root: directory, directory: join(directory, 'state'), secrets: {}, processes: new Processes({}, () => {}) });
    const results = await engine.workflow('workflow.yml', {}, { github: { sha, repository: 'owner/repo', event_name: 'workflow_dispatch', run_id: '123' } });
    assert.equal(results.build.outputs.value, 'delivered');
    assert.equal(results.consume.result, 'success');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('cancellation prevents later publication and still permits always cleanup', async () => {
  const directory = temporary();
  try {
    const processes = new Processes({}, () => {});
    const engine = new LocalActions({ root: directory, directory: join(directory, 'state'), secrets: {}, processes,
      hooks: { afterStep: ({ step }) => { if (step.id === 'cancel') engine.cancelled = true; } },
    });
    writeFileSync(join(directory, 'workflow.yml'), `jobs:
  candidate:
    steps:
      - id: cancel
        run: 'true'
      - run: touch published
      - if: always()
        run: touch cleaned
  final:
    needs: candidate
    if: '!cancelled()'
    steps:
      - run: touch finalized
`);
    const results = await engine.workflow('workflow.yml', {}, { github: { sha, repository: 'owner/repo', event_name: 'workflow_dispatch', run_id: '123' } });
    assert.equal(results.final.result, 'skipped');
    assert.equal(readFileSync(join(directory, 'cleaned'), 'utf8'), '');
    assert.throws(() => readFileSync(join(directory, 'published')));
    assert.throws(() => readFileSync(join(directory, 'finalized')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('local latest plan restores a carried desktop set without changing helper/OTA selection', async () => {
  const directory = temporary();
  try {
    const delivered = release => {
      release.state = 'delivered';
      for (const component of Object.values(release.components)) component.state = 'checked';
      return release;
    };
    const previous = delivered(initializeRelease({ version: 'v1.2.2', sourceSha: oldSha }));
    const next = delivered(initializeRelease({ version: 'v1.2.3-rc.1', sourceSha: sha, previous, channel: 'next', selectedComponents: ['server', 'helper', 'mobile-ota'] }));
    const latest = initializeRelease({ version: 'v1.2.3', sourceSha: sha, previous, next, channel: 'latest', selectedComponents: ['helper', 'mobile-ota', 'desktop', 'website'] });
    const outputs = readCommandFile(planOutputs(latest, previous));
    mkdirSync(join(directory, 'previous'));
    writeFileSync(join(directory, 'previous/release.json'), JSON.stringify(previous));
    const policy = localHooks(directory, new Processes({}, () => {}));
    await policy.afterStep({ step: { name: 'Produce the inspectable release plan' }, context: { runner: { temp: directory } }, result: { outputs } });
    assert.equal(outputs.run_desktop, 'false');
    const restored = restoreReleasePlan({ version: latest.version, sourceSha: sha, plan: outputs, previous, next, startedAt: latest.startedAt });
    assert.equal(restored.components.desktop.state, 'carried');
    assert.equal(restored.components.desktop.desktopVersion, previous.components.desktop.desktopVersion);
    assert.equal(restored.components.helper.selected, true);
    assert.equal(restored.components['mobile-ota'].selected, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('local transport upgrades shallow fetches without changing the hosted workflow or provisioning shared tools', async () => {
  const policy = localHooks(tmpdir(), new Processes({}, () => {}));
  const step = { run: 'git fetch --no-tags --depth=1 origin "$CI_BASE_SHA"' };
  await policy.step({ step });
  assert.equal(step.run, 'git fetch --no-tags origin "$CI_BASE_SHA"');
});
test('workspace checks never shallow-fetch the repository shared by local release worktrees', () => {
  const directory = temporary();
  try {
    const bin = join(directory, 'bin'), calls = join(directory, 'git-calls');
    mkdirSync(bin);
    for (const command of ['git', 'node', 'npx', 'npm']) {
      const path = join(bin, command);
      writeFileSync(path, command === 'git'
        ? '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FETCH_CALLS"\n'
        : '#!/bin/sh\nexit 0\n');
      chmodSync(path, 0o700);
    }
    execFileSync('bash', ['scripts/ci-workspace-tasks.sh', 'typecheck'], {
      cwd: repository, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
        FETCH_CALLS: calls, CI_BASE_SHA: sha, GITHUB_EVENT_NAME: 'pull_request' },
    });
    const requests = readFileSync(calls, 'utf8').trim().split('\n');
    assert.equal(requests.length, 3);
    for (const request of requests) assert.equal(request, `fetch --no-tags origin ${sha}`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('secret masks work across chunks and dynamically registered token lines', async () => {
  const lines = [], processes = new Processes({ TOKEN: 'secret-value' }, line => lines.push(line));
  await processes.run(process.execPath, ['-e', 'process.stdout.write("::add-mask::minted-token\\n"); process.stdout.write("secret-"); setTimeout(()=>process.stdout.write("value minted-token\\n"),5)'], { env: process.env });
  assert.equal(lines.some(line => line.includes('secret-value') || line.includes('minted-token')), false);
});
test('local bookkeeping uses real local stage records and never claims a hosted run', async () => {
  const directory = temporary();
  try {
    const records = join(directory, 'records.json');
    writeFileSync(records, JSON.stringify([{ name: 'server', conclusion: 'success', started_at: '2026-11-13T12:00:00Z', completed_at: '2026-11-13T12:00:02Z' }]));
    const result = await bookkeeping({ RELEASE_VERSION: 'v1.2.3', RELEASE_SHA: sha, GITHUB_RUN_ID: '123', BEELINE_LOCAL_RELEASE_ID: 'local-test', BEELINE_LOCAL_RELEASE_RECORDS: records }, {
      fetchImpl: () => { throw new Error('Unexpected hosted API call'); }, git: () => '', log: () => {},
    });
    assert.equal(result.record.runId, undefined);
    assert.deepEqual(result.record.execution, { kind: 'local', id: 'local-test' });
    assert.equal(result.record.stages[0].seconds, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('local failure diagnostics read the completed local log without calling Actions', () => {
  const directory = temporary();
  try {
    const logFile = join(directory, 'output.log'), records = join(directory, 'records.json');
    writeFileSync(logFile, 'FAIL scripts/local-fixture.test.mjs > fixture failure\n');
    writeFileSync(records, JSON.stringify([{ id: 'local-job', name: 'release_checks/server-suite-shard-1', conclusion: 'failure', logFile }]));
    const output = execFileSync(process.execPath, ['scripts/release-test-report.mjs'], { cwd: repository, encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: directory, RELEASE_SHA: sha, PREVIOUS_SHA: '', BEELINE_LOCAL_RELEASE_RECORDS: records } });
    assert.match(output, /fixture failure/);
    assert.match(output, /No previous release SHA/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('github-script local transport preserves binary asset bytes and propagates cancellation', async () => {
  const controller = new AbortController(), bytes = Buffer.from([0, 1, 255, 128]);
  const github = localGithub('test-only-token', async (url, init) => {
    assert.match(url, /\/repos\/owner\/repo\/releases\/assets\/42$/);
    assert.equal(init.signal.aborted, false);
    return new Response(bytes);
  }, controller.signal);
  const result = await github.rest.repos.getReleaseAsset({ owner: 'owner', repo: 'repo', asset_id: 42 });
  assert.deepEqual(Buffer.from(result.data), bytes);
  controller.abort();
  const aborted = localGithub('test-only-token', async (_url, init) => { assert.equal(init.signal.aborted, true); return Response.json({}); }, controller.signal);
  await aborted.rest.repos.getReleaseByTag({ owner: 'owner', repo: 'repo', tag: 'test' });
});
test('all committed release actions remain supported and safety gates remain in the workflow', () => {
  const engine = new LocalActions({ root: repository, directory: tmpdir(), secrets: {}, processes: new Processes({}, () => {}) });
  assert.doesNotThrow(() => engine.inspect('.github/workflows/unified-release.yml'));
  const workflow = parse(readFileSync(join(repository, '.github/workflows/unified-release.yml'), 'utf8'));
  assert.equal(workflow.jobs.release_checks.with.suite, 'all');
  assert.match(workflow.jobs.mobile_ota_after_proof.steps.find(s => s.name?.startsWith('Refuse promotion')).run, /exit 1/);
  const server = readFileSync(join(repository, 'scripts/release-steps/server-leg.sh'), 'utf8');
  assert.match(server, /trap rollback_canary ERR/);
  assert.match(server, /seq 0 6/);
  assert.match(server, /server-canary-promotion/);
});

function bundle(directory, platform, commit, version) {
  mkdirSync(directory, { recursive: true });
  const file = `beeline-${platform}.tar.gz`, bytes = Buffer.from(`original-${platform}-${commit}`), hash = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(directory, file), bytes);
  writeFileSync(join(directory, `${file}.sha256`), `${hash}  ${file}\n`);
  const entry = { file, sha256: hash, bytes: bytes.length, node: '>=20.11.0', commit, version, verified: true };
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, version, sourceCommit: commit, bundles: { [platform]: entry } }));
  return entry;
}
test('Apple-silicon carry preserves old bytes/identity; corrupt archives and other mismatched platforms fail', async () => {
  const directory = temporary();
  try {
    const linux = join(directory, 'linux'), intel = join(directory, 'intel'), arm = join(directory, 'arm'), output = join(directory, 'merged');
    bundle(linux, 'linux-x64', sha, 'v1.2.3'); bundle(intel, 'darwin-x64', sha, 'v1.2.3');
    const previous = bundle(arm, 'darwin-arm64', oldSha, 'v1.2.2');
    const manifest = await mergeBeelineBundles({ outputDir: output, inputDirs: [linux, intel], carriedArm64Dir: arm });
    assert.equal(manifest.sourceCommit, sha);
    assert.equal(manifest.bundles['darwin-arm64'].commit, oldSha);
    assert.equal(manifest.bundles['darwin-arm64'].sha256, previous.sha256);
    assert.deepEqual(readFileSync(join(output, previous.file)), readFileSync(join(arm, previous.file)));
    await validateBundleDirectory(output, { expectedSha: sha, expectedVersion: 'v1.2.3' });
    manifest.bundles['linux-x64'].commit = oldSha;
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(validateBundleDirectory(output), /identity differs/);
    writeFileSync(join(arm, previous.file), 'tampered');
    await assert.rejects(mergeBeelineBundles({ outputDir: output, inputDirs: [linux, intel], carriedArm64Dir: arm }), /sha256/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('default CLI plan never requires secrets or starts release commands', () => {
  const output = execFileSync(process.execPath, ['scripts/release-local.mjs', '--plan'], { cwd: repository, encoding: 'utf8' });
  assert.match(output, /no release commands executed/);
  assert.match(output, /website not released/);
});

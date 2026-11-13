import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { LocalActions, matrixRows } from './release-local-actions.mjs';
import { attribution, dryInitializeJob, dryRun, loadEnvironment, localHooks, missingReleaseCredentials, parseArguments } from './release-local.mjs';
import { condition, evaluate, readCommandFile, render } from './release-local-expressions.mjs';
import { Processes } from './release-local-process.mjs';
import { mergeBeelineBundles } from './merge-beeline-bundles.mjs';
import { validateBundleDirectory } from './pages-site.mjs';
import { initializeRelease, planOutputs, restoreReleasePlan } from './unified-release.mjs';
import { run as bookkeeping } from './release-bookkeeping.mjs';
import { localGithub } from './release-local-github.mjs';
import { assignReleaseVersion, latestPublished, recoverTaggedReleases } from './release-record.mjs';

const repository = resolve(import.meta.dirname, '..');
const temporary = () => mkdtempSync(join(tmpdir(), 'beeline-local-test-'));
const sha = 'a'.repeat(40), oldSha = 'b'.repeat(40);
test('execution is explicit and requires immutable identity and complete attribution', () => {
  assert.equal(parseArguments([]).mode, 'plan');
  assert.throws(() => parseArguments(['--execute', '--dry-run']), /exactly one/);
  assert.throws(() => parseArguments(['--release-sha', 'main']), /full commit/);
  assert.throws(() => parseArguments(['--channel', 'production']), /next or latest/);
  assert.throws(() => attribution('{}'), /agentId/);
  const provenance = Object.fromEntries(['agentId', 'handle', 'place', 'humanCommandMessageId', 'auditMessageId'].map(k => [k, k]));
  assert.deepEqual(attribution(JSON.stringify(provenance)), provenance);
});
test('local preflight requires user GitHub authority instead of App credentials', async () => {
  const missing = missingReleaseCredentials({ channel: 'next' }, {});
  assert.equal(missing.includes('BEELINE_GITHUB_APP_ID'), false);
  assert.equal(missing.includes('BEELINE_GITHUB_APP_PRIVATE_KEY'), false);
  assert.equal(missing.includes('GITHUB_TOKEN or GH_TOKEN'), true);
  const policy = localHooks(tmpdir(), new Processes({}, () => {}));
  await assert.rejects(policy.step({ step: { id: 'app_token' }, context: { github: { job: 'initialize' } }, result: { outputs: {} } }), /requires GITHUB_TOKEN or GH_TOKEN/);
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

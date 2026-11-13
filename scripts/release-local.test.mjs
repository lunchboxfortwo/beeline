import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { LocalActions, matrixRows } from './release-local-actions.mjs';
import { attribution, loadEnvironment, localHooks, parseArguments } from './release-local.mjs';
import { condition, evaluate, readCommandFile, render } from './release-local-expressions.mjs';
import { Processes } from './release-local-process.mjs';
import { mergeBeelineBundles } from './merge-beeline-bundles.mjs';
import { validateBundleDirectory } from './pages-site.mjs';
import { initializeRelease, planOutputs, restoreReleasePlan } from './unified-release.mjs';
import { run as bookkeeping } from './release-bookkeeping.mjs';
import { localGithub } from './release-local-github.mjs';

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

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { parse } from 'yaml';
import { localHooks } from './release-local.mjs';
import { LocalActions } from './release-local-actions.mjs';
import { LocalDelivery, writeToolAdapters } from './release-local-delivery.mjs';
import { localToolPlan } from './release-local-tools.mjs';
import { droppedChecks, localWorkflow, quickChecks, releasePlan } from './release-local-policy.mjs';
import { Processes } from './release-local-process.mjs';

const root = resolve(import.meta.dirname, '..');
const read = name => parse(readFileSync(join(root, '.github/workflows', name), 'utf8'));
const temporary = () => mkdtempSync(join(tmpdir(), 'beeline-release-policy-'));
const run = promisify(execFile);

test('quick local checks retain original static gates and explicitly remove suites without changing PR checks', () => {
  const original = read('checks.yml'), snapshot = structuredClone(original), quick = quickChecks(original);
  assert.deepEqual(Object.keys(quick.jobs), ['typecheck', 'dead-code', 'codecs']);
  assert.deepEqual(quick.jobs.typecheck, original.jobs.typecheck);
  assert.deepEqual(quick.jobs['dead-code'], original.jobs['dead-code']);
  assert.equal(quick.jobs.codecs.steps.at(-1).run, 'node scripts/generate-network-codecs.mjs --check');
  assert.deepEqual(droppedChecks(original), Object.keys(original.jobs).filter(id => !['typecheck', 'dead-code'].includes(id)));
  assert.deepEqual(original, snapshot);
  const plan = releasePlan(read('unified-release.yml'), original);
  assert.equal(plan.targetSeconds, 1800);
  assert.match(plan.coverage, /no release coverage map/);
  assert.ok(plan.checks.dropped.includes('server-suite-shard'));
  assert.ok(plan.checks.dropped.includes('mobile-suite'));
  assert.ok(plan.checks.dropped.includes('body-suite'));
});

test('local delivery preserves real dependency joins and requires the quick verdict instead of nonexistent coverage', async () => {
  const original = read('unified-release.yml'), snapshot = structuredClone(original), local = localWorkflow(original);
  for (const [id, job] of Object.entries(original.jobs)) {
    assert.deepEqual(local.jobs[id].needs, id === 'helper' ? job.needs.filter(name => name !== 'delivery_result') : job.needs);
    assert.equal(local.jobs[id].if, job.if);
    if (id !== 'release_validation') assert.deepEqual(local.jobs[id], id === 'helper' ? { ...job, needs: job.needs.filter(name => name !== 'delivery_result') } : job);
  }
  assert.deepEqual(original, snapshot);
  const directory = temporary();
  try {
    for (const verdict of ['success', 'failure']) {
      const engine = new LocalActions({ root, directory: join(directory, verdict), processes: new Processes({}, () => {}) });
      const result = await engine.job(local.jobs.release_validation, {
        github: { repository: 'Beeline-Work/beeline', sha: 'a'.repeat(40), job: 'release_validation', run_id: '1' },
        needs: { release_checks: { result: verdict } }, inputs: {}, vars: {}, secrets: {}, steps: {}, job: { status: 'success' },
      }, `validation-${verdict}`);
      assert.equal(result.result, verdict);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('local latest promotion has no reusable Checks call or quick gates', async () => {
  const workflow = localWorkflow(read('unified-release.yml'), { channel: 'latest' });
  assert.equal(workflow.jobs.release_checks, undefined);
  assert.ok(Object.values(workflow.jobs).every(job => ![job.needs ?? []].flat().includes('release_checks')));
  assert.deepEqual(workflow.jobs.release_validation.steps.map(step => step.run), ['echo "Promoting the successful next commit; no checks run."']);
  const plan = releasePlan(read('unified-release.yml'), read('checks.yml'), { channel: 'latest' });
  assert.deepEqual(plan.checks.retained, []);
  const directory = temporary(), started = [];
  try {
    const engine = new LocalActions({ root, directory, processes: new Processes({}, () => {}) });
    engine.hooks.workflow = ({ workflow, inputs }) => ({ workflow: localWorkflow(workflow, inputs),
      job: async (_job, context) => {
        started.push(context.github.job);
        return { result: 'success', outputs: context.github.job === 'initialize' ? {
          channel: 'latest', run_helper: 'true', run_mobile_ota: 'true', run_website: 'true',
          run_mobile_native: 'true', native_android: 'true', native_ios: 'true',
        } : {} };
      } });
    const results = await engine.workflow('.github/workflows/unified-release.yml', { channel: 'latest', store_track: 'production' }, {
      github: { repository: 'Beeline-Work/beeline', sha: 'a'.repeat(40), run_id: '1' },
    });
    assert.equal(results.release_validation.result, 'success');
    assert.ok(!started.some(id => ['release_checks', 'typecheck', 'dead-code', 'codecs'].includes(id)));
    assert.ok(started.includes('helper') && started.includes('release_result'));
    assert.ok(started.includes('mobile_native_android') && started.includes('mobile_native_ios'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('only iOS uses the remote queue while both carried Mac helpers and Android use local slots', async () => {
  const engine = { cancelled: false }, delivery = new LocalDelivery(engine), placements = [];
  let activeMac = 0;
  delivery.execute = async (slot, _job, context) => {
    placements.push([context.github.job, slot]);
    if (slot === 4) { activeMac++; assert.equal(activeMac, 1); }
    await new Promise(resolve => setTimeout(resolve, 5));
    if (slot === 4) activeMac--;
    return { result: 'success', outputs: {} };
  };
  await Promise.all([['helper_macos', 'darwin-arm64'], ['helper_macos', 'darwin-x64'], ['mobile_native_ios'], ['mobile_native_android']].map(([id, platform]) => delivery.run({}, { github: { job: id }, matrix: { platform } }, `${id}-${platform}`)));
  assert.deepEqual(placements.filter(([, slot]) => slot === 4).map(([id]) => id), ['mobile_native_ios']);
  assert.equal(placements.filter(([id, slot]) => id === 'helper_macos' && slot < 4).length, 2);
  assert.ok(placements.some(([id, slot]) => id === 'mobile_native_android' && slot < 4));
  const plan = releasePlan(read('unified-release.yml'), read('checks.yml'), { channel: 'latest', macHelpers: 'carry' });
  assert.equal(plan.jobs.find(job => job.id === 'mobile_native_ios').placement, 'remote Mac, separate queue');
  assert.equal(plan.jobs.find(job => job.id === 'helper_macos').placement, 'bounded local queue');
  assert.match(plan.jobs.find(job => job.id === 'helper_macos').policy, /Apple-silicon and Intel Mac helpers carried unchanged/);
});

test('both Mac helper hooks reuse the published directory without invoking build commands', async () => {
  const directory = temporary(), messages = [];
  try {
    const processes = new Processes({}, message => messages.push(message));
    processes.run = async () => assert.fail('carrying a published helper must not run a build or SSH');
    const engine = { directory: join(directory, 'worker'), runDirectory: directory, artifacts: new Map(), processes, variables: {}, secrets: {} };
    const hook = localHooks(directory, processes);
    for (const arch of ['arm64', 'x64']) {
      const carried = join(directory, `carried-${arch}`), platform = `darwin-${arch}`;
      mkdirSync(carried);
      const manifest = { bundles: { [platform]: { verified: true, version: 'v1.2.2', commit: 'b'.repeat(40) } } };
      writeFileSync(join(carried, 'manifest.json'), JSON.stringify(manifest));
      const context = { env: {}, github: { job: 'helper_macos' }, matrix: { platform }, needs: { initialize: { outputs: { release_id: 'release' } } } };
      assert.deepEqual(await hook.job({ context, engine }), { result: 'success', outputs: { shipped: 'false' } });
      assert.equal(engine.artifacts.get(`daemon-${platform}-release`), carried);
      assert.equal(readFileSync(join(carried, 'manifest.json'), 'utf8'), JSON.stringify(manifest));
      manifest.bundles[platform].verified = false;
      writeFileSync(join(carried, 'manifest.json'), JSON.stringify(manifest));
      await assert.rejects(hook.job({ context, engine }), /lacks installation verification/);
    }
    const context = { env: {}, github: { job: 'helper' } };
    await hook.job({ context, engine });
    assert.equal(context.env.BEELINE_RELEASE_CARRIED_ARM64_DIR, join(directory, 'carried-arm64'));
    assert.equal(context.env.BEELINE_RELEASE_CARRIED_X64_DIR, join(directory, 'carried-x64'));
    assert.equal(messages.filter(message => message.includes('carried unchanged')).length, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the real release DAG overlaps three local legs with Mac work, carries outputs and waits for final joins', async () => {
  const directory = temporary(), started = new Set(), finished = new Set(), active = new Set();
  let peak = 0, overlap = false, helperBeforeDelivery = false;
  try {
    const controller = new LocalActions({ root, directory, processes: new Processes({}, () => {}) });
    const placement = new LocalDelivery(controller);
    placement.execute = async (_slot, _job, context) => {
      const id = context.github.job;
      started.add(id); active.add(id); peak = Math.max(peak, active.size);
      if (active.has('mobile_native_ios') && ['server', 'mobile_ota', 'website'].every(name => active.has(name))) overlap = true;
      if (id === 'helper') {
        assert.ok(finished.has('helper_linux') && finished.has('helper_macos'));
        helperBeforeDelivery = !finished.has('delivery_result');
      }
      if (id === 'release_result') {
        for (const name of ['server', 'helper', 'mobile_ota', 'website', 'delivery_result']) assert.ok(finished.has(name), name);
        assert.equal(context.needs.server.outputs.marker, 'server');
      }
      if (id === 'initialize') await new Promise(resolve => setTimeout(resolve, 1));
      else await new Promise(resolve => setTimeout(resolve, id === 'mobile_native_ios' ? 200 : ['server', 'mobile_ota', 'website'].includes(id) ? 80 : 20));
      active.delete(id); finished.add(id);
      return { result: 'success', outputs: id === 'initialize' ? {
        run_mobile_native: 'true', native_ios: 'true', release_sha: 'a'.repeat(40), run_server: 'true', run_helper: 'true', run_mobile_ota: 'true', run_website: 'true', run_desktop: 'true',
      } : { marker: id } };
    };
    // Execute the actual dependency/condition graph, substituting only job bodies.
    // Checks keep their reusable workflow boundary and their three-job profile.
    controller.hooks.workflow = ({ workflow, file }) => ({
      workflow: file.endsWith('checks.yml') ? quickChecks(workflow) : localWorkflow(workflow), parallel: true,
      job: (...args) => placement.run(...args),
    });
    const results = await controller.workflow('.github/workflows/unified-release.yml', { channel: 'next', run_release_proof: false, store_track: 'production' }, {
      github: { repository: 'Beeline-Work/beeline', sha: 'a'.repeat(40), run_id: '1' },
    });
    assert.equal(results.release_result.result, 'success');
    assert.equal(peak, 4);
    assert.ok(overlap);
    assert.ok(helperBeforeDelivery);
    assert.ok(started.has('typecheck') && started.has('dead-code') && started.has('codecs'));
    assert.equal(started.has('server-suite-shard'), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Docker and Fly image-build adapters account for daemon work in the worker slice without changing image tags', () => {
  const config = { slice: 'beeline-ci2.slice', docker: '/real/docker', flyctl: '/real/flyctl' };
  for (const args of [['build', '.'], ['run', '--rm', 'image'], ['container', 'create', 'image'], ['image', 'build', '.']]) {
    const [planned] = localToolPlan('docker', args, config);
    assert.ok(planned.args.includes('--cgroup-parent=beeline-ci2.slice'));
    assert.equal(planned.legacy, true);
  }
  assert.throws(() => localToolPlan('docker', ['build', '--cgroup-parent=other', '.'], config), /parent is owned/);
  const args = ['deploy', '.', '--app', 'beeline-server', '--dockerfile', 'apps/server/Dockerfile', '--local-only', '--build-only', '--push', '--image-label', 'sha-fixture', '--build-arg', 'RELEASE_SHA=fixture'];
  const calls = localToolPlan('flyctl', args, config);
  assert.deepEqual(calls, [
    { command: '/real/flyctl', args: ['auth', 'docker'] },
    { command: '/real/docker', args: ['build', '--cgroup-parent=beeline-ci2.slice', '--file', 'apps/server/Dockerfile', '--tag', 'registry.fly.io/beeline-server:sha-fixture', '--build-arg', 'RELEASE_SHA=fixture', '.'], legacy: true },
    { command: '/real/docker', args: ['push', 'registry.fly.io/beeline-server:sha-fixture'] },
  ]);
  const rollout = ['deploy', '--image', 'registry.fly.io/beeline-server@sha256:fixture'];
  assert.deepEqual(localToolPlan('flyctl', rollout, config), [{ command: config.flyctl, args: rollout }]);
  assert.throws(() => localToolPlan('flyctl', [...args, '--remote-only'], config), /Unsupported/);
});

test('executable tool shims stop after a failed build and keep caps on build containers', async () => {
  const directory = temporary();
  try {
    const log = join(directory, 'calls');
    const docker = join(directory, 'docker'), flyctl = join(directory, 'flyctl');
    for (const [file, code] of [[docker, 7], [flyctl, 0]]) writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit ${code}\n`, { mode: 0o700 });
    const env = writeToolAdapters(directory, { slice: 'beeline-ci3.slice', docker, flyctl });
    await assert.rejects(run(join(env.PATH, 'flyctl'), ['deploy', '.', '--app', 'beeline-free-agents', '--dockerfile', 'infra/free-agent/Dockerfile', '--local-only', '--build-only', '--push', '--image-label', 'fixture'], { env: { ...process.env, ...env } }), error => error.code === 7);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.length, 2);
    assert.equal(calls[0], 'auth docker');
    assert.match(calls[1], /build --cgroup-parent=beeline-ci3.slice/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('delivery worker round trip has private source, environment, logs, outputs and artifacts', async () => {
  const directory = temporary();
  try {
    const source = join(directory, 'repo'), state = join(directory, 'state');
    mkdirSync(source); mkdirSync(state);
    execFileSync('git', ['init', '--quiet', source]);
    writeFileSync(join(source, 'tracked'), 'immutable source');
    execFileSync('git', ['-C', source, 'add', '.']);
    execFileSync('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
    const sha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    mkdirSync(join(source, 'packages/fixture/dist'), { recursive: true });
    writeFileSync(join(source, 'packages/fixture/dist/output'), 'built fixture');
    mkdirSync(join(source, 'apps/mobile/public'), { recursive: true });
    writeFileSync(join(source, 'apps/mobile/public/canvaskit.wasm'), 'installed wasm');
    const engine = new LocalActions({ root: source, directory: state, processes: new Processes({}, () => {}), secrets: { FIXTURE_SECRET: 'do-not-log-this-secret' } });
    const delivery = new LocalDelivery(engine);
    const command = delivery.command.bind(delivery), units = [];
    delivery.command = async (tool, args, options) => {
      if (tool === 'bash') return '/usr/bin/true\n';
      if (tool !== 'sudo') return command(tool, args, options);
      units.push(args);
      const spec = args.at(-1);
      const { stdout } = await run(process.execPath, [join(root, 'scripts/release-local-check-worker.mjs'), spec], { env: process.env });
      assert.equal(stdout.includes('do-not-log-this-secret'), false);
      return stdout;
    };
    const context = { github: { repository: 'Beeline-Work/beeline', job: 'website', sha, run_id: '1' }, env: {}, vars: {}, secrets: {}, inputs: {}, needs: {}, steps: {}, job: { status: 'success' } };
    const job = { outputs: { proof: '${{ steps.proof.outputs.value }}' }, steps: [
      { id: 'proof', env: { PRIVATE_SECRET: '${{ secrets.FIXTURE_SECRET }}' }, run: [
        'test "$(cat tracked)" = "immutable source"',
        'test "$(cat packages/fixture/dist/output)" = "built fixture"',
        'test "$(cat apps/mobile/public/canvaskit.wasm)" = "installed wasm"',
        'test "$BEELINE_LOCAL_RELEASE" = true',
        'test "$TURBO_CONCURRENCY" = 1',
        'test "$TMPDIR" != /tmp',
        'docker build .', // The actual shim invokes /usr/bin/true, never Docker.
        'echo "$PRIVATE_SECRET"',
        'echo value=private-worker >> "$GITHUB_OUTPUT"',
        'printf artifact > artifact.txt',
      ].join('\n') },
      { uses: 'actions/upload-artifact@v4', with: { name: 'fixture-artifact', path: 'artifact.txt' } },
    ] };
    // Override the real Docker binary in the otherwise-real worker transport.
    const originalCommand = delivery.command;
    delivery.command = async (tool, args, options) => {
      if (tool === 'sudo') {
        const specPath = args.at(-1), spec = JSON.parse(readFileSync(specPath, 'utf8'));
        spec.tools.docker = '/usr/bin/true';
        writeFileSync(specPath, JSON.stringify(spec));
      }
      return originalCommand(tool, args, options);
    };
    const result = await delivery.execute(2, job, context, 'fixture-local');
    assert.deepEqual(result, { result: 'success', outputs: { proof: 'private-worker' } });
    assert.ok(units[0].includes('--slice=beeline-ci2.slice'));
    const record = engine.records.get('fixture-local');
    assert.equal(record.conclusion, 'success');
    const log = readFileSync(record.logFile, 'utf8');
    assert.equal(log.includes('do-not-log-this-secret'), false);
    assert.match(log, /\*\*\*/);
    assert.equal(readFileSync(join(engine.artifacts.get('fixture-artifact'), 'artifact.txt'), 'utf8'), 'artifact');
    assert.equal(readFileSync(join(source, 'tracked'), 'utf8'), 'immutable source');
    assert.equal(readFileSync(join(state, 'jobs/fixture-local/source/tracked'), 'utf8'), 'immutable source');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('delivery setup failures retain an inspectable redacted job record', async () => {
  const directory = temporary();
  try {
    const engine = new LocalActions({ root, directory, secrets: { TOKEN: 'fixture-private-token' }, processes: new Processes({ TOKEN: 'fixture-private-token' }, () => {}) });
    const delivery = new LocalDelivery(engine);
    delivery.source = async () => { throw new Error('fixture-private-token: clone failed'); };
    const result = await delivery.execute(1, {}, { github: { job: 'server' }, matrix: {} }, 'server-local');
    assert.equal(result.result, 'failure');
    const [record] = JSON.parse(readFileSync(join(directory, 'records.json'), 'utf8'));
    assert.equal(record.conclusion, 'failure');
    assert.match(readFileSync(record.logFile, 'utf8'), /\*\*\*: clone failed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { parse } from 'yaml';
import { dryRun, localHooks } from './release-local.mjs';
import { LocalActions } from './release-local-actions.mjs';
import { LocalDelivery, writeToolAdapters } from './release-local-delivery.mjs';
import { localToolPlan } from './release-local-tools.mjs';
import { droppedChecks, localWorkflow, quickChecks, releasePlan } from './release-local-policy.mjs';
import { Processes } from './release-local-process.mjs';
import { githubMacDesktop, githubMacHelpers } from './release-local-mac-github.mjs';
import { DesktopBuild } from './release-local-desktop.mjs';

const root = resolve(import.meta.dirname, '../..');
const read = name => parse(readFileSync(join(root, '.github/workflows', name), 'utf8'));
const temporary = () => mkdtempSync(join(tmpdir(), 'beeline-release-policy-'));
const run = promisify(execFile);

test('quick local checks retain original static gates and explicitly remove suites without changing PR checks', () => {
  const original = read('checks.yml'), snapshot = structuredClone(original), quick = quickChecks(original);
  assert.deepEqual(Object.keys(quick.jobs), ['typecheck', 'dead-code', 'codecs']);
  assert.deepEqual(quick.jobs.typecheck, original.jobs.typecheck);
  assert.deepEqual(quick.jobs['dead-code'], original.jobs['dead-code']);
  assert.equal(quick.jobs.codecs.steps.at(-1).run, 'node packages/scripts/generate-network-codecs.mjs --check');
  assert.deepEqual(droppedChecks(original), Object.keys(original.jobs).filter(id => !['typecheck', 'dead-code'].includes(id)));
  assert.deepEqual(original, snapshot);
  const plan = releasePlan(read('unified-release.yml'), original);
  assert.equal(plan.targetSeconds, 1800);
  assert.match(plan.coverage, /no release coverage map/);
  assert.equal(plan.checks.profile, 'quick');
  assert.deepEqual(plan.checks.retained, Object.keys(quick.jobs));
  for (const id of ['server-suite-shard', 'mobile-suite', 'body-suite', 'production-corpus-replay'])
    assert.ok(plan.checks.dropped.includes(id));
});

test('local delivery preserves real dependency joins and requires the quick verdict instead of nonexistent coverage', async () => {
  const original = read('unified-release.yml'), snapshot = structuredClone(original), local = localWorkflow(original);
  assert.deepEqual(local.jobs.release_checks.with, original.jobs.release_checks.with);
  assert.deepEqual(local.jobs.release_validation.needs, ['initialize', 'release_checks']);
  assert.equal(local.jobs.nightly_checks, undefined);
  assert.equal(local.jobs.delivery_result, undefined);
  for (const id of ['server', 'mobile_ota', 'helper', 'website', 'release_result'])
    assert.ok(local.jobs[id].needs.includes('release_validation'), id);
  for (const id of ['helper_linux', 'helper_macos', 'desktop_installers'])
    assert.deepEqual(local.jobs[id].needs, ['initialize'], id);
  for (const id of original.jobs.delivery_result.needs)
    assert.ok(local.jobs.mobile_native_android.needs.includes(id), id);
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

test('the latest path reaches only the promotion job', async () => {
  const workflow = read('unified-release.yml');
  assert.deepEqual(Object.keys(localWorkflow(workflow, { channel: 'latest' }).jobs), ['promote']);
  const directory = temporary(), started = [];
  try {
    const engine = new LocalActions({ root, directory, processes: new Processes({}, () => {}) });
    engine.hooks.workflow = () => ({
      job: async (_job, context) => {
        started.push(context.github.job);
        return { result: 'success', outputs: {} };
      },
    });
    await engine.workflow('.github/workflows/unified-release.yml', { channel: 'latest' }, {
      github: { repository: 'Beeline-Work/beeline', sha: 'a'.repeat(40), run_id: '1' },
    });
    assert.deepEqual(started, ['promote']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Mac desktop uses the separate queue while carried helpers and Android use local slots', async () => {
  const engine = { cancelled: false }, delivery = new LocalDelivery(engine), placements = [];
  let activeMac = 0;
  delivery.execute = async (slot, _job, context) => {
    placements.push([context.github.job, slot]);
    if (slot === 4) { activeMac++; assert.equal(activeMac, 1); }
    await new Promise(resolve => setTimeout(resolve, 5));
    if (slot === 4) activeMac--;
    return { result: 'success', outputs: {} };
  };
  await Promise.all([['helper_macos', 'darwin-arm64'], ['helper_macos', 'darwin-x64'], ['desktop_build', 'macos-universal'], ['mobile_native_android']].map(([id, platform]) => delivery.run({}, { github: { job: id }, matrix: { platform, label: platform } }, `${id}-${platform}`)));
  assert.deepEqual(placements.filter(([, slot]) => slot === 4).map(([id]) => id), ['desktop_build']);
  assert.equal(placements.filter(([id, slot]) => id === 'helper_macos' && slot < 4).length, 2);
  assert.ok(placements.some(([id, slot]) => id === 'mobile_native_android' && slot < 4));
  const plan = releasePlan(read('unified-release.yml'), read('checks.yml'), { channel: 'next', macHelpers: 'carry' });
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
      if (active.has('desktop_build') && ['server', 'mobile_ota', 'website'].every(name => active.has(name))) overlap = true;
      if (id === 'helper') {
        assert.ok(finished.has('helper_linux') && finished.has('helper_macos'));
        helperBeforeDelivery = !finished.has('website');
      }
      if (id === 'release_result') {
        for (const name of ['server', 'helper', 'mobile_ota', 'website', 'release_validation']) assert.ok(finished.has(name), name);
        assert.equal(context.needs.server.outputs.marker, 'server');
      }
      if (id === 'initialize') await new Promise(resolve => setTimeout(resolve, 1));
      else await new Promise(resolve => setTimeout(resolve, id === 'desktop_build' ? 200 : ['server', 'mobile_ota', 'website'].includes(id) ? 80 : 20));
      active.delete(id); finished.add(id);
      return { result: 'success', outputs: id === 'initialize' ? {
        run_mobile_native: 'true', native_android: 'true', release_sha: 'a'.repeat(40), run_server: 'true', run_helper: 'true', run_mobile_ota: 'true', run_website: 'true', run_desktop: 'true',
      } : { marker: id } };
    };
    // Execute the actual dependency/condition graph, substituting only job bodies.
    // Checks keep their reusable workflow boundary and their three-job profile.
    controller.hooks.workflow = ({ workflow, file }) => ({
      workflow: file.endsWith('checks.yml') ? quickChecks(workflow) : file.endsWith('desktop.yml') ? { jobs: {
        build: { steps: [], strategy: { matrix: { include: [{ label: 'macos-universal' }] } } },
      } } : localWorkflow(workflow), parallel: true,
      job: (job, context, ...rest) => placement.run(job, file.endsWith('desktop.yml')
        ? { ...context, github: { ...context.github, job: 'desktop_build' } } : context, ...rest),
    });
    const results = await controller.workflow('.github/workflows/unified-release.yml', { channel: 'next', run_release_proof: false, store_track: 'beta' }, {
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
    // The release leg passes the Fly config, whose dockerfile is relative to apps/infra.
    await assert.rejects(run(join(env.PATH, 'flyctl'), ['deploy', '.', '--config', 'apps/infra/fly.beeline-free-agents.toml', '--app', 'beeline-free-agents', '--local-only', '--build-only', '--push', '--image-label', 'fixture'], { env: { ...process.env, ...env } }), error => error.code === 7);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.length, 2);
    assert.equal(calls[0], 'auth docker');
    assert.match(calls[1], /build --cgroup-parent=beeline-ci3.slice --file apps\/infra\/free-agent\/Dockerfile /);
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
      if (args[1] === 'rm') return command('rm', args.slice(2), options);
      units.push(args);
      const spec = args.at(-1);
      const { stdout } = await run(process.execPath, [join(root, 'packages/scripts/release-local-check-worker.mjs'), spec], { env: process.env });
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
      if (tool === 'sudo' && args[1] === 'systemd-run') {
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
    assert.equal(existsSync(join(state, 'jobs/fixture-local/source')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('delivery setup failures retain an inspectable redacted job record', async () => {
  const directory = temporary();
  try {
    const engine = new LocalActions({ root, directory, secrets: { TOKEN: 'fixture-private-token' }, processes: new Processes({ TOKEN: 'fixture-private-token' }, () => {}) });
    const delivery = new LocalDelivery(engine);
    delivery.source = async jobDirectory => {
      mkdirSync(join(jobDirectory, 'source'));
      throw new Error('fixture-private-token: clone failed');
    };
    delivery.command = async (tool, args) => {
      assert.deepEqual([tool, ...args], ['sudo', '-n', 'rm', '-rf', join(directory, 'jobs/server-local/source')]);
      rmSync(args.at(-1), { recursive: true });
    };
    const result = await delivery.execute(1, {}, { github: { job: 'server' }, matrix: {} }, 'server-local');
    assert.equal(result.result, 'failure');
    const [record] = JSON.parse(readFileSync(join(directory, 'records.json'), 'utf8'));
    assert.equal(record.conclusion, 'failure');
    assert.match(readFileSync(record.logFile, 'utf8'), /\*\*\*: clone failed/);
    assert.equal(existsSync(join(directory, 'jobs/server-local/source')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the dispatched Mac workflow builds exactly what unified-release helper_macos builds, minus its carry', () => {
  assert.equal(read('mac-helpers.yml').env.BEELINE_HELPER_SENTRY_DSN, read('unified-release.yml').env.BEELINE_HELPER_SENTRY_DSN);
  assert.equal(read('mac-helpers.yml').env.BEELINE_HELPER_SENTRY_DSN, '${{ vars.BEELINE_HELPER_SENTRY_DSN }}');
  const hosted = read('unified-release.yml').jobs.helper_macos, github = read('mac-helpers.yml').jobs.helper_macos;
  assert.deepEqual(github.strategy, hosted.strategy);
  assert.equal(github['runs-on'], hosted['runs-on']);
  assert.equal(github.name, hosted.name);
  // Drop the hosted-only shipped/carry steps and their conditions; everything else is identical.
  const unconditional = condition => condition?.replace(/steps\.shipped\.outputs\.shipped != 'true'( && )?/g, '')
    .replace(/( && )?steps\.carry_bundle\.outcome != 'success'/g, '').replace(/ && $/, '') || undefined;
  const expected = hosted.steps.filter(step => !['shipped', 'previous_bundle', 'carry_bundle'].includes(step.id)).map(step => {
    const copy = JSON.parse(JSON.stringify(step).replaceAll('needs.initialize.outputs.release_id', 'inputs.release_version }}-${{ inputs.release_sha')
      .replaceAll('needs.initialize.outputs.', 'inputs.'));
    if (unconditional(copy.if)) copy.if = unconditional(copy.if); else delete copy.if;
    return copy;
  });
  assert.deepEqual(github.steps, expected);
  assert.deepEqual(Object.keys(read('mac-helpers.yml').permissions), ['contents']);
});

function fakeGithub({ conclusions = { 'darwin-arm64': 'success', 'darwin-x64': 'success' }, pending = 1 } = {}) {
  const calls = [];
  let requestId, polls = 0;
  const run = { id: 77, html_url: 'https://github.com/fixture/repo/actions/runs/77' };
  const processes = new Processes({ GITHUB_TOKEN: 'fixture-gh-token' }, () => {});
  processes.run = async (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, 'gh');
    if (args[0] === 'workflow') { requestId = args.at(-1).slice('request_id='.length); return ''; }
    if (args[0] === 'run' && args[1] === 'cancel') return '';
    if (args[0] === 'run' && args[1] === 'download') {
      const directory = args.at(-1);
      writeFileSync(join(directory, 'manifest.json'), args[args.indexOf('-n') + 1]);
      return '';
    }
    const path = args[1];
    if (path.includes('/workflows/mac-helpers.yml/runs')) return JSON.stringify({ workflow_runs: [
      { id: 5, display_title: 'Mac helpers v1.2.3-rc.1 · another-request' }, { ...run, display_title: `Mac helpers v1.2.3-rc.1 · ${requestId}` }] });
    if (path.endsWith('/jobs?per_page=10')) return JSON.stringify({ jobs: Object.entries(conclusions).map(([platform, conclusion]) =>
      ({ name: `HELPER BUILD (${platform})`, conclusion, html_url: `${run.html_url}/job/${platform}` })) });
    if (path.endsWith('/runs/77')) return JSON.stringify({ ...run, status: ++polls > pending ? 'completed' : 'in_progress' });
    throw new Error(`unexpected gh call ${args.join(' ')}`);
  };
  return { calls, processes };
}

test('Mac helper dry-run signals cancel the remote run and release their listeners', async () => {
  for (const outcome of ['SIGINT', 'SIGTERM', 'success', 'failure']) {
    const directory = temporary();
    const listeners = Object.fromEntries(['SIGINT', 'SIGTERM'].map(signal => [signal, process.listeners(signal)]));
    try {
      const { calls, processes } = fakeGithub({ pending: outcome.startsWith('SIG') ? Infinity : 0,
        conclusions: { 'darwin-arm64': outcome === 'failure' ? 'failure' : 'success', 'darwin-x64': 'success' } });
      const original = processes.run.bind(processes);
      processes.run = async (command, args, options) => {
        const result = await original(command, args, options);
        if (args[0] === 'api' && args[1].endsWith('/runs/77') && outcome.startsWith('SIG')) process.emit(outcome);
        return result;
      };
      const engine = new LocalActions({ root, directory, processes });
      const execution = dryRun({ leg: 'mac-helpers' }, engine, { github: { sha: 'a'.repeat(40), token: 't', repository: 'fixture/repo' } });
      if (outcome.startsWith('SIG')) {
        await assert.rejects(execution, /Mac helper build cancelled/);
        assert.equal(engine.abortController.signal.aborted, true);
        assert.deepEqual(calls.at(-1).args, ['run', 'cancel', '77', '-R', 'fixture/repo']);
      } else {
        if (outcome === 'failure') await assert.rejects(execution, /Dry-run mac-helpers failed/);
        else {
          await execution;
          const report = JSON.parse(readFileSync(join(directory, 'mac-helpers.json'), 'utf8'));
          assert.equal(report.results['darwin-arm64'].result, 'success');
          assert.equal(report.results['darwin-x64'].result, 'success');
        }
        assert.ok(calls.every(call => call.args[1] !== 'cancel'));
      }
      for (const signal of ['SIGINT', 'SIGTERM']) assert.deepEqual(process.listeners(signal), listeners[signal]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test('one GitHub run builds both Mac helpers and hands their artifacts to the helper join', async () => {
  const directory = temporary();
  try {
    const { calls, processes } = fakeGithub({ pending: 2 }), artifacts = new Map(), records = new Map(), sha = 'a'.repeat(40);
    const results = await githubMacHelpers({ processes, token: 'fixture-gh-token', repository: 'fixture/repo', sha, version: 'v1.2.3-rc.1',
      directory, artifacts, records, sleep: async () => {} });
    assert.deepEqual(results, { 'darwin-arm64': { result: 'success', outputs: { shipped: 'false' } }, 'darwin-x64': { result: 'success', outputs: { shipped: 'false' } } });
    const dispatches = calls.filter(call => call.args[0] === 'workflow');
    assert.equal(dispatches.length, 1);
    assert.deepEqual(dispatches[0].args.slice(0, 10), ['workflow', 'run', 'mac-helpers.yml', '-R', 'fixture/repo', '--ref', 'main', '-f', `release_sha=${sha}`, '-f']);
    assert.equal(dispatches[0].options.env.GH_TOKEN, 'fixture-gh-token');
    for (const platform of ['darwin-arm64', 'darwin-x64']) {
      const name = `daemon-${platform}-v1.2.3-rc.1-${sha}`;
      assert.equal(artifacts.get(name), join(directory, 'artifacts', name));
      assert.equal(readFileSync(join(artifacts.get(name), 'manifest.json'), 'utf8'), name);
      assert.equal(records.get(`helper_macos-${platform}`).conclusion, 'success');
    }
    assert.ok(calls.every(call => !call.args.includes('cancel')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a failed GitHub Mac build fails only its own leg and downloads nothing for it', async () => {
  const directory = temporary();
  try {
    const { calls, processes } = fakeGithub({ conclusions: { 'darwin-arm64': 'success', 'darwin-x64': 'failure' } }), artifacts = new Map();
    const results = await githubMacHelpers({ processes, token: 't', repository: 'fixture/repo', sha: 'b'.repeat(40), version: 'v1.2.3-rc.1',
      directory, artifacts, records: new Map(), sleep: async () => {} });
    assert.equal(results['darwin-arm64'].result, 'success');
    assert.equal(results['darwin-x64'].result, 'failure');
    assert.equal(calls.filter(call => call.args[1] === 'download').length, 1);
    assert.deepEqual([...artifacts.keys()], [`daemon-darwin-arm64-v1.2.3-rc.1-${'b'.repeat(40)}`]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a cancelled release cancels its GitHub Mac run, and an unfinished run times out', async () => {
  const directory = temporary();
  try {
    const { calls, processes } = fakeGithub({ pending: Infinity }), abort = new AbortController();
    let sleeps = 0;
    await assert.rejects(githubMacHelpers({ processes, token: 't', repository: 'fixture/repo', sha: 'c'.repeat(40), version: 'v1.2.3-rc.1',
      directory, artifacts: new Map(), signal: abort.signal, sleep: async () => { if (++sleeps === 3) throw new Error('Mac helper build cancelled'); } }), /cancelled/);
    assert.deepEqual(calls.at(-1).args.slice(0, 3), ['run', 'cancel', '77']);
    let clock = 0;
    const timedOut = fakeGithub({ pending: Infinity });
    await assert.rejects(githubMacHelpers({ processes: timedOut.processes, token: 't', repository: 'fixture/repo', sha: 'c'.repeat(40),
      version: 'v1.2.3-rc.1', directory, artifacts: new Map(), now: () => clock, sleep: async () => { clock += 60 * 60_000; } }), /did not finish within 90 minutes: https:/);
    assert.deepEqual(timedOut.calls.at(-1).args, ['run', 'cancel', '77', '-R', 'fixture/repo']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('GitHub status errors and cancellation during polling cancel the known unfinished Mac run', async () => {
  for (const failure of ['first status', 'mid-poll', 'aborted API', 'cancel error']) {
    const { calls, processes } = fakeGithub({ pending: Infinity }), original = processes.run.bind(processes);
    const abort = new AbortController(), error = new Error(failure);
    let polls = 0;
    processes.run = async (command, args, options) => {
      if (args[0] === 'api' && args[1].endsWith('/runs/77') && ++polls === (failure === 'first status' ? 1 : 2)) {
        if (failure === 'aborted API') abort.abort();
        throw error;
      }
      const result = await original(command, args, options);
      if (args[1] === 'cancel' && failure === 'cancel error') throw new Error('cancel unavailable');
      return result;
    };
    const artifacts = new Map();
    await assert.rejects(githubMacHelpers({ processes, token: 't', repository: 'fixture/repo', sha: 'c'.repeat(40),
      version: 'v1.2.3-rc.1', directory: root, artifacts, signal: abort.signal, sleep: async () => {} }), caught => caught === error);
    assert.deepEqual(calls.at(-1).args, ['run', 'cancel', '77', '-R', 'fixture/repo']);
    assert.equal(calls.filter(call => call.args[1] === 'cancel').length, 1);
    assert.equal(artifacts.size, 0);
  }
});

test('both helper_macos rows of a local release share one GitHub dispatch and never use the Mac queue', async () => {
  const directory = temporary();
  try {
    const { calls, processes } = fakeGithub({ pending: 0 });
    const engine = new LocalActions({ root, directory, processes, variables: { macHelperMode: 'build' } });
    const execution = await localHooks(directory, processes).workflow({ file: '.github/workflows/unified-release.yml', workflow: read('unified-release.yml'), inputs: {}, inherited: {}, engine });
    engine.localDelivery.run = () => assert.fail('GitHub-built Mac helpers must not enter a local or remote Mac queue');
    const sha = 'd'.repeat(40), needs = { initialize: { outputs: { release_sha: sha, release_version: 'v1.2.3-rc.1', release_id: `v1.2.3-rc.1-${sha}` } } };
    const rows = await Promise.all(['darwin-arm64', 'darwin-x64'].map(platform => execution.job({}, {
      github: { job: 'helper_macos', token: 'fixture-gh-token', repository: 'fixture/repo' }, matrix: { platform }, needs }, `helper_macos-${platform}`)));
    execution.finish();
    assert.deepEqual(rows.map(row => row.result), ['success', 'success']);
    assert.equal(calls.filter(call => call.args[0] === 'workflow').length, 1);
    for (const platform of ['darwin-arm64', 'darwin-x64']) assert.ok(engine.artifacts.has(`daemon-${platform}-${needs.initialize.outputs.release_id}`));
    assert.equal(JSON.parse(readFileSync(join(directory, 'records.json'), 'utf8')).length, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

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


test('the dispatched Mac desktop workflow retains the signed macOS production steps', () => {
  const desktop = read('desktop.yml').jobs.build, mac = read('mac-desktop.yml');
  const github = mac.jobs.build;
  const omitted = new Set([
    'Install the Linux webview toolchain', 'Select the macOS signing mode',
    'Capture Windows native notification', 'Upload native notification diagnostics',
    'Exercise codesign verification on an ad-hoc test copy', 'Prove the build produced installers',
  ]);
  const expected = desktop.steps.filter(step => !omitted.has(step.name) && step.if !== "inputs.variant != 'production'")
    .map(step => {
      const retained = structuredClone(step);
      delete retained.if;
      if (retained.uses === 'actions/checkout@v4') retained.with.ref = '${{ inputs.release_sha }}';
      if (retained.name === 'Build the desktop bundle') {
        retained.env.EXPO_PUBLIC_BEELINE_RELEASE_SHA = '${{ inputs.release_sha }}';
        retained.env.EXPO_PUBLIC_BEELINE_DESKTOP_UPDATES = '1';
      }
      return retained;
    });
  assert.deepEqual(Object.keys(mac.jobs), ['build']);
  assert.deepEqual(github.steps.map(step => step.name ?? step.uses ?? step.run), expected.map(step => step.name ?? step.uses ?? step.run));
  for (const [index, step] of github.steps.entries()) {
    const original = expected[index];
    if (['Build the desktop bundle', 'Stage stable public installer names'].includes(step.name)) {
      const { run: actualRun, ...actual } = step, { run: originalRun, ...metadata } = original;
      assert.deepEqual(actual, metadata);
    } else assert.deepEqual(step, original);
  }
  assert.deepEqual(github.strategy.matrix.include, desktop.strategy.matrix.include.filter(row => row.label === 'macos-universal'));
  for (const key of ['name', 'runs-on', 'timeout-minutes']) assert.deepEqual(github[key], desktop[key]);
  assert.equal(github.env, undefined);
  assert.deepEqual(mac.permissions, { contents: 'read' });
  assert.deepEqual(mac.defaults, read('desktop.yml').defaults);
  assert.deepEqual(Object.keys(mac.on), ['workflow_dispatch']);
  assert.deepEqual(Object.keys(mac.on.workflow_dispatch.inputs), ['release_sha', 'release_version', 'desktop_version', 'request_id']);
});

test('the Mac production build always uses its updater configuration', async () => {
  const directory = temporary();
  try {
    const bin = join(directory, 'bin'), argsPath = join(directory, 'args.json');
    mkdirSync(bin);
    writeFileSync(join(bin, 'npx'), `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.ARGS_PATH, JSON.stringify({ args: process.argv.slice(2), key: process.env.APPLE_API_KEY }));
`, { mode: 0o755 });
    const build = read('mac-desktop.yml').jobs.build.steps.find(step => step.name === 'Build the desktop bundle');
    await run('bash', ['-c', build.run.replaceAll('${{ matrix.target }}', 'universal-apple-darwin')], {
      cwd: directory,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: directory, ARGS_PATH: argsPath,
        TAURI_UPDATER_CONFIG: join(directory, 'production updater.json'), APPLE_API_KEY: 'not-for-tauri', VARIANT: 'dev' },
    });
    assert.deepEqual(JSON.parse(readFileSync(argsPath, 'utf8')), {
      args: ['tauri', 'build', '--target', 'universal-apple-darwin', '--config', join(directory, 'production updater.json')],
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the Mac production stage requires exactly the signed macOS installer set', async () => {
  const directory = temporary();
  try {
    const bundle = join(directory, 'apps/mobile/src-tauri/target/universal-apple-darwin/release/bundle');
    mkdirSync(bundle, { recursive: true });
    const staging = read('mac-desktop.yml').jobs.build.steps.find(step => step.name === 'Stage stable public installer names');
    const execute = () => run('bash', ['-c', staging.run.replaceAll('${{ matrix.target }}', 'universal-apple-darwin')], {
      cwd: directory, env: { ...process.env, RUNNER_TEMP: directory },
    });
    for (const name of ['test.dmg', 'test.app.tar.gz', 'extra.exe', 'extra.deb']) writeFileSync(join(bundle, name), name);
    await assert.rejects(execute());
    writeFileSync(join(bundle, 'test.app.tar.gz.sig'), 'signature');
    await execute();
    assert.deepEqual(readdirSync(join(directory, 'desktop-release')).sort(), [
      'Beeline-universal.app.tar.gz', 'Beeline-universal.app.tar.gz.sig', 'Beeline-universal.dmg',
    ]);
    assert.equal(readFileSync(join(directory, 'desktop-release/Beeline-universal.dmg'), 'utf8'), 'test.dmg');
    assert.equal(readFileSync(join(directory, 'desktop-release/Beeline-universal.app.tar.gz'), 'utf8'), 'test.app.tar.gz');
    assert.equal(readFileSync(join(directory, 'desktop-release/Beeline-universal.app.tar.gz.sig'), 'utf8'), 'signature');
    writeFileSync(join(bundle, 'duplicate.dmg'), 'duplicate');
    await assert.rejects(execute());
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const signedSteps = ['Notarize and staple the macOS disk image', 'Verify the signed and notarized macOS download'];
function fakeDesktopGithub({ conclusion = 'success', steps = signedSteps.map(name => ({ name, conclusion: 'success' })), artifact = () => {} } = {}) {
  const calls = [];
  let requestId;
  const run = { id: 91, html_url: 'https://github.com/fixture/repo/actions/runs/91' };
  const processes = new Processes({}, () => {});
  processes.run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command !== 'gh') throw new Error(`unexpected ${command}`);
    if (args[0] === 'workflow') { requestId = args.at(-1).slice('request_id='.length); return ''; }
    if (args[0] === 'run' && args[1] === 'download') { artifact(args.at(-1)); return ''; }
    if (args[1].includes('/workflows/mac-desktop.yml/runs')) return JSON.stringify({ workflow_runs: [{ ...run, display_title: `Mac desktop v1.2.3 · ${requestId}` }] });
    if (args[1].endsWith('/jobs?per_page=10')) return JSON.stringify({ jobs: [{ name: 'DESKTOP BUILD (macos-universal)', conclusion, steps, html_url: `${run.html_url}/job/1` }] });
    if (args[1].endsWith('/runs/91')) return JSON.stringify({ ...run, status: 'completed' });
    throw new Error(`unexpected gh call ${args.join(' ')}`);
  };
  return { calls, processes };
}

test('the macOS desktop row builds on GitHub, verifies its updater signature and never contacts the Mac host', async () => {
  const directory = temporary();
  try {
    const keys = signer(), sha = 'd'.repeat(40);
    let downloads = 0;
    const { calls, processes } = fakeDesktopGithub({ artifact: path => {
      for (const name of ['Beeline-universal.dmg', 'Beeline-universal.app.tar.gz']) writeFileSync(join(path, name), name);
      keys.sign(join(path, 'Beeline-universal.app.tar.gz'));
      // A second run returns a payload that no longer matches its updater signature.
      if (++downloads === 2) writeFileSync(join(path, 'Beeline-universal.app.tar.gz'), 'tampered');
    } });
    const engine = { processes, directory, artifacts: new Map(), abortController: new AbortController(),
      secrets: { TAURI_UPDATER_PUBLIC_KEY: keys.publicKey, TAURI_UPDATER_PRIVATE_KEY: 'private', TAURI_UPDATER_PRIVATE_KEY_PASSWORD: 'password' } };
    const context = { github: { token: 'fixture-gh-token', repository: 'fixture/repo' }, matrix: { label: 'macos-universal' },
      inputs: { release_sha: sha, release_version: 'v1.2.3', desktop_version: '0.2.9' } };
    assert.deepEqual(await new DesktopBuild(engine).row({}, context, 'desktop/mac'), { result: 'success', outputs: {} });
    assert.ok(calls.every(call => call.command === 'gh'));
    const dispatch = calls.find(call => call.args[0] === 'workflow');
    assert.deepEqual(dispatch.args.slice(0, 13), ['workflow', 'run', 'mac-desktop.yml', '-R', 'fixture/repo', '--ref', 'main',
      '-f', `release_sha=${sha}`, '-f', 'release_version=v1.2.3', '-f', 'desktop_version=0.2.9']);
    assert.equal(dispatch.options.env.GH_TOKEN, 'fixture-gh-token');
    const name = `beeline-desktop-release-v1.2.3-${sha}-macos-universal`;
    assert.equal(engine.artifacts.get(name), join(directory, 'desktop-macos-universal', name));
    await assert.rejects(new DesktopBuild(engine).row({}, context, 'desktop/mac'), /Invalid updater signature/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an unsigned, unnotarized or failed GitHub macOS desktop build is refused before any download', async () => {
  const options = { token: 't', repository: 'fixture/repo', sha: 'e'.repeat(40), releaseVersion: 'v1.2.3', desktopVersion: '0.2.9', directory: tmpdir(), sleep: async () => {} };
  const unsigned = signedSteps.map(name => ({ name, conclusion: 'skipped' }));
  for (const [fixture, message] of [[{ steps: unsigned }, /not Developer ID signed and notarized \(Notarize and staple/],
    [{ steps: [{ name: signedSteps[0], conclusion: 'success' }] }, /Verify the signed and notarized macOS download did not run/],
    [{ conclusion: 'failure' }, /Mac desktop build failed on GitHub: https:\/\/github.com\/fixture\/repo\/actions\/runs\/91\/job\/1/]]) {
    const { calls, processes } = fakeDesktopGithub(fixture);
    await assert.rejects(githubMacDesktop({ processes, ...options }), message);
    assert.ok(calls.every(call => call.args[1] !== 'download'));
  }
});

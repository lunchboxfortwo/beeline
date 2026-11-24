#!/usr/bin/env node
// Recovery legs for unified-release.yml. release.mjs owns delivery; this CLI
// only plans, builds proofs or executes the checks-only leg. See docs/release-pipeline.md for the outage policy.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalActions } from './release-local-actions.mjs';
import { Processes, loadEnvironment, privateWrite } from './release-local-process.mjs';
import { localGithub } from './release-local-github.mjs';
import { downloadPagesChannel } from './pages-channel.mjs';
import { checksWorkflow, checkPlan, LocalChecks } from './release-local-checks.mjs';
import { LocalDelivery } from './release-local-delivery.mjs';
import { localChecks, localWorkflow, quickChecks, releasePlan } from './release-local-policy.mjs';
import { DesktopBuild, WINDOWS_DESKTOP, carryWindowsInstallers, desktopDryRun, desktopWorkflow } from './release-local-desktop.mjs';
import { carryHelperPlatform } from './helper-carry.mjs';
import { githubMacHelpers } from './release-local-mac-github.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = '.github/workflows/unified-release.yml';

export function parseArguments(argv) {
  const args = { channel: 'next', mode: 'plan' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--execute', '--dry-run', '--plan'].includes(arg)) {
      if (args.explicitMode) throw new Error('Choose exactly one of --plan, --dry-run or --execute');
      args.mode = arg.slice(2); args.explicitMode = true;
    } else if (arg === '--run-release-proof') args.proof = true;
    else if (arg === '--help') args.help = true;
    else if (['--channel', '--release-sha', '--release-version', '--desktop-mode', '--mac-helpers', '--env-file', '--state-dir', '--leg', '--store-track'].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      args[arg.slice(2)] = argv[++i];
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['next', 'latest'].includes(args.channel)) throw new Error('channel must be next or latest');
  if (args['desktop-mode'] && !['build', 'carry'].includes(args['desktop-mode'])) throw new Error('desktop-mode must be build or carry');
  if (args['mac-helpers'] && !['build', 'carry'].includes(args['mac-helpers'])) throw new Error('mac-helpers must be build or carry');
  if (args['release-sha'] && !/^[0-9a-f]{40}$/.test(args['release-sha'])) throw new Error('release-sha must be a full commit SHA');
  if (args.leg && args.mode !== 'dry-run' && !(args.mode === 'execute' && args.leg === 'release_checks')) throw new Error('--leg requires --dry-run or --execute --leg release_checks');
  if (args.mode === 'execute' && args.leg !== 'release_checks') throw new Error('Use node packages/scripts/release.mjs for delivery');
  return args;
}

function outside(parent, path) { const rel = relative(parent, path); return rel === '..' || rel.startsWith('../'); }

export function attribution(text) {
  const value = JSON.parse(text || '{}');
  for (const key of ['agentId', 'handle', 'place', 'humanCommandMessageId', 'auditMessageId']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) throw new Error(`Release requires dispatched_by.${key}`);
  }
  return value;
}

export function missingReleaseCredentials(args, secrets, plan = {}) {
  const required = ['EXPO_TOKEN', 'EXPO_ASC_KEY_ID', 'EXPO_ASC_ISSUER_ID', 'EXPO_ASC_API_KEY_P8'];
  if (plan.run_website === 'true') required.push('CLOUDFLARE_PAGES_TOKEN', 'CLOUDFLARE_ACCOUNT_ID');
  if (plan.run_helper === 'true' || plan.run_desktop === 'true')
    required.push('CLOUDFLARE_R2_TOKEN', 'CLOUDFLARE_ACCOUNT_ID');
  if (plan.run_server === 'true') required.push('FLY_API_TOKEN', 'FLY_FREE_AGENT_IMAGE_TOKEN', 'MIGRATION_DATABASE_URL',
    'SERVER_CANARY_ROOM_ID', 'SERVER_CANARY_REVIEW_SECRET', 'BEELINE_FREE_AGENT_MODEL_KEY');
  if (plan.run_mobile_native === 'true' && plan.native_android === 'true') required.push('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
  const missing = [...new Set(required)].filter(name => !secrets[name]);
  if (!secrets.GITHUB_TOKEN && !secrets.GH_TOKEN) missing.push('GITHUB_TOKEN or GH_TOKEN');
  if (args.proof && !secrets.BEELINE_REVIEW_SECRET) missing.push('BEELINE_REVIEW_SECRET');
  return missing;
}

async function carryMacHelper(engine, context) {
  const platform = context.matrix.platform, arch = platform.slice('darwin-'.length);
  const directory = join(engine.runDirectory || engine.directory, `carried-${arch}`);
  if (!existsSync(join(directory, 'manifest.json'))) {
    const [owner, repo] = context.github.repository.split('/');
    await downloadPagesChannel({ github: localGithub(context.github.token, undefined, engine.abortController.signal), repo: { owner, repo }, directory, channel: context.inputs.channel });
  }
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  const bundle = manifest.bundles[platform];
  if (!bundle?.verified) throw new Error(`Published ${arch === 'arm64' ? 'Apple-silicon' : 'Intel Mac'} helper lacks installation verification`);
  engine.processes.log(`Helper ${platform} carried unchanged: ${bundle.version} ${bundle.commit}`);
  const name = `daemon-${platform}-${context.needs.initialize.outputs.release_id}`;
  engine.artifacts.set(name, directory);
  return { result: 'success', outputs: { shipped: 'false' } };
}

// Both helper_macos matrix rows share one GitHub run of mac-helpers.yml,
// dispatched by the controller; its artifacts feed the existing helper join.
function githubMacHelper(engine, context) {
  const { release_sha: sha, release_version: version } = context.needs.initialize.outputs;
  engine.macHelpers ??= githubMacHelpers({ processes: engine.processes, token: context.github.token, repository: context.github.repository,
    sha, version, directory: engine.directory, artifacts: engine.artifacts, records: engine.records, signal: engine.abortController.signal })
    .finally(() => privateWrite(join(engine.directory, 'records.json'), JSON.stringify([...engine.records.values()], null, 2)));
  return engine.macHelpers.then(results => results[context.matrix.platform]);
}

// Evidence files hold job names, times, shards and local log paths. Publish one
// only when no release secret or credential-shaped value appears in it.
const CREDENTIAL = /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|FlyV1 |-----BEGIN [A-Z ]*PRIVATE KEY|npm_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{10,}\.[\w-]{10,}\./;
export function publishableEvidence(text, secrets = []) {
  return !CREDENTIAL.test(text) && !secrets.some(secret => secret.length >= 8 && text.includes(secret));
}

export function localHooks(directory, processes, { fullChecks = false } = {}) {
  return {
    workflow: async ({ file, workflow, inputs, inherited, engine }) => {
      file = file.replace(/^\.\//, '');
      if (file === checksWorkflow) {
        const checks = new LocalChecks(engine, fullChecks);
        const selected = fullChecks ? workflow : quickChecks(workflow);
        if (!fullChecks && inputs.release_sha !== inherited.github.sha) throw new Error('Quick checks require the exact release SHA');
        await checks.prepare(inherited);
        return { workflow: selected, parallel: true, job: (...args) => checks.queue.run(...args), finish: results => {
          checks.finish();
          if (fullChecks) return;
          const resultsPath = join(directory, 'release-checks.json');
          privateWrite(resultsPath, JSON.stringify(results, null, 2));
          const timing = JSON.parse(readFileSync(join(directory, 'release-checks-timing.json'), 'utf8'));
          engine.variables.releaseChecks = { profile: 'quick', sourceSha: inputs.release_sha,
            result: localChecks.every(id => results[id]?.result === 'success') ? 'success' : 'failure', resultsPath,
            wallSeconds: timing.wallSeconds, completedAt: timing.completedAt };
        } };
      }
      if (file === WORKFLOW) {
        const delivery = new LocalDelivery(engine);
        engine.localDelivery = delivery;
        process.once('SIGINT', delivery.cancel); process.once('SIGTERM', delivery.cancel);
        const skipFullChecks = engine.variables.releaseChecks?.ownerMessageId;
        return { workflow: localWorkflow(workflow, { ...inputs, skipFullChecks }), parallel: true, job: async (...args) => {
          if (args[1].github.job === 'release_validation') {
            const checks = engine.variables.releaseChecks;
            if (checks?.sourceSha !== inherited.github.sha ||
              !(checks.result === 'success' || (checks.result === 'skipped' && skipFullChecks)))
              throw new Error('Quick checks do not authorize this release SHA');
            return engine.job(...args);
          }
          if (args[1].github.job === 'helper_macos' && engine.variables?.macHelperMode === 'build') return githubMacHelper(engine, args[1]);
          return delivery.run(...args);
        },
          finish: () => { process.removeListener('SIGINT', delivery.cancel); process.removeListener('SIGTERM', delivery.cancel); } };
      }
      if (file === '.github/workflows/desktop.yml') {
        const delivery = engine.localDelivery || new LocalDelivery(engine);
        return { workflow: desktopWorkflow(workflow), parallel: true, job: (job, context, label, env) => delivery.run(job,
          { ...context, github: { ...context.github, job: 'desktop_build' } }, label, env) };
      }
    },
    job: async args => {
      const { context, engine } = args;
      if (context.github.job === 'desktop_build') return new DesktopBuild(engine).row(args.job, context, args.label);
      context.env.BEELINE_LOCAL_RELEASE = 'true';
      context.env.BEELINE_LOCAL_OTA_VERSIONS = JSON.stringify(engine.variables.otaVersions ?? []);
      if (context.github.token) {
        // Private HOME must not depend on the operator's credential helper.
        // Config is passed via the child environment, never command arguments
        // or a persistent gitconfig; register the encoded form for redaction.
        const basic = Buffer.from(`x-access-token:${context.github.token}`).toString('base64');
        processes.mask(basic);
        const index = Number(context.env.GIT_CONFIG_COUNT || 0);
        Object.assign(context.env, { GIT_CONFIG_COUNT: String(index + 1),
          [`GIT_CONFIG_KEY_${index}`]: 'http.https://github.com/.extraheader',
          [`GIT_CONFIG_VALUE_${index}`]: `AUTHORIZATION: basic ${basic}`, GIT_TERMINAL_PROMPT: '0' });
      }
      if (['helper_linux', 'helper_macos', 'server'].includes(context.github.job)) context.env.CARGO_BUILD_JOBS = '2';
      if (context.github.job === 'helper_macos') return carryMacHelper(engine, context);
      if (context.github.job === 'helper' && engine.variables?.macHelperMode !== 'build') {
        context.env.BEELINE_RELEASE_CARRIED_ARM64_DIR = join(directory, 'carried-arm64');
        context.env.BEELINE_RELEASE_CARRIED_X64_DIR = join(directory, 'carried-x64');
      }
      if (['release_validation', 'bookkeeping'].includes(context.github.job)) {
        context.env.BEELINE_LOCAL_RELEASE_RECORDS = join(directory, 'records.json');
        context.env.BEELINE_LOCAL_RELEASE_ID = basename(directory);
      }
      if (context.github.job === 'server') {
        context.env.FLY_API_TOKEN = engine.secrets.FLY_API_TOKEN || '';
        context.env.DOCKER_CONFIG = join(context.runner.temp, 'docker');
      }
    },
    step: async ({ step, context, env, result }) => {
      if (context?.github?.job === 'initialize' && step.id === 'identity' && step.run?.includes('node packages/scripts/release-record.mjs identity')) {
        // next creates its tag in another private worker. A plain fetch may
        // omit it, and tag-based outage discovery must see it before latest.
        await processes.run('git', ['fetch', '--tags', 'origin'], { cwd: env.GITHUB_WORKSPACE, env, quiet: true });
      }
      if (step.id === 'candidate_reply' && context?.github?.job === 'server') {
        for (const key of ['BEELINE_FREE_AGENT_MODEL_KEY', 'BEELINE_FREE_AGENT_MODEL', 'BEELINE_FREE_AGENT_MODEL_UPSTREAM'])
          if (context.secrets[key]) env[key] = context.secrets[key];
      }
      if (step.id === 'app_token' && context?.github?.job === 'initialize') {
        const token = context.github.token;
        if (!token) throw new Error('Local GitHub initialization requires GITHUB_TOKEN or GH_TOKEN');
        processes.mask(token);
        // Preserve the workflow's token output wiring while bypassing the
        // App-only installation lookup/mint, which is unavailable locally.
        result.outputs.token = token;
        processes.log('Local GitHub initialization uses the configured user token; no App installation token is minted.');
        return true;
      }
      if (step.name === 'Record dispatch clock') {
        result.outputs.trigger_epoch = String(Math.floor(Date.now() / 1000));
        return true;
      }
      // Provisioning a hosted VM is replaced by checking already installed
      // tools. Never change squire's /usr/bin or apt packages from a release.
      if (step.run?.startsWith('sudo ln -sf')) {
        await processes.run('node', ['--version'], { env, quiet: true }); return true;
      }
      if (step.run?.startsWith('sudo apt-get')) {
        const command = step.run.includes('bubblewrap') ? 'command -v bwrap' : 'pkg-config --exists webkit2gtk-4.1 gtk+-3.0';
        await processes.run('bash', ['-c', command], { env, quiet: true }); return true;
      }
      // A shallow fetch changes the repository shared by every worktree.
      if (step.run?.includes('git fetch')) {
        step.run = step.run.replace(/--depth(?:=|\s+)\d+\s*/g, '');
        if (/git fetch[^\n]*--shallow/.test(step.run)) throw new Error('A local release must not shallow-fetch the shared repository');
      }
      if (step.name === 'Build the signed desktop update manifest' && WINDOWS_DESKTOP !== 'build') {
        await carryWindowsInstallers(join(env.RUNNER_TEMP, 'desktop-release'));
        if (!step.run.includes('--omit windows-x86_64')) {
          const run = step.run.replace('desktop-update.mjs manifest \\', 'desktop-update.mjs manifest --omit windows-x86_64 \\');
          if (run === step.run) throw new Error('Cannot omit Windows from the desktop updater manifest');
          step.run = run;
        }
        processes.log('Windows desktop skipped: published Windows installers carried unchanged; the updater manifest omits Windows.');
      }
    },
    afterStep: async ({ step, context, env, result, engine }) => {
      if (step.name === 'Produce the inspectable release plan' && result.outputs.run_helper === 'true' && engine?.variables?.macHelperMode === 'carry') {
        const previous = JSON.parse(readFileSync(join(context.runner.temp, 'previous/release.json'), 'utf8'));
        for (const [platform, bundle] of Object.entries(previous.components.helper.platforms || {}))
          if (platform.startsWith('darwin-')) carryHelperPlatform(platform, bundle);
      }
      if (step.id === 'plan' && context.github?.job === 'initialize' && context.inputs?.dispatched_by) {
        const missing = missingReleaseCredentials({ proof: context.inputs.run_release_proof }, context.secrets, result.outputs);
        if (missing.length) throw new Error(`Missing local release credentials: ${missing.join(', ')}`);
        const publish = result.outputs.run_helper === 'true' && engine.read(WORKFLOW).jobs.npm_publish;
        if (result.outputs.run_helper === 'true' && publish?.permissions?.['id-token'] !== 'write')
          throw new Error('The helper requires the npm trusted-publishing job');
      }
      if (step.name === 'Finalize the release record') {
        const path = join(context.runner.temp, 'release/release.json');
        const record = JSON.parse(readFileSync(path, 'utf8'));
        delete record.runId;
        record.execution = { kind: 'local', id: basename(directory), dispatchedBy: JSON.parse(context.inputs.dispatched_by) };
        const checks = { ...engine.variables.releaseChecks };
        if (checks.resultsPath && existsSync(checks.resultsPath)) {
          copyFileSync(checks.resultsPath, join(dirname(path), 'release-checks.json'));
          const releaseUrl = `https://github.com/${context.github.repository}/releases/download/${record.version}`;
          // Per-job attempts and timing let CI history work from release assets alone.
          for (const [name, key] of [['records.json', 'recordsPath'], ['release-checks-timing.json', 'timingPath']]) {
            const evidence = join(dirname(checks.resultsPath), name);
            if (!existsSync(evidence)) continue;
            const saved = readFileSync(evidence, 'utf8');
            const text = name === 'records.json'
              ? JSON.stringify(JSON.parse(saved).filter(job => job.id.startsWith('release_checks/')), null, 2)
              : saved;
            if (!publishableEvidence(text, [...(processes.masks ?? [])])) {
              (processes.log ?? console.warn)(`${name} is not published: it contains a credential-shaped value.`);
              continue;
            }
            privateWrite(join(dirname(path), name), text);
            checks[key] = `${releaseUrl}/${name}`;
          }
          checks.resultsPath = `${releaseUrl}/release-checks.json`;
        }
        record.checks = checks;
        // Live delivery time split into the quick checks and the deploy after them.
        const live = record.delivery.live;
        if (live) {
          const checked = checks.completedAt
            ? Math.round(Date.parse(checks.completedAt) / 1000) : live.triggerEpoch;
          const deployStart = Math.min(live.completedAt, Math.max(live.triggerEpoch, checked));
          live.checksSeconds = deployStart - live.triggerEpoch;
          live.deploySeconds = live.completedAt - deployStart;
          // Per-step seconds of the live legs.
          const records = join(directory, 'records.json');
          if (existsSync(records)) {
            const legs = { 'server-local': 'server', 'mobile_ota-local': 'mobile-ota' };
            const profile = Object.fromEntries(JSON.parse(readFileSync(records, 'utf8'))
              .filter(job => legs[job.id] && job.steps?.length)
              .map(job => [legs[job.id], job.steps.map(({ name, seconds }) => ({ name, seconds }))]));
            if (Object.keys(profile).length) live.profile = profile;
          }
        }
        record.delivery.localExceptions = { staticWebsite: 'staged on Cloudflare Pages',
          helperArm64: engine.variables.macHelperMode === 'build' ? 'built and install-verified on GitHub-hosted macos-15' : 'carried unchanged',
          helperX64: engine.variables.macHelperMode === 'build' ? 'built and install-verified on GitHub-hosted macos-15-intel' : 'carried unchanged',
          desktop: WINDOWS_DESKTOP === 'build' ? 'native signed updater builds on a GitHub-hosted macOS runner, squire and Windows VM'
              : 'native signed updater builds on a GitHub-hosted macOS runner and squire; Windows installers carried unchanged and omitted from the updater manifest' };
        record.delivery.localExceptions.checks = checks;
        const helperJob = join(directory, 'jobs/helper-local');
        const helperManifest = ['daemon-release/manifest.json', 'helper-linux/served-manifest.json']
          .map(path => join(helperJob, path)).find(existsSync);
        if (helperManifest) record.components.helper.platforms = JSON.parse(readFileSync(helperManifest, 'utf8')).bundles;
        const previousPath = join(context.runner.temp, 'previous/release.json');
        if (existsSync(previousPath)) {
          const previous = JSON.parse(readFileSync(previousPath, 'utf8'));
          // The release record also counts releases that carried the whole
          // helper without republishing its channel manifest.
          if (helperManifest) for (const [platform, bundle] of Object.entries(record.components.helper.platforms)) {
            const prior = previous.components.helper.platforms?.[platform];
            if (bundle.carriedFrom && prior?.sha256 === bundle.sha256 && prior.commit === bundle.commit)
              record.components.helper.platforms[platform] = carryHelperPlatform(platform, prior);
          }
        }
        if (record.delivery.live?.components?.website?.state === 'success') record.delivery.live.components.website.scope = 'preview';
        privateWrite(path, `${JSON.stringify(record, null, 2)}\n`);
      }
    },
  };
}

export function dryInitializeJob(workflow) {
  const job = structuredClone(workflow.jobs.initialize);
  const identity = job.steps.find(step => step.id === 'identity');
  const reserve = /^\s*gh release create[^\n]+$/m;
  if (!reserve.test(identity.run)) throw new Error('Cannot identify the release reservation command for dry-run');
  identity.run = identity.run.replace(reserve, "            echo 'Dry run: identity is not reserved; no draft release created.'");
  // Attribution is mandatory for a real dispatch. A read-only build proof
  // without a receipt must not invent one or describe itself as a dispatch.
  job.steps = job.steps.filter(step => step.name !== 'Verify release dispatch attribution');
  return job;
}

export async function dryRun(args, engine, context) {
  if (args.leg === 'desktop') { await desktopDryRun(engine, context); return; }
  if (args.leg === 'release') {
    engine.processes.log(JSON.stringify(releasePlan(engine.read(WORKFLOW), engine.read(checksWorkflow), args), null, 2));
    return;
  }
  if (args.leg === 'release_checks') {
    engine.processes.log(JSON.stringify(checkPlan(engine, { fullChecks: true }), null, 2));
    return;
  }
  context = { ...context, vars: engine.variables || {}, secrets: engine.secrets || {}, env: {} };
  const legs = args.leg ? [args.leg] : ['initialize', 'require-tools', 'eas-cli', 'server', 'helper', 'mobile-ota', 'pages', 'web-app'];
  const sha = context.github.sha;
  let version = 'v0.0.0-rc.1';
  for (const leg of legs) {
    engine.processes.log(`Dry-run build: ${leg}; no publication, migration, channel move or rollout`);
    if (leg === 'initialize') {
      if (!context.github.token) throw new Error('Dry-run initialize requires --env-file with GITHUB_TOKEN or GH_TOKEN');
      const inputs = { channel: args.channel, release_sha: sha, release_version: '', selection: 'auto', store_track: args['store-track'] || 'none', run_release_proof: false };
      const job = await engine.job(dryInitializeJob(engine.read(WORKFLOW)), { ...context, inputs, matrix: {}, needs: {}, steps: {}, github: { ...context.github, job: 'initialize' } }, 'dry-initialize', engine.read(WORKFLOW).env);
      privateWrite(join(engine.directory, 'dry-initialize.json'), JSON.stringify(job, null, 2));
      if (job.result !== 'success') throw new Error('Dry-run initialize failed; no release was attempted');
      version = job.outputs.release_version;
      continue;
    }
    let steps;
    if (leg === 'server') steps = [{ run: `docker build --file apps/server/Dockerfile --tag beeline-release-dry-${createHash('sha256').update(engine.directory).digest('hex').slice(0, 12)} --build-arg "BEELINE_RELEASE_SHA=$GITHUB_SHA" --build-arg "BEELINE_RELEASE_VERSION=$DRY_RELEASE_VERSION" .`, env: { DRY_RELEASE_VERSION: version } }];
    else if (leg === 'helper') steps = [
      { uses: 'dtolnay/rust-toolchain@1.95.0' },
      { uses: './.github/actions/buzz-agent-cache', with: { platform: 'linux-x64' } },
      { run: 'npm run bundle:beeline -- --platform linux-x64', env: { BEELINE_BUNDLE_COMMIT: sha, BEELINE_BUNDLE_VERSION: version, CARGO_BUILD_JOBS: '2' } },
    ];
    else if (leg === 'mobile-ota') steps = [...engine.read('.github/actions/mobile-ota-leg/action.yml').runs.steps.slice(0, 1), { run: 'npx --no-install expo export --platform all --output-dir "$RUNNER_TEMP/ota-export"', 'working-directory': 'apps/mobile', env: { EXPO_PUBLIC_BUZZY_MONOLITH_URL: 'https://server.usebeeline.app' } }];
    else if (leg === 'pages') steps = engine.read('.github/actions/pages-leg/action.yml').runs.steps.slice(0, 1);
    else if (leg === 'web-app') steps = engine.read('.github/actions/web-app-leg/action.yml').runs.steps.filter(step => ['Install mobile dependencies', 'Export the production web bundle', 'Verify the push worker is in the export', 'Stamp the immutable release identity'].includes(step.name));
    else if (leg === 'mac-helpers') {
      if (!context.github.token) throw new Error('Dry-run mac-helpers requires --env-file with GITHUB_TOKEN or GH_TOKEN');
      const cancel = () => engine.abortController.abort();
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
      try {
        const results = await githubMacHelpers({ processes: engine.processes, token: context.github.token, repository: context.github.repository,
          sha, version: args['release-version'] || version, directory: engine.directory, artifacts: engine.artifacts, records: engine.records, signal: engine.abortController.signal });
        privateWrite(join(engine.directory, 'mac-helpers.json'), JSON.stringify({ results, artifacts: [...engine.artifacts] }, null, 2));
        if (Object.values(results).some(result => result.result !== 'success')) throw new Error('Dry-run mac-helpers failed; no release was attempted');
      } finally {
        process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
      }
      continue;
    }
    else if (['eas-cli', 'require-tools'].includes(leg)) steps = [{ uses: `./.github/actions/${leg}`, with: leg === 'require-tools' ? { tools: 'node git docker ssh tar curl' } : {} }];
    else throw new Error(`Unknown dry-run leg: ${leg}`);
    const job = await engine.job({ steps, 'timeout-minutes': 45 }, { ...context, inputs: { release_sha: sha, release_version: version }, matrix: {}, needs: {}, steps: {}, job: { status: 'success', services: {} } }, `dry-${leg}`);
    if (job.result !== 'success') throw new Error(`Dry-run ${leg} failed; no release was attempted`);
  }
  engine.processes.log('Build proofs complete. Canary, migrations, live update proof and rollback were not exercised against production.');
}

export async function releaseChecks(engine, context) {
  const call = engine.read(WORKFLOW).jobs.release_checks;
  // A nightly run must include suites excluded from the pre-delivery release gate.
  const inputs = { suite: 'all', release_sha: '', pinned_sha: context.github.sha };
  const results = await engine.workflow(call.uses, inputs, context, 'release_checks/');
  privateWrite(join(engine.directory, 'release-checks.json'), JSON.stringify(results, null, 2));
  if (Object.values(results).some(result => ['failure', 'cancelled'].includes(result.result))) throw new Error(`Release checks failed; inspect private results under ${engine.directory}`);
  engine.processes.log('Release checks complete; no release identity reserved or delivery attempted.');
  return results;
}

export async function runLocalRelease(args, { repository = root, secrets: providedSecrets } = {}) {
  const root = repository;
  if (args.help) { console.log('node packages/scripts/release-local.mjs [--plan | --dry-run [--leg release|release_checks|initialize|server|helper|mobile-ota|pages|web-app|eas-cli|require-tools|mac-helpers|desktop] | --execute --leg release_checks] [--channel next|latest] [--release-sha <40-char SHA>] [--release-version vX.Y.Z] [--desktop-mode build|carry] [--mac-helpers build|carry] [--env-file ~/.config/beeline-release.env] [--run-release-proof] [--store-track none|beta|production] [--state-dir /outside/repo]'); return; }
  if (args.channel === 'latest') {
    if (args.mode === 'plan') {
      console.log('Latest moves the published next candidate through the unified workflow promote job.');
      return;
    }
    throw new Error('Use release.mjs --promote for latest. Run release checks independently of promotion.');
  }
  if (process.platform !== 'linux') throw new Error('Run the release controller on Linux squire');
  const sha = args['release-sha'] || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const directory = resolve(args['state-dir'] || join(tmpdir(), `beeline-release-${Date.now()}`));
  if (!outside(root, directory)) throw new Error('Release state must be outside the repository');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!outside(root, realpathSync(directory))) throw new Error('Release state symlink points inside the repository');
  const envFile = resolve(args['env-file'] || join(homedir(), '.config/beeline-release.env'));
  const secrets = providedSecrets ?? (args.mode === 'execute' || (args.mode === 'dry-run' && args['env-file']) ? loadEnvironment(envFile, root) : {});
  if (!secrets.GITHUB_TOKEN && secrets.GH_TOKEN) secrets.GITHUB_TOKEN = secrets.GH_TOKEN;
  const processes = new Processes(secrets);
  const variables = { releaseChecks: args.skipFullChecks && { profile: 'quick', sourceSha: sha, result: 'skipped', ownerMessageId: args.skipFullChecks }, otaVersions: args.otaVersions ?? [], desktopMode: args['desktop-mode'] || 'build', desktopReleaseVersion: args['release-version'], macHelperMode: args['mac-helpers'] || 'build',
    CLOUDFLARE_ACCOUNT_ID: secrets.CLOUDFLARE_ACCOUNT_ID || '', BEELINE_HELPER_SENTRY_DSN: secrets.BEELINE_HELPER_SENTRY_DSN || '', BEELINE_MOBILE_SENTRY_DSN: secrets.BEELINE_MOBILE_SENTRY_DSN || '' };
  const engine = new LocalActions({ root, directory, secrets, variables, processes, github: localGithub, hooks: localHooks(directory, processes, { fullChecks: args.leg === 'release_checks' }) });
  engine.inspect(WORKFLOW);
  const context = { github: { repository: 'lunchboxfortwo/beeline', sha, run_id: String(Math.floor(Date.now() / 1000)), run_attempt: '1', event_name: 'workflow_dispatch', event: {}, actor: 'local-release', token: secrets.GITHUB_TOKEN || secrets.GH_TOKEN || '' }, runner: {}, job: { status: 'success' } };
  if (args.mode === 'plan') {
    console.log(`Local ${args.channel} release at ${sha}; no release commands executed.`);
    console.log(JSON.stringify(releasePlan(engine.read(WORKFLOW), engine.read(checksWorkflow), args), null, 2));
    console.log('Website staging publishes static assets to Cloudflare Pages and the web app to EAS previews.');
    console.log(`Mac helper mode: ${variables.macHelperMode}; ARM and Intel helpers build on GitHub-hosted macos-15 and macos-15-intel runners. Desktop mode: ${variables.desktopMode}; builds use a GitHub-hosted macOS runner (mac-desktop.yml), squire${WINDOWS_DESKTOP === 'build' ? ' and the Windows VM' : '; Windows is skipped and its published installers carried'}.`);
    return;
  }
  if (args.mode === 'dry-run') { await dryRun(args, engine, context); return; }
  if (args.leg === 'release_checks') {
    if (!args['release-sha']) throw new Error('Release checks require an explicit immutable --release-sha');
    if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() !== sha) throw new Error('Checkout HEAD must equal release-sha');
    await releaseChecks(engine, context);
    return;
  }
  if (variables.desktopMode !== 'build') throw new Error('A promotable next release requires staging its signed desktop artifacts');
  console.log('Desktop artifacts are built and staged on next.');
  attribution(args['dispatched-by']);
  if (!args['release-sha']) throw new Error('--execute requires an explicit immutable --release-sha');
  const identityPath = join(directory, 'local-execution.json');
  if (existsSync(identityPath)) {
    const previous = JSON.parse(readFileSync(identityPath, 'utf8'));
    if (previous.sha !== sha || previous.channel !== args.channel) throw new Error('State directory belongs to another release; use a new private directory');
  }
  privateWrite(identityPath, JSON.stringify({ sha, channel: args.channel }));
  if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('Release checkout must be clean');
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() !== sha) throw new Error('Checkout HEAD must equal release-sha');
  execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { cwd: root });
  const missing = missingReleaseCredentials(args, secrets);
  if (missing.length) throw new Error(`Missing local release credentials: ${missing.join(', ')}`);
  const toolEnv = await engine.nodeEnvironment(process.env);
  engine.baseEnv.PATH = toolEnv.PATH;
  if (toolEnv.FNM_DIR) engine.baseEnv.FNM_DIR = toolEnv.FNM_DIR;
  await processes.run('bash', ['-c', 'for tool in docker git ssh scp gh gh-axi flyctl rustup; do command -v "$tool" >/dev/null || exit 1; done'], { env: toolEnv, quiet: true });
  // release.mjs holds one local lock across both channel executions.
  const cancel = () => { engine.cancelled = true; engine.abortController.abort(); processes.cancel(); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const response = await fetch('https://api.github.com/repos/lunchboxfortwo/beeline/actions/workflows/unified-release.yml/runs?per_page=100', { headers: { Authorization: `Bearer ${context.github.token}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Cannot verify hosted release inactivity (HTTP ${response.status})`);
    const runs = await response.json();
    if (runs.workflow_runs.some(run => run.status !== 'completed')) throw new Error('A hosted production release is queued or active');
    const inputs = { channel: args.channel, release_sha: sha, release_version: args['release-version'] || '', dispatched_by: args['dispatched-by'], selection: 'auto', store_track: args['store-track'] || 'none', run_release_proof: Boolean(args.proof), allow_pin_restore: false, mobile_store_minimum: '', publish_listing: false };
    const results = await engine.workflow(WORKFLOW, inputs, context);
    if (results.release_result?.outputs.outcome !== 'success' || results.release_validation?.result !== 'success') throw new Error(`Local ${args.channel} release failed at ${sha}`);
    console.log('Platform carry and website delivery details are in the release record.');
  } finally {
    const jobs = [...engine.records.values()].map(({ id, conclusion, started_at, completed_at, steps }) => ({
      id, conclusion, seconds: (Date.parse(completed_at) - Date.parse(started_at)) / 1000, steps,
    }));
    if (jobs.length) processes.log(JSON.stringify({ channel: args.channel, sourceSha: sha, jobs }));
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  runLocalRelease(parseArguments(process.argv.slice(2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}

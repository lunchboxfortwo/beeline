#!/usr/bin/env node
// Recovery runner for unified-release.yml. Safe by default: --execute is
// required for delivery. See docs/release-pipeline.md for the outage policy.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalActions } from './release-local-actions.mjs';
import { Processes, privateWrite, appendSummary } from './release-local-process.mjs';
import { localGithub } from './release-local-github.mjs';
import { downloadPagesChannel } from './pages-channel.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = '.github/workflows/unified-release.yml';
const MAC = 'dani@100.104.88.126';
const MAC_NODE = '22.23.2';
const remoteDirectory = (engine, label) => `/tmp/beeline-release-${createHash('sha256').update(engine.directory + label).digest('hex').slice(0, 24)}`;

export function parseArguments(argv) {
  const args = { channel: 'next', mode: 'plan', 'mac-host': MAC };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--execute', '--dry-run', '--plan'].includes(arg)) {
      if (args.explicitMode) throw new Error('Choose exactly one of --plan, --dry-run or --execute');
      args.mode = arg.slice(2); args.explicitMode = true;
    } else if (arg === '--run-release-proof') args.proof = true;
    else if (arg === '--help') args.help = true;
    else if (['--channel', '--release-sha', '--release-version', '--dispatched-by', '--env-file', '--state-dir', '--leg', '--mac-host', '--remote-job'].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      args[arg.slice(2)] = argv[++i];
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['next', 'latest'].includes(args.channel)) throw new Error('channel must be next or latest');
  if (args['release-sha'] && !/^[0-9a-f]{40}$/.test(args['release-sha'])) throw new Error('release-sha must be a full commit SHA');
  if (args['mac-host'] !== MAC) throw new Error(`Only the authorized Mac build host ${MAC} is supported`);
  if (args.leg && args.mode !== 'dry-run' && !(args.mode === 'execute' && args.leg === 'release_checks')) throw new Error('--leg requires --dry-run or --execute --leg release_checks');
  return args;
}

export function loadEnvironment(file, repository = root) {
  const real = realpathSync(file);
  if (!outside(repository, real)) throw new Error('Release secrets must be outside the repository');
  const info = statSync(real);
  if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid()) throw new Error('Release env file must be owned by the operator with mode 600');
  // Parse data, never source shell code or expand shell variables/substitutions.
  const result = {};
  for (const line of readFileSync(real, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^(?:export )?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) throw new Error('Invalid release env record; use KEY=value, one value per line');
    let value = match[2];
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { throw new Error('Invalid quoted release env value'); }
      if (typeof value !== 'string') throw new Error('Release env values must be strings');
    }
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
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
  const required = ['EXPO_TOKEN', 'EXPO_ASC_KEY_ID', 'EXPO_ASC_ISSUER_ID', 'EXPO_ASC_API_KEY_P8', 'NPM_AUTOMATION_TOKEN'];
  if (args.channel === 'next') required.push('FLY_API_TOKEN', 'FLY_FREE_AGENT_IMAGE_TOKEN', 'MIGRATION_DATABASE_URL', 'SERVER_CANARY_ROOM_ID');
  if (args.channel === 'latest') required.push('SENTRY_AUTH_TOKEN');
  if (plan.run_mobile_native === 'true' && plan.native_android === 'true') required.push('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
  const missing = required.filter(name => !secrets[name]);
  if (!secrets.GITHUB_TOKEN && !secrets.GH_TOKEN) missing.push('GITHUB_TOKEN or GH_TOKEN');
  if (args.channel === 'next' && !secrets.SERVER_CANARY_REVIEW_SECRET && !secrets.SERVER_CANARY_PHONE_TOKEN) missing.push('SERVER_CANARY_REVIEW_SECRET or SERVER_CANARY_PHONE_TOKEN');
  if (args.proof && !secrets.BEELINE_REVIEW_SECRET) missing.push('BEELINE_REVIEW_SECRET');
  return missing;
}

async function carryArm64(engine, context) {
  const directory = join(engine.directory, 'carried-arm64');
  if (!existsSync(join(directory, 'manifest.json'))) {
    const [owner, repo] = context.github.repository.split('/');
    await downloadPagesChannel({ github: localGithub(context.github.token, undefined, engine.abortController.signal), repo: { owner, repo }, directory, channel: context.inputs.channel });
  }
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  const bundle = manifest.bundles['darwin-arm64'];
  if (!bundle?.verified) throw new Error('Published Apple-silicon helper lacks installation verification');
  engine.processes.log(`Helper darwin-arm64 carried unchanged: ${bundle.version} ${bundle.commit}`);
  const name = `daemon-darwin-arm64-${context.needs.initialize.outputs.release_id}`;
  engine.artifacts.set(name, directory);
  return { result: 'success', outputs: { shipped: 'false' } };
}

async function macJob({ job, context, label, engine }) {
  // A private remote build tree, not the host's checkout, HOME, Pictures or keys.
  const remote = remoteDirectory(engine, label);
  const tools = await prepareMacTools(engine);
  const local = join(engine.directory, 'remote', label);
  mkdirSync(local, { recursive: true, mode: 0o700 });
  const spec = {
    job, context: { ...context, secrets: {}, github: { ...context.github } },
    variables: engine.variables,
  };
  privateWrite(join(local, 'job.json'), JSON.stringify(spec));
  await engine.processes.run('git', ['bundle', 'create', join(local, 'source.bundle'), 'HEAD'], { cwd: root, quiet: true, env: process.env });
  await engine.processes.run('ssh', ['-o', 'BatchMode=yes', MAC, `umask 077; mkdir -p '${remote}'`], { env: process.env, timeout: 30_000 });
  await engine.processes.run('scp', ['-q', join(local, 'source.bundle'), join(local, 'job.json'), `${MAC}:${remote}/`], { env: process.env });
  const command = `set -e; export PATH='${tools}/node/bin':/usr/local/bin:/opt/homebrew/bin:$HOME/.cargo/bin:$PATH; export RUSTUP_HOME='${tools}/rustup' CARGO_HOME='${tools}/cargo'; if [ -d '${remote}/source/.git' ]; then test "$(git -C '${remote}/source' rev-parse HEAD)" = '${context.github.sha}'; else git clone --quiet '${remote}/source.bundle' '${remote}/source'; fi; ( cd '${remote}/source' && npm ci --ignore-scripts --no-audit --no-fund && node scripts/release-local.mjs --remote-job '${remote}/job.json' )`;
  let failure;
  try { await engine.processes.run('ssh', ['-o', 'BatchMode=yes', MAC, command], { env: process.env, timeout: 40 * 60_000 }); }
  catch (error) { failure = error; }
  await engine.processes.run('scp', ['-q', `${MAC}:${remote}/result.json`, join(local, 'result.json')], { env: process.env });
  const result = JSON.parse(readFileSync(join(local, 'result.json'), 'utf8'));
  for (const [name, remoteDirectory] of result.artifacts) {
    if (!remoteDirectory.startsWith(`${remote}/state/artifacts/`)) throw new Error('Remote artifact escaped its build directory');
    const destination = join(engine.directory, 'artifacts', name);
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    await engine.processes.run('scp', ['-q', '-r', `${MAC}:${remoteDirectory}/.`, destination], { env: process.env });
    engine.artifacts.set(name, destination);
  }
  if (failure) throw failure;
  return result.job;
}

async function prepareMacTools(engine) {
  if (engine.macTools) return engine.macTools;
  const directory = `${remoteDirectory(engine, 'tools')}/tools`;
  // Install into this task's remote temp directory. The host's default Node,
  // Rust toolchains, shell configuration, Pictures and signing keys stay alone.
  const command = `set -euo pipefail
export PATH=/usr/local/bin:/opt/homebrew/bin:$HOME/.cargo/bin:$PATH
test "$(uname -m)" = x86_64
for tool in curl tar shasum rustup git; do command -v "$tool" >/dev/null; done
umask 077
mkdir -p '${directory}'
if [ ! -x '${directory}/node/bin/node' ]; then
  curl -fsSL 'https://nodejs.org/dist/v${MAC_NODE}/node-v${MAC_NODE}-darwin-x64.tar.gz' -o '${directory}/node.tar.gz'
  curl -fsSL 'https://nodejs.org/dist/v${MAC_NODE}/SHASUMS256.txt' -o '${directory}/SHASUMS256.txt'
  expected=$(awk '$2=="node-v${MAC_NODE}-darwin-x64.tar.gz" {print $1}' '${directory}/SHASUMS256.txt')
  actual=$(shasum -a 256 '${directory}/node.tar.gz' | awk '{print $1}')
  test -n "$expected" && test "$actual" = "$expected"
  mkdir -p '${directory}/node'
  tar -xzf '${directory}/node.tar.gz' -C '${directory}/node' --strip-components=1
fi
export RUSTUP_HOME='${directory}/rustup' CARGO_HOME='${directory}/cargo'
rustup toolchain install 1.95.0 --profile minimal --no-self-update
'${directory}/node/bin/node' --version
rustup run 1.95.0 rustc --version
`;
  await engine.processes.run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', MAC, 'bash -s'], { env: process.env, input: command, timeout: 10 * 60_000 });
  engine.macTools = directory;
  privateWrite(join(engine.directory, 'mac-tools.json'), JSON.stringify({ host: MAC, directory, node: MAC_NODE, rust: '1.95.0' }, null, 2));
  return directory;
}

export function localHooks(directory, processes) {
  return {
    job: async args => {
      const { context, engine } = args;
      context.env.BEELINE_LOCAL_RELEASE = 'true';
      if (['helper_linux', 'helper_macos', 'server'].includes(context.github.job)) context.env.CARGO_BUILD_JOBS = '2';
      if (context.github.job === 'helper_macos') {
        if (context.matrix.platform === 'darwin-arm64') return carryArm64(engine, context);
        return macJob(args);
      }
      if (context.github.job === 'helper') context.env.BEELINE_RELEASE_CARRIED_ARM64_DIR = join(directory, 'carried-arm64');
      if (['release_validation', 'bookkeeping'].includes(context.github.job)) {
        context.env.BEELINE_LOCAL_RELEASE_RECORDS = join(directory, 'records.json');
        context.env.BEELINE_LOCAL_RELEASE_ID = basename(directory);
      }
      if (context.github.job === 'server') {
        context.env.FLY_API_TOKEN = engine.secrets.FLY_API_TOKEN || '';
        context.env.DOCKER_CONFIG = join(context.runner.temp, 'docker');
      }
      if (context.github.job === 'helper' && engine.secrets.NPM_AUTOMATION_TOKEN) {
        const npmrc = join(context.runner.temp, 'npmrc');
        privateWrite(npmrc, '//registry.npmjs.org/:_authToken=${NPM_AUTOMATION_TOKEN}\n');
        context.env.NPM_CONFIG_USERCONFIG = npmrc;
        context.env.NPM_AUTOMATION_TOKEN = engine.secrets.NPM_AUTOMATION_TOKEN;
      }
    },
    step: async ({ step, context, env, result }) => {
      if (context?.github?.job === 'nightly_checks' && step.name === 'Dispatch nightly checks for the released commit') {
        const message = 'Nightly checks dispatch is not available during local recovery (GitHub Actions unavailable); release Checks run locally.';
        processes.log(message);
        appendSummary(env.GITHUB_STEP_SUMMARY, message);
        return true;
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
      if (step.uses === './.github/actions/pages-leg') {
        processes.log('website not released: static Pages deployment is suspended locally; web app continues');
        appendSummary(env.GITHUB_STEP_SUMMARY, 'website not released: static Pages deployment suspended; web app released separately.');
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
      if (step.name === 'Publish the exact helper CLI package') {
        // Keep publication logic and exact smoke-tested tarball; the global
        // npm install is confined to this job's private NPM_CONFIG_PREFIX.
        if (!context.env.NPM_AUTOMATION_TOKEN) throw new Error('Local npm publication requires NPM_AUTOMATION_TOKEN');
      }
    },
    afterStep: async ({ step, context, env, result }) => {
      if (step.name === 'Produce the inspectable release plan' &&
          result.outputs.run_mobile_native === 'true' && result.outputs.native_android === 'true' &&
          !context.secrets?.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) {
        throw new Error('Native Android store delivery requires GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
      }
      if (step.name === 'Produce the inspectable release plan' && result.outputs.run_desktop === 'true') {
        const previous = JSON.parse(readFileSync(join(context.runner.temp, 'previous/release.json'), 'utf8'));
        const desktop = previous.components.desktop;
        if (!desktop?.desktopVersion) throw new Error('No published desktop updater set to carry');
        // One updater manifest has one version for all OSes. Carry its whole
        // signed installer set so Windows never receives a false newer version.
        result.outputs.run_desktop = 'false';
        result.outputs.desktop_version = desktop.desktopVersion;
        processes.log(`Desktop updater set carried unchanged, including Windows: ${desktop.version} (${desktop.desktopVersion})`);
      }
      if (step.name === 'Finalize the release record') {
        const path = join(context.runner.temp, 'release/release.json');
        const record = JSON.parse(readFileSync(path, 'utf8'));
        delete record.runId;
        record.execution = { kind: 'local', id: basename(directory), dispatchedBy: JSON.parse(context.inputs.dispatched_by) };
        record.delivery.localExceptions = { staticWebsite: 'not released', helperArm64: 'carried unchanged', desktop: 'published signed updater set carried unchanged, including Windows' };
        const previousPath = join(context.runner.temp, 'previous/release.json');
        if (existsSync(previousPath)) {
          const previous = JSON.parse(readFileSync(previousPath, 'utf8'));
          record.components.website.staticSourceSha = previous.components.website.staticSourceSha || previous.components.website.sourceSha;
        }
        if (record.delivery.live?.components?.website?.state === 'success') record.delivery.live.components.website.scope = 'web-app';
        const helperManifest = join(directory, 'jobs/helper-local/daemon-release/manifest.json');
        if (existsSync(helperManifest)) record.components.helper.platforms = JSON.parse(readFileSync(helperManifest, 'utf8')).bundles;
        privateWrite(path, `${JSON.stringify(record, null, 2)}\n`);
      }
    },
  };
}

async function remoteJob(path) {
  if (process.platform !== 'darwin' || process.arch !== 'x64') throw new Error('Remote job requires the authorized Intel Mac');
  const spec = JSON.parse(readFileSync(path, 'utf8')), directory = join(dirname(path), 'state');
  const processes = new Processes({ token: spec.context.github.token });
  const engine = new LocalActions({ root, directory, secrets: {}, variables: spec.variables, processes, github: localGithub });
  const job = await engine.job(spec.job, spec.context, 'helper-darwin-x64');
  privateWrite(join(dirname(path), 'result.json'), JSON.stringify({ job, artifacts: [...engine.artifacts] }));
  if (job.result !== 'success') process.exitCode = 1;
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
  context = { ...context, vars: engine.variables || {}, secrets: engine.secrets || {}, env: {} };
  const legs = args.leg ? [args.leg] : ['initialize', 'require-tools', 'eas-cli', 'server', 'helper', 'mobile-ota', 'pages', 'web-app'];
  const sha = context.github.sha;
  let version = 'v0.0.0-rc.1';
  for (const leg of legs) {
    engine.processes.log(`Dry-run build: ${leg}; no publication, migration, channel move or rollout`);
    if (leg === 'initialize') {
      if (!context.github.token) throw new Error('Dry-run initialize requires --env-file with GITHUB_TOKEN or GH_TOKEN');
      const inputs = { channel: args.channel, release_sha: sha, release_version: args['release-version'] || '', selection: 'auto', store_track: 'none', run_release_proof: false };
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
    else if (leg === 'mac-tools') { await prepareMacTools(engine); continue; }
    else if (['eas-cli', 'require-tools'].includes(leg)) steps = [{ uses: `./.github/actions/${leg}`, with: leg === 'require-tools' ? { tools: 'node git docker ssh tar curl' } : {} }];
    else throw new Error(`Unknown dry-run leg: ${leg}`);
    const job = await engine.job({ steps, 'timeout-minutes': 45 }, { ...context, inputs: { release_sha: sha, release_version: version }, matrix: {}, needs: {}, steps: {}, job: { status: 'success', services: {} } }, `dry-${leg}`);
    if (job.result !== 'success') throw new Error(`Dry-run ${leg} failed; no release was attempted`);
  }
  engine.processes.log('Build proofs complete. Canary, migrations, live update proof and rollback were not exercised against production.');
}

export async function releaseChecks(engine, context) {
  const call = engine.read(WORKFLOW).jobs.release_checks;
  const inputs = engine.value(call.with, { ...context, needs: { initialize: { outputs: { release_sha: context.github.sha } } } });
  const results = await engine.workflow(call.uses, inputs, context, 'release_checks/');
  privateWrite(join(engine.directory, 'release-checks.json'), JSON.stringify(results, null, 2));
  if (Object.values(results).some(result => result.result === 'failure')) throw new Error(`Release checks failed; inspect private results under ${engine.directory}`);
  engine.processes.log('Release checks complete; no release identity reserved or delivery attempted.');
  return results;
}

async function main(argv) {
  const args = parseArguments(argv);
  if (args.help) { console.log('node scripts/release-local.mjs [--plan | --dry-run [--leg initialize|server|helper|mobile-ota|pages|web-app|eas-cli|require-tools|mac-tools] | --execute [--leg release_checks]] --channel next|latest --release-sha <40-char SHA> --dispatched-by <audited JSON> [--env-file ~/.config/beeline-release.env] [--run-release-proof] [--state-dir /outside/repo]'); return; }
  if (args['remote-job']) { await remoteJob(args['remote-job']); return; }
  if (process.platform !== 'linux') throw new Error('Run the release controller on Linux squire');
  const sha = args['release-sha'] || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const directory = resolve(args['state-dir'] || join(tmpdir(), `beeline-release-${Date.now()}`));
  if (!outside(root, directory)) throw new Error('Release state must be outside the repository');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!outside(root, realpathSync(directory))) throw new Error('Release state symlink points inside the repository');
  const envFile = resolve(args['env-file'] || join(homedir(), '.config/beeline-release.env'));
  const secrets = args.mode === 'execute' || (args.mode === 'dry-run' && args['env-file']) ? loadEnvironment(envFile) : {};
  if (!secrets.GITHUB_TOKEN && secrets.GH_TOKEN) secrets.GITHUB_TOKEN = secrets.GH_TOKEN;
  const processes = new Processes(secrets);
  const variables = { BEELINE_HELPER_SENTRY_DSN: secrets.BEELINE_HELPER_SENTRY_DSN || '', BEELINE_MOBILE_SENTRY_DSN: secrets.BEELINE_MOBILE_SENTRY_DSN || '' };
  const engine = new LocalActions({ root, directory, secrets, variables, processes, github: localGithub, hooks: localHooks(directory, processes) });
  engine.inspect(WORKFLOW);
  const context = { github: { repository: 'Beeline-Work/beeline', sha, run_id: String(Math.floor(Date.now() / 1000)), run_attempt: '1', event_name: 'workflow_dispatch', event: {}, actor: 'local-release', token: secrets.GITHUB_TOKEN || secrets.GH_TOKEN || '' }, runner: {}, job: { status: 'success' } };
  if (args.mode === 'plan') {
    console.log(`Local ${args.channel} release at ${sha}; no release commands executed.`);
    console.log(`Workflow jobs in dependency order: ${Object.keys(engine.read(WORKFLOW).jobs).join(', ')}`);
    console.log('website not released: static Pages is suspended; selected web app leg still runs.');
    console.log('Apple-silicon helper carried unchanged. Published desktop updater set (including Windows) carried unchanged; its global version is retained.');
    console.log(`Intel helper builds over SSH on ${MAC}. Canary, helper update proof, optional device proof, rollback, full Checks gate and finalization stay enabled.`);
    return;
  }
  if (args.mode === 'dry-run') { await dryRun(args, engine, context); return; }
  if (args.leg === 'release_checks') {
    if (!args['release-sha']) throw new Error('Release checks require an explicit immutable --release-sha');
    if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() !== sha) throw new Error('Checkout HEAD must equal release-sha');
    await releaseChecks(engine, context);
    return;
  }
  console.log('website not released: static Pages suspended; the selected EAS web app still runs.');
  console.log('Local policy: Apple-silicon helper and published desktop updater set are carried unchanged.');
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
  await prepareMacTools(engine);
  // A local lock plus the existing advisory Actions check. The operator must
  // keep hosted release dispatch disabled until this recovery run completes.
  const lock = join(tmpdir(), `beeline-unified-release-${userInfo().uid}.lock`);
  mkdirSync(lock, { mode: 0o700 });
  privateWrite(join(lock, 'owner'), `${process.pid}\n${directory}\n`);
  const cancel = () => { engine.cancelled = true; engine.abortController.abort(); processes.cancel(); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const response = await fetch('https://api.github.com/repos/Beeline-Work/beeline/actions/workflows/unified-release.yml/runs?per_page=100', { headers: { Authorization: `Bearer ${context.github.token}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Cannot verify hosted release inactivity (HTTP ${response.status})`);
    const runs = await response.json();
    if (runs.workflow_runs.some(run => run.status !== 'completed')) throw new Error('A hosted production release is queued or active');
    const inputs = { channel: args.channel, release_sha: sha, release_version: args['release-version'] || '', dispatched_by: args['dispatched-by'], selection: 'auto', store_track: 'none', run_release_proof: Boolean(args.proof), allow_pin_restore: false, mobile_store_minimum: '', publish_listing: false };
    const results = await engine.workflow(WORKFLOW, inputs, context);
    if (results.release_result?.outputs.outcome !== 'success' || results.release_validation?.result !== 'success') throw new Error(`Release failed; inspect private results under ${directory}`);
    console.log(`Local release completed; private results: ${directory}`);
    console.log('website not released: static Pages suspended. Platform carry details are in the release record.');
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    rmSync(lock, { recursive: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}

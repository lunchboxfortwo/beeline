// Local transport for the committed workflow. Release commands, conditions,
// outputs, matrices and dependency edges continue to belong to its YAML.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, globSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { condition, readCommandFile, render } from './release-local-expressions.mjs';
import { appendSummary, privateWrite, readOptional } from './release-local-process.mjs';
import { setupJava } from './release-local-java.mjs';

const SUPPORTED = /^(actions\/(checkout|setup-node|setup-java|github-script|upload-artifact|download-artifact|cache)(\/restore|\/save)?@v\d+|docker\/login-action@v3|dtolnay\/rust-toolchain@[^\s]+)$/;

function preferredNode(root, requested) {
  const pin = readOptional(join(root, '.nvmrc')).trim();
  // fs.globSync requires Node 22. An older project minimum cannot downgrade
  // this release runner below its own floor.
  if (/^v?\d+(?:\.\d+){0,2}$/.test(pin) && Number(pin.replace(/^v/, '').split('.')[0]) >= 22) return pin;
  const manifest = readOptional(join(root, 'package.json'));
  const engine = manifest ? JSON.parse(manifest).engines?.node : '';
  const major = /^(?:>=|\^|~|v)?\s*(\d+)/.exec(engine ?? '')?.[1];
  if (/^v?\d+(?:\.\d+){0,2}$/.test(engine ?? '') && Number(major) >= 22) return engine;
  return Number(major) >= 22 ? major : requested;
}

export function matrixRows(matrix = {}) {
  let rows = [{}];
  for (const [key, values] of Object.entries(matrix).filter(([k]) => !['include', 'exclude'].includes(k))) {
    rows = rows.flatMap(row => values.map(value => ({ ...row, [key]: value })));
  }
  if (matrix.include && rows.length === 1 && Object.keys(rows[0]).length === 0) rows = matrix.include;
  else if (matrix.include) throw new Error('Mixed matrix include expansion needs an explicit local adapter');
  return rows.filter(row => !matrix.exclude?.some(exclusion => Object.entries(exclusion).every(([k, v]) => row[k] === v)));
}

export class LocalActions {
  constructor({ root, directory, secrets, variables = {}, processes, github, hooks = {}, baseEnv = process.env, isolateTemporary = false }) {
    Object.assign(this, { root, directory, secrets, variables, processes, github, hooks, isolateTemporary });
    this.artifacts = new Map();
    this.records = new Map();
    this.counter = 0;
    this.cancelled = false;
    this.abortController = new AbortController();
    // Do not leak the operator's production environment into test jobs.
    this.baseEnv = Object.fromEntries(Object.entries(baseEnv).filter(([key]) => /^(PATH|LANG|LC_.*|ANDROID_HOME|ANDROID_SDK_ROOT|JAVA_HOME|SHELL|TMPDIR|RUSTUP_HOME|CARGO_HOME|FNM_DIR)$/.test(key)));
    if (baseEnv.HOME) {
      this.baseEnv.RUSTUP_HOME ||= join(baseEnv.HOME, '.rustup');
      this.baseEnv.CARGO_HOME ||= join(baseEnv.HOME, '.cargo');
      this.baseEnv.FNM_DIR ||= baseEnv.FNM_DIR || join(baseEnv.HOME, '.local/share/fnm');
    }
  }
  async nodeEnvironment(env, requested = '22') {
    const version = preferredNode(this.root, requested);
    let selected;
    const query = ['-p', 'JSON.stringify({version:process.versions.node,path:process.execPath})'];
    const options = { env: { ...env, ...(this.baseEnv.FNM_DIR ? { FNM_DIR: this.baseEnv.FNM_DIR } : {}) }, quiet: true };
    try {
      selected = JSON.parse(await this.processes.run('fnm', ['exec', '--using', version, 'node', ...query], options));
      if (Number(selected.version.split('.')[0]) < 22) selected = undefined;
    } catch { /* fnm or the preferred installed version is unavailable. */ }
    if (!selected) selected = JSON.parse(await this.processes.run('node', query, options));
    if (Number(selected.version.split('.')[0]) < 22) throw new Error(`Release runner requires Node >=22; found ${selected.version}`);
    return { ...env, ...options.env, PATH: `${dirname(selected.path)}:${env.PATH}` };
  }
  read(file) { return parse(readFileSync(resolve(this.root, file), 'utf8')); }
  inspect(file, visited = new Set()) {
    if (visited.has(file)) return;
    visited.add(file);
    const document = this.read(file);
    for (const job of Object.values(document.jobs ?? { composite: { steps: document.runs?.steps } })) {
      if (job.uses?.startsWith('./')) this.inspect(job.uses, visited);
      for (const step of job.steps ?? []) {
        if (!step.uses) continue;
        if (step.uses.startsWith('./')) this.inspect(`${step.uses}/action.yml`, visited);
        else if (!SUPPORTED.test(step.uses) && step.uses !== 'actions/configure-pages@v5' && step.uses !== 'actions/upload-pages-artifact@v5') {
          throw new Error(`Unsupported local action: ${step.uses}`);
        }
      }
    }
  }
  options(context) { return { root: this.root, success: context.job.status === 'success' && !this.cancelled, cancelled: this.cancelled }; }
  value(value, context) { return render(value, context, this.options(context)); }
  env(value, context) { return Object.fromEntries(Object.entries(this.value(value ?? {}, context)).map(([k, v]) => [k, String(v ?? '')])); }
  async workflow(file, inputs, inherited, prefix = '') {
    let workflow = this.read(file);
    const execution = await this.hooks.workflow?.({ file, workflow, inputs, inherited, prefix, engine: this }) ?? {};
    workflow = execution.workflow ?? workflow;
    const results = {}, pending = new Set(Object.keys(workflow.jobs));
    const running = new Map();
    const run = async id => {
      const job = workflow.jobs[id], dependencies = [job.needs ?? []].flat();
      const needs = Object.fromEntries(dependencies.map(name => [name, results[name]]));
      const context = {
        ...inherited, inputs, needs, steps: {}, matrix: {}, env: {}, secrets: this.secrets, vars: this.variables,
        job: { status: dependencies.some(name => results[name].result !== 'success') ? 'failure' : 'success', services: {} },
        github: { ...inherited.github, job: id },
      };
      if (!condition(job.if, context, this.options(context))) { results[id] = { result: 'skipped', outputs: {} }; return; }
      context.job.status = 'success';
      const label = `${prefix}${id}`;
      this.processes.log(`Job: ${label}`);
      try {
        if (job.uses) {
          const nested = await this.workflow(job.uses, this.value(job.with ?? {}, context), context, `${label}/`);
          results[id] = { result: Object.values(nested).some(result => ['failure', 'cancelled'].includes(result.result)) ? 'failure' : 'success', outputs: {} };
        } else {
          const rows = matrixRows(this.value(job.strategy?.matrix ?? {}, context));
          const execute = async matrix => {
            const instanceLabel = `${label}-${Object.values(matrix).join('-') || 'local'}`;
            try { return await (execution.job ?? this.job.bind(this))(job, { ...context, matrix }, instanceLabel, workflow.env); }
            catch (error) {
              // Await every sibling even when setup/transport rejects one row.
              this.processes.log(this.processes.redact(`${instanceLabel}: ${error.message}`));
              return { result: job['continue-on-error'] ? 'success' : 'failure', outputs: {} };
            }
          };
          const instances = [];
          if (execution.parallel) instances.push(...await Promise.all(rows.map(execute)));
          else for (const matrix of rows) instances.push(await execute(matrix));
          results[id] = { result: instances.some(instance => ['failure', 'cancelled'].includes(instance.result)) ? 'failure' : 'success', outputs: Object.assign({}, ...instances.map(instance => instance.outputs)) };
        }
      } catch (error) {
        this.processes.log(this.processes.redact(`${label}: ${error.message}`));
        results[id] = { result: job['continue-on-error'] ? 'success' : 'failure', outputs: {} };
      }
      privateWrite(join(this.directory, 'jobs.json'), JSON.stringify(results, null, 2));
    };
    try {
      while (pending.size || running.size) {
        let advanced = false;
        for (const id of pending) {
          const job = workflow.jobs[id], dependencies = [job.needs ?? []].flat();
          if (!dependencies.every(name => Object.hasOwn(results, name))) continue;
          advanced = true;
          pending.delete(id);
          if (execution.parallel) running.set(id, run(id).finally(() => running.delete(id)));
          else await run(id);
        }
        if (running.size) { await Promise.race(running.values()); continue; }
        if (!pending.size) break;
        if (!advanced) throw new Error(`Unresolved workflow dependencies: ${[...pending].join(', ')}`);
      }
    } finally {
      await Promise.allSettled(running.values());
      await execution.finish?.(results);
    }
    return results;
  }
  async job(job, context, label, workflowEnv = {}) {
    const directory = join(this.directory, 'jobs', label.replaceAll('/', '-'));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const started = new Date().toISOString();
    const logFile = join(directory, 'output.log');
    privateWrite(logFile, '');
    return this.processes.withLogFile(logFile, () => this.runJob(job, context, label, workflowEnv, directory, started, logFile));
  }
  async runJob(job, context, label, workflowEnv, directory, started, logFile) {
    const finish = result => {
      if (this.cancelled && result.result === 'success') result.result = 'cancelled';
      this.records.set(label, { id: label, name: label, conclusion: result.result, started_at: started, completed_at: new Date().toISOString(), logFile });
      privateWrite(join(this.directory, 'records.json'), JSON.stringify([...this.records.values()], null, 2));
      return result;
    };
    context = structuredClone(context);
    const runner = { name: 'beeline-ci-squire-local-release', os: process.platform === 'darwin' ? 'macOS' : 'Linux', temp: directory, arch: process.arch === 'x64' ? 'X64' : 'ARM64' };
    context.runner = runner;
    context.env = {
      ...this.baseEnv, HOME: join(directory, 'home'), XDG_CONFIG_HOME: join(directory, 'home/.config'),
      XDG_STATE_HOME: join(directory, 'home/.local/state'), CI: 'true',
      // npm publishes only via trusted publishing from hosted CI; a local release skips it.
      SKIP_HELPER_NPM: 'true',
      NPM_CONFIG_PREFIX: join(directory, 'npm-global'),
      GITHUB_WORKSPACE: this.root, GITHUB_REPOSITORY: context.github.repository,
      GITHUB_SHA: context.github.sha, GITHUB_RUN_ID: context.github.run_id,
      GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: context.github.job,
      GITHUB_EVENT_NAME: context.github.event_name, RUNNER_TEMP: directory, RUNNER_NAME: runner.name,
      GITHUB_STEP_SUMMARY: join(directory, 'summary.md'),
    };
    context.env.PATH = `${context.env.NPM_CONFIG_PREFIX}/bin:${context.env.PATH}`;
    mkdirSync(context.env.HOME, { recursive: true, mode: 0o700 });
    if (this.isolateTemporary) {
      Object.assign(context.env, { TMPDIR: join(directory, 'tmp'), XDG_CACHE_HOME: join(directory, 'cache'), DOCKER_CONFIG: join(directory, 'docker') });
      mkdirSync(context.env.TMPDIR, { recursive: true, mode: 0o700 });
    }
    Object.assign(context.env, this.env(workflowEnv, context), this.env(job.env, context));
    try {
      const intercepted = await this.hooks.job?.({ job, context, label, directory, engine: this });
      if (intercepted) return finish(intercepted);
    } catch (error) {
      this.processes.log(this.processes.redact(`${label}: ${error.message}`));
      return finish({ result: 'failure', outputs: {} });
    }
    const services = [];
    try {
      for (const [name, service] of Object.entries(job.services ?? {})) {
        const serviceName = `beeline-release-${createHash('sha256').update(directory + name).digest('hex').slice(0, 16)}`;
        if (Object.keys(service.env ?? {}).some(key => key !== 'POSTGRES_PASSWORD') || !service.image.startsWith('pgvector/pgvector:')) throw new Error('Unsupported service definition; add a local adapter before releasing');
        const args = ['run', '--detach', '--name', serviceName, '--publish', '127.0.0.1::5432'];
        for (const [key, value] of Object.entries(service.env ?? {})) args.push('--env', `${key}=${value}`);
        args.push(service.image);
        await this.processes.run('docker', args, { env: context.env, quiet: true });
        services.push(serviceName);
        const port = (await this.processes.run('docker', ['port', serviceName, '5432/tcp'], { env: context.env, quiet: true })).trim().split(':').at(-1);
        if (!/^\d+$/.test(port)) throw new Error('Could not resolve the isolated PostgreSQL service port');
        context.job.services[name] = { ports: { 5432: port } };
        await this.processes.run('bash', ['-c', 'for attempt in {1..30}; do docker exec "$1" pg_isready -U postgres && exit 0; sleep 1; done; exit 1', 'postgres-ready', serviceName], { env: context.env, quiet: true, timeout: 40_000 });
      }
      const timeout = (job['timeout-minutes'] ?? 60) * 60_000;
      context.deadline = Date.now() + timeout;
      await this.steps(job.steps, context);
    } catch (error) {
      context.job.status = 'failure';
      this.processes.log(this.processes.redact(`${label}: ${error.message}`));
    } finally {
      for (const service of services) {
        try { await this.processes.run('docker', ['rm', '--force', service], { env: context.env, quiet: true }); }
        catch (error) { context.job.status = 'failure'; this.processes.log(`Service cleanup failed: ${error.message}`); }
      }
    }
    return finish({ result: job['continue-on-error'] ? 'success' : context.job.status, outputs: this.env(job.outputs, context) });
  }
  async steps(steps, context) {
    for (const step of steps) {
      const id = step.id ?? `anonymous-${++this.counter}`;
      if (!condition(step.if, context, this.options(context))) { context.steps[id] = { outcome: 'skipped', conclusion: 'skipped', outputs: {} }; continue; }
      const previousStatus = context.job.status;
      const result = { outcome: 'success', conclusion: 'success', outputs: {} };
      const commandDirectory = join(context.runner.temp, `step-${++this.counter}`);
      const env = {
        ...context.env, ...this.env(step.env, context),
        GITHUB_OUTPUT: join(commandDirectory, 'output'), GITHUB_ENV: join(commandDirectory, 'env'), GITHUB_PATH: join(commandDirectory, 'path'),
      };
      for (const path of [env.GITHUB_OUTPUT, env.GITHUB_ENV, env.GITHUB_PATH]) privateWrite(path, '');
      const timeout = Math.min((step['timeout-minutes'] ?? 60) * 60_000, context.deadline - Date.now());
      this.processes.log(`  ${step.name ?? step.uses ?? id}`);
      try {
        if (timeout <= 0) throw new Error('Job deadline exceeded');
        const handled = await this.hooks.step?.({ step, context, env, result, engine: this });
        if (!handled) {
          if (step.run) {
            const body = this.value(step.run, { ...context, env });
            privateWrite(join(commandDirectory, 'run.sh'), body);
            await this.processes.run('bash', ['--noprofile', '--norc', '-eo', 'pipefail', join(commandDirectory, 'run.sh')], {
              cwd: resolve(this.root, this.value(step['working-directory'] ?? '.', context)), env, timeout,
            });
          } else await this.action(step, context, env, result, timeout);
        }
        Object.assign(result.outputs, readCommandFile(readOptional(env.GITHUB_OUTPUT)));
        await this.hooks.afterStep?.({ step, context, env, result, engine: this });
      } catch (error) {
        result.outcome = 'failure';
        result.conclusion = this.value(step['continue-on-error'], context) ? 'success' : 'failure';
        if (result.conclusion === 'failure') context.job.status = 'failure';
        this.processes.log(this.processes.redact(`  Failed: ${error.message}`));
      } finally {
        Object.assign(context.env, readCommandFile(readOptional(env.GITHUB_ENV)));
        const paths = readOptional(env.GITHUB_PATH).trim().split('\n').filter(Boolean);
        if (paths.length) context.env.PATH = `${paths.reverse().join(':')}:${context.env.PATH}`;
        context.steps[id] = result;
        if (previousStatus === 'failure') context.job.status = 'failure';
      }
    }
  }
  async action(step, context, env, result, timeout) {
    const name = step.uses;
    const inputs = this.env(step.with, context);
    if (name.startsWith('./')) {
      const action = this.read(`${name}/action.yml`);
      const defaults = Object.fromEntries(Object.entries(action.inputs ?? {}).map(([k, v]) => [k, v.default ?? '']));
      const nested = { ...context, job: { ...context.job }, inputs: { ...defaults, ...inputs }, steps: {}, env: { ...env, GITHUB_ACTION_PATH: resolve(this.root, name) } };
      await this.steps(action.runs.steps, nested);
      Object.assign(context.env, nested.env);
      Object.assign(result.outputs, Object.fromEntries(Object.entries(action.outputs ?? {}).map(([k, v]) => [k, String(this.value(v.value, nested) ?? '')])));
      if (nested.job.status !== 'success') throw new Error(`Composite failed: ${name}`);
    } else if (name.startsWith('actions/checkout@')) {
      const ref = inputs.ref || context.github.sha;
      const sha = (await this.processes.run('git', ['rev-parse', `${ref}^{commit}`], { cwd: this.root, env, quiet: true })).trim();
      const head = (await this.processes.run('git', ['rev-parse', 'HEAD'], { cwd: this.root, env, quiet: true })).trim();
      if (sha !== head) throw new Error(`Release checkout mismatch: ${sha} != ${head}; use the exact release checkout`);
    } else if (name.startsWith('actions/cache')) {
      // Caches are an optimization. Never claim a hit or reuse unverified outputs.
      result.outputs['cache-hit'] = 'false';
      result.outputs['cache-primary-key'] = inputs.key ?? '';
    } else if (name.startsWith('actions/setup-node@')) {
      const selected = await this.nodeEnvironment(env, inputs['node-version'] || '22');
      context.env.PATH = selected.PATH;
      if (selected.FNM_DIR) context.env.FNM_DIR = selected.FNM_DIR;
    } else if (name.startsWith('actions/setup-java@')) {
      await setupJava({ action: name, inputs, env, directory: this.directory, processes: this.processes, token: context.github.token, timeout });
    } else if (name.startsWith('dtolnay/rust-toolchain@')) {
      const version = name.split('@')[1];
      await this.processes.run('rustup', ['run', version, 'rustc', '--version'], { env, quiet: true });
      context.env.RUSTUP_TOOLCHAIN = version;
    } else if (name === 'docker/login-action@v3') {
      await this.processes.run('docker', ['login', inputs.registry, '--username', inputs.username, '--password-stdin'], { env, input: inputs.password, quiet: true });
    } else if (name.startsWith('actions/upload-artifact@')) {
      const files = inputs.path.split('\n').filter(Boolean).flatMap(pattern => globSync(isAbsolute(pattern) ? pattern : resolve(this.root, pattern)));
      const found = files.filter(existsSync);
      if (!found.length && inputs['if-no-files-found'] === 'error') throw new Error(`Missing artifact ${inputs.name}`);
      if (!found.length) return;
      let parent = found.length === 1 && statSync(found[0]).isDirectory() ? found[0] : dirname(found[0]);
      while (!found.every(file => !relative(parent, file).startsWith('..'))) parent = dirname(parent);
      const target = join(this.directory, 'artifacts', inputs.name);
      mkdirSync(target, { recursive: true, mode: 0o700 });
      for (const file of found) {
        const destination = join(target, relative(parent, file));
        if (resolve(destination) !== resolve(target) || !statSync(file).isDirectory()) cpSync(file, destination, { recursive: true });
        else for (const child of globSync('*', { cwd: file })) cpSync(join(file, child), join(target, child), { recursive: true });
      }
      this.artifacts.set(inputs.name, target);
      result.outputs['artifact-id'] = String(++this.counter);
    } else if (name.startsWith('actions/download-artifact@')) {
      const pattern = new RegExp(`^${(inputs.pattern || inputs.name || '*').split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      const matched = [...this.artifacts].filter(([key]) => pattern.test(key));
      if (!matched.length) throw new Error(`No local artifacts matching ${inputs.name || inputs.pattern}`);
      for (const [key, path] of matched) {
        const target = resolve(this.root, inputs.path || '.');
        cpSync(path, inputs.name || inputs['merge-multiple'] === 'true' ? target : join(target, key), { recursive: true });
      }
    } else if (name.startsWith('actions/github-script@')) {
      const savedEnv = { ...process.env };
      try {
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, env);
        const summary = { addHeading: text => { appendSummary(env.GITHUB_STEP_SUMMARY, `## ${text}`); return summary; }, addCodeBlock: text => { appendSummary(env.GITHUB_STEP_SUMMARY, text); return summary; }, write: async () => {} };
        const core = { summary, setOutput: (k, v) => { result.outputs[k] = String(v); }, setSecret: value => this.processes.mask(value), getIDToken: () => { throw new Error('Actions OIDC is unavailable locally'); }, info: value => this.processes.log(this.processes.redact(String(value))) };
        const script = this.value(step.with.script, context);
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const signal = AbortSignal.any([this.abortController.signal, AbortSignal.timeout(timeout)]);
        await new AsyncFunction('github', 'core', 'context', script)(this.github(inputs['github-token'] || context.github.token, undefined, signal), core, { repo: { owner: context.github.repository.split('/')[0], repo: context.github.repository.split('/')[1] }, sha: context.github.sha, runId: context.github.run_id });
      } finally {
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, savedEnv);
      }
    } else throw new Error(`Unsupported local action: ${name}`);
  }
}

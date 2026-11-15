// Delivery has production authority, so workers run as the operator outside
// credential-free CI jails, while sharing their existing parent slice budgets.
import { createHash } from 'node:crypto';
import { existsSync, globSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CheckQueue } from './release-local-checks.mjs';
import { appendSummary, privateWrite } from './release-local-process.mjs';

const runnerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function writeToolAdapters(directory, config) {
  const bin = join(directory, 'tools');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const configFile = join(bin, 'config.json');
  privateWrite(configFile, JSON.stringify(config));
  const module = pathToFileURL(join(runnerRoot, 'scripts/release-local-tools.mjs')).href;
  for (const tool of ['docker', 'flyctl']) writeFileSync(join(bin, tool), `#!${process.execPath}\nvoid import(${JSON.stringify(module)}).then(m => { process.exitCode = m.runLocalTool(${JSON.stringify(tool)}, process.argv.slice(2)); });\n`, { mode: 0o700 });
  return { PATH: bin, BEELINE_LOCAL_RELEASE_TOOL_CONFIG: configFile, DOCKER_BUILDKIT: '0' };
}

export class LocalDelivery {
  constructor(engine) {
    this.engine = engine;
    this.queue = new CheckQueue({ slots: [1, 2, 3], execute: (...args) => this.execute(...args) });
    this.mac = new CheckQueue({ slots: [4], execute: (...args) => this.execute(...args) });
    this.active = new Set();
    this.cancel = () => {
      engine.cancelled = true; engine.abortController.abort(); engine.processes.cancel();
      for (const unit of this.active) this.command('sudo', ['-n', 'systemctl', 'stop', unit]).catch(() => {});
    };
  }
  run(job, context, label, env) {
    const remote = context.github.job === 'mobile_native_ios' || (context.github.job === 'helper_macos' && context.matrix.platform === 'darwin-x64' && this.engine.variables?.macHelperMode === 'build')
      || (context.github.job === 'desktop_build' && context.matrix.label === 'macos-universal');
    return (remote ? this.mac : this.queue).run(job, context, label, env);
  }
  async command(command, args, options = {}) { return this.engine.processes.run(command, args, { env: process.env, quiet: true, ...options }); }
  async source(directory, context) {
    const target = join(directory, 'source'), template = this.engine.preparedWorkspace || this.engine.root;
    await this.command('git', ['clone', '--quiet', '--local', '--no-hardlinks', '--no-checkout', this.engine.root, target]);
    await this.command('git', ['-C', target, 'checkout', '--quiet', '--detach', context.github.sha]);
    await this.command('git', ['-C', target, 'remote', 'set-url', 'origin', `https://github.com/${context.github.repository}.git`]);
    const mobile = ['website', 'mobile_ota', 'mobile_ota_after_proof', 'release_proof', 'mobile_native_android', 'mobile_native_ios'].includes(context.github.job);
    const paths = globSync(['node_modules', 'apps/*/node_modules', 'packages/*/node_modules', 'apps/*/dist', 'packages/*/dist', '.turbo/cache', '.beeline-ci-build.json', 'apps/mobile/public/canvaskit.wasm'], { cwd: template });
    for (const path of paths) {
      if (!mobile && (path === 'apps/mobile/node_modules' || path === 'apps/mobile/public/canvaskit.wasm')) continue;
      const source = realpathSync(join(template, path)), destination = join(target, path);
      mkdirSync(dirname(destination), { recursive: true });
      await this.command('cp', ['-a', '--no-preserve=ownership', '--reflink=auto', source, destination]);
    }
    return target;
  }
  async execute(slot, job, context, label, workflowEnv = {}) {
    if (this.engine.cancelled) return { result: 'failure', outputs: {} };
    const directory = join(this.engine.directory, 'jobs', label.replaceAll('/', '-'));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const started = new Date().toISOString();
    try { return await this.worker(slot, job, context, label, workflowEnv, directory); }
    catch (error) {
      const message = this.engine.processes.redact(`${label}: ${error.message}`);
      const logFile = join(directory, 'output.log');
      appendSummary(logFile, message);
      this.engine.processes.log(message);
      this.engine.records.set(label, { id: label, name: label, conclusion: 'failure', started_at: started,
        completed_at: new Date().toISOString(), logFile, slice: `beeline-ci${slot}.slice` });
      privateWrite(join(this.engine.directory, 'records.json'), JSON.stringify([...this.engine.records.values()], null, 2));
      return { result: 'failure', outputs: {} };
    }
  }
  async worker(slot, job, context, label, workflowEnv, directory) {
    const carry = context.github.job === 'helper_macos' && !(context.matrix.platform === 'darwin-x64' && this.engine.variables?.macHelperMode === 'build');
    const source = carry ? this.engine.root : await this.source(directory, context), slice = `beeline-ci${slot}.slice`;
    const { secrets: _secrets, ...safeContext } = context;
    const spec = { delivery: true, job, context: safeContext, label, workflowEnv, root: source, directory,
      runDirectory: this.engine.directory, secrets: this.engine.secrets, variables: this.engine.variables, artifacts: [...this.engine.artifacts],
      tools: { slice, docker: '/usr/bin/docker', flyctl: await this.command('bash', ['-c', 'command -v flyctl']) } };
    spec.tools.flyctl = spec.tools.flyctl.trim();
    privateWrite(join(directory, 'spec.json'), JSON.stringify(spec));
    const unit = `beeline-release-delivery-${createHash('sha256').update(directory).digest('hex').slice(0, 24)}.service`;
    const args = ['-n', 'systemd-run', '--quiet', '--wait', '--pipe', '--collect', `--unit=${unit}`, `--slice=${slice}`,
      '-p', `User=${process.getuid()}`, '-p', `Group=${process.getgid()}`, '-p', 'KillMode=mixed',
      '--setenv=PATH=' + process.env.PATH, '--setenv=HOME=' + process.env.HOME,
      ...(process.env.SSH_AUTH_SOCK ? ['--setenv=SSH_AUTH_SOCK=' + process.env.SSH_AUTH_SOCK] : []),
      process.execPath, join(runnerRoot, 'scripts/release-local-check-worker.mjs'), join(directory, 'spec.json')];
    this.active.add(unit);
    let failure;
    try { await this.command('sudo', args, { quiet: false, timeout: (job['timeout-minutes'] ?? 60) * 60_000 }); }
    catch (error) { failure = error; await this.command('sudo', ['-n', 'systemctl', 'stop', unit]).catch(() => {}); }
    finally { this.active.delete(unit); }
    const path = join(directory, 'result.json');
    if (!existsSync(path)) throw new Error(`${label}: ${failure?.message || 'delivery worker returned no result'}`);
    const result = JSON.parse(readFileSync(path, 'utf8'));
    for (const record of result.records) this.engine.records.set(record.id, { ...record, conclusion: failure ? 'failure' : record.conclusion, slice });
    for (const [name, path] of result.artifacts) this.engine.artifacts.set(name, path);
    privateWrite(join(this.engine.directory, 'records.json'), JSON.stringify([...this.engine.records.values()], null, 2));
    return failure ? { ...result.job, result: 'failure' } : result.job;
  }
}

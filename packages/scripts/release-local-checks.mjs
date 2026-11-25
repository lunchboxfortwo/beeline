// Local release checks use queue slots backed by the existing CI jail budgets;
// Body's nested sandbox uses an equally bounded host-user scope instead.
// This transport creates only task-owned transient units, never changes a
// listener, Docker daemon, slice limit, registration or production lock.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matrixRows } from './release-local-actions.mjs';
import { appendSummary, privateWrite } from './release-local-process.mjs';
import { droppedChecks, quickChecks } from './release-local-policy.mjs';

const runnerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const checksWorkflow = '.github/workflows/checks.yml';
const readers = new Set(['codecs', 'server-suite-shard', 'server-claim-latency', 'production-corpus-replay', 'app-link-associations', 'auth-image', 'frame-budget', 'state-upgrade']);
export const checkWorkspace = id => readers.has(id) ? 'shared build with private write layer' : 'private copy of build';

export function checkPlan(engine, { fullChecks = false } = {}) {
  const original = engine.read(checksWorkflow), workflow = fullChecks ? original : quickChecks(original);
  return {
    execution: fullChecks ? 'full nightly Checks in existing isolated CI jails; maximum four slots' : 'three independent quick-check jobs in existing isolated CI jails; maximum four slots',
    budget: fullChecks ? 'four slots: at most 48 GiB; 3 CPUs / 12 GiB each; Vitest at most 2 workers' : 'existing parent slices: 3 CPUs / 12 GiB each; Vitest at most 2 workers',
    preparation: 'install and build once on shard 1, before the queue',
    retained: fullChecks ? Object.keys(original.jobs) : ['build', 'typecheck', 'dead-code', 'design grammar', 'codecs'],
    dropped: fullChecks ? [] : droppedChecks(original),
    jobs: Object.entries(workflow.jobs).flatMap(([id, job]) => matrixRows(job.strategy?.matrix).map(matrix => ({
      id, matrix, needs: [job.needs ?? []].flat(), if: job.if ?? 'success()', workspace: checkWorkspace(id),
      placement: id === 'body-suite' ? 'bounded host-user scope; one of the four slots' : 'existing isolated CI shard',
    }))),
    isolation: 'private HOME, TMPDIR, cache, Docker config and log per job; isolated database engines and ephemeral ports; shard rootless Docker',
    delivery: fullChecks ? 'checks only; no release identity or delivery' : 'after the quick-check verdict, three bounded local delivery jobs and one remote Mac orchestration job can run together',
  };
}

export class CheckQueue {
  constructor({ slots = [1, 2, 3, 4], execute }) { this.slots = slots; this.execute = execute; this.waiting = []; }
  run(...args) {
    return new Promise((resolveRun, reject) => { this.waiting.push({ args, resolveRun, reject }); this.drain(); });
  }
  drain() {
    while (this.slots.length && this.waiting.length) {
      const slot = this.slots.shift(), next = this.waiting.shift();
      Promise.resolve().then(() => this.execute(slot, ...next.args)).then(next.resolveRun, next.reject).finally(() => { this.slots.push(slot); this.drain(); });
    }
  }
}

export class LocalChecks {
  constructor(engine, fullChecks = false) {
    this.engine = engine;
    this.fullChecks = fullChecks;
    this.directory = join(engine.directory, 'checks');
    this.source = join(this.directory, 'source');
    this.active = new Map();
    this.shards = new Map();
    this.queue = new CheckQueue({ execute: (...args) => this.execute(...args) });
  }
  async command(command, args, options = {}) {
    return this.engine.processes.run(command, args, { env: process.env, quiet: true, ...options });
  }
  async privileged(args, options) { return this.command('sudo', ['-n', ...args], options); }
  async stop(unit, host) {
    return host ? this.command('systemctl', ['--user', 'stop', unit]) : this.privileged(['systemctl', 'stop', unit]);
  }
  async prepare(inherited) {
    this.startedAt = new Date().toISOString();
    this.samples = [];
    this.sample = () => this.samples.push({ at: new Date().toISOString(), load: loadavg() });
    this.sample();
    this.sampling = setInterval(this.sample, 5000);
    this.onCancel = () => {
      this.engine.cancelled = true;
      this.engine.abortController.abort();
      this.engine.processes.cancel();
      // Stop only units created by this queue. Existing services stay running.
      for (const [unit, host] of this.active) this.stop(unit, host).catch(() => {});
    };
    process.once('SIGINT', this.onCancel); process.once('SIGTERM', this.onCancel);
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      for (const slot of [1, 2, 3, 4]) {
        const name = `beeline-ci-shard-${slot}`, slice = `beeline-ci${slot}.slice`;
        const properties = await this.command('systemctl', ['show', `${name}.service`, '-p', 'MainPID', '-p', 'User', '-p', 'ControlGroup']);
        const values = Object.fromEntries(properties.trim().split('\n').map(line => line.split('=')));
        const budget = await this.command('systemctl', ['show', slice, '-p', 'CPUQuotaPerSecUSec', '-p', 'MemoryMax']);
        if (!/^[1-9]\d*$/.test(values.MainPID) || values.User !== name || !values.ControlGroup?.endsWith(`/${slice}/${name}.service`)
            || !budget.includes('CPUQuotaPerSecUSec=3s\n') || !budget.includes('MemoryMax=12884901888\n')) {
          throw new Error(`Existing isolated CI shard ${slot} is unavailable or its budget differs`);
        }
        this.shards.set(slot, { name, slice, pid: values.MainPID, budget: budget.trim() });
      }
      await this.command('git', ['clone', '--quiet', '--local', '--no-hardlinks', '--no-checkout', this.engine.root, this.source]);
      await this.command('git', ['-C', this.source, 'checkout', '--quiet', '--detach', inherited.github.sha]);
      await this.command('git', ['-C', this.source, 'remote', 'set-url', 'origin', `https://github.com/${inherited.github.repository}.git`]);
      await this.privileged(['chown', '-R', this.shards.get(1).name, this.source]);
      const context = { ...inherited, github: { ...inherited.github, job: 'workspace' }, matrix: {}, steps: {}, inputs: {}, needs: {}, job: { status: 'success', services: {} } };
      const result = await this.execute(1, { 'timeout-minutes': 30, steps: [{ uses: './.github/actions/ci-workspace', with: { mobile: 'true' } }] }, context, 'release_checks/workspace', {}, true);
      if (result.result !== 'success') throw new Error('Release Checks workspace preparation failed');
      // All consumers see a read-only lower mount or a private copy. Writable
      // inode modes let each shard UID copy up Vite's generated config/cache
      // files into its own overlay, without granting writes to the lower mount.
      // No credentials are installed in this source tree.
      await this.privileged(['chmod', '-R', 'a+rwX', this.source]);
      this.engine.preparedWorkspace = this.source;
    } catch (error) { this.finish(); throw error; }
  }
  async execute(slot, job, context, label, workflowEnv = {}, preparation = false) {
    if (this.engine.cancelled) return { result: 'failure', outputs: {} };
    const shard = this.shards.get(slot);
    const host = context.github.job === 'body-suite';
    const owner = host ? `${process.getuid()}:${process.getgid()}` : shard.name;
    const directory = join(this.engine.directory, 'jobs', label.replaceAll('/', '-'));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const cleanup = [];
    const workerDirectory = host ? directory : '/state';
    const placement = host ? `bounded host user (queue slot ${slot})` : shard.name;
    const startedAt = new Date().toISOString();
    let temporary, restoreOwnership, transportFailure;
    try {
      let source = this.source;
      if (!preparation && checkWorkspace(context.github.job) === 'private copy of build') {
        // Body's sandbox hides /tmp, so its private checkout must live elsewhere.
        const hostSource = host ? mkdtempSync('/var/tmp/beeline-check-source-') : undefined;
        source = join(hostSource ?? directory, 'source');
        cleanup.push(hostSource ?? source);
        await this.privileged(['cp', '-a', '--reflink=auto', this.source, source]);
        await this.privileged(['chown', '-R', owner, source]);
      }
      const { secrets: _secrets, vars: _vars, ...safeContext } = context;
      if (!this.fullChecks) safeContext.github = { ...safeContext.github, token: '' };
      // Keep Body's Unix socket paths below the sockaddr_un length limit.
      temporary = host ? mkdtempSync('/tmp/beeline-check-') : undefined;
      const spec = { job, context: safeContext, label, workflowEnv, preparation,
        root: host ? source : '/source', directory: workerDirectory, temporary };
      privateWrite(join(directory, 'spec.json'), JSON.stringify(spec));
      const overlay = !preparation && source === this.source;
      if (overlay) {
        cleanup.push(...['merged', 'upper', 'overlay-work'].map(path => join(directory, path)));
        for (const path of cleanup) mkdirSync(path, { mode: 0o700 });
      }
      restoreOwnership = true;
      await this.privileged(['chown', '-R', owner, directory]);
      const unit = `beeline-release-check-${createHash('sha256').update(directory).digest('hex').slice(0, 24)}.${host ? 'scope' : 'service'}`;
      const node = dirname(dirname(realpathSync(process.execPath)));
      const args = ['systemd-run', '--quiet', '--wait', '--pipe', '--collect', `--unit=${unit}`, `--slice=${shard.slice}`,
        '-p', `RootDirectory=/var/lib/${shard.name}/root`, '-p', 'ProtectSystem=strict', '-p', 'ProtectHome=yes', '-p', 'PrivateTmp=yes',
        '-p', 'KillMode=mixed', '-p', 'NoNewPrivileges=yes',
        '-p', 'BindReadOnlyPaths=/usr /etc/ssl/certs /etc/ld.so.cache /etc/alternatives -/etc/fonts -/opt/google/chrome',
        '-p', `BindReadOnlyPaths=${runnerRoot}:/runner ${node}:/tool/node`,
        '-p', `BindPaths=${directory}:/state /var/lib/${shard.name}/state/run/docker.sock:/ci/run/docker.sock`,
        ...overlay ? ['-p', `BindReadOnlyPaths=${source}:/build`, '-p', `BindPaths=${directory}/merged:/source`,
          '/usr/bin/bash', '-ec', 'mount -t overlay overlay -o lowerdir=/build,upperdir=/state/upper,workdir=/state/overlay-work /source; exec "$@"', 'check-overlay'] : ['-p', `BindPaths=${source}:/source`],
        '/usr/bin/nsenter', `--target=${shard.pid}`, '--user', '--net', '--setuid=0', '--setgid=0', '--',
        '/usr/bin/setpriv', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '--',
        '/usr/bin/env', '-i', 'PATH=/tool/node/bin:/usr/bin:/bin', 'HOME=/state/home', 'LANG=C.UTF-8', 'DOCKER_HOST=unix:///ci/run/docker.sock',
        '/tool/node/bin/node', '/runner/packages/scripts/release-local-check-worker.mjs'];
      this.engine.processes.log(`Check ${label}: ${placement}; ${preparation ? 'shared workspace preparation' : checkWorkspace(context.github.job)}`);
      const options = { quiet: false, timeout: (job['timeout-minutes'] ?? 60) * 60_000 };
      this.active.set(unit, host);
      try {
        if (host) await this.command('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, '-p', 'CPUQuota=300%', '-p', 'MemoryMax=12G',
          process.execPath, join(runnerRoot, 'packages/scripts/release-local-check-worker.mjs'), join(directory, 'spec.json')], options);
        else await this.privileged(args, options);
      } catch (error) {
        transportFailure = error;
        await this.stop(unit, host).catch(() => {});
      } finally {
        this.active.delete(unit);
      }
    } catch (error) {
      transportFailure = error;
    } finally {
      if (temporary) cleanup.push(temporary);
      if (cleanup.length) {
        try { await this.privileged(['rm', '-rf', ...cleanup]); }
        catch (error) { this.engine.processes.log(`${label}: workspace cleanup failed for ${cleanup.join(', ')}. ${error.message}`); }
      }
      if (restoreOwnership) {
        try { await this.privileged(['chown', '-R', `${process.getuid()}:${process.getgid()}`, directory]); }
        catch (error) { this.engine.processes.log(`${label}: could not restore job state ownership. ${error.message}`); }
      }
    }
    const resultPath = join(directory, 'result.json');
    if (!existsSync(resultPath)) {
      const message = `${label}: ${transportFailure?.message || 'Isolated check did not return a result'}`;
      this.engine.processes.log(message);
      appendSummary(join(directory, 'output.log'), message);
      this.engine.records.set(label, { id: label, name: label, conclusion: 'failure', started_at: startedAt, completed_at: new Date().toISOString(), logFile: join(directory, 'output.log') });
      privateWrite(join(this.engine.directory, 'records.json'), JSON.stringify([...this.engine.records.values()], null, 2));
      return { result: 'failure', outputs: {} };
    }
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    for (const record of result.records) this.engine.records.set(record.id, { ...record, conclusion: transportFailure ? 'failure' : record.conclusion, shard: placement, logFile: join(directory, 'output.log') });
    for (const [name, path] of result.artifacts) {
      if (!path.startsWith(`${workerDirectory}/artifacts/`)) throw new Error('Check artifact escaped its private directory');
      this.engine.artifacts.set(name, join(directory, path.slice(workerDirectory.length + 1)));
    }
    privateWrite(join(this.engine.directory, 'records.json'), JSON.stringify([...this.engine.records.values()], null, 2));
    return transportFailure ? { ...result.job, result: 'failure' } : result.job;
  }
  finish() {
    clearInterval(this.sampling);
    process.removeListener('SIGINT', this.onCancel); process.removeListener('SIGTERM', this.onCancel);
    this.sample();
    privateWrite(join(this.engine.directory, 'release-checks-timing.json'), JSON.stringify({
      startedAt: this.startedAt, completedAt: new Date().toISOString(), wallSeconds: (Date.now() - Date.parse(this.startedAt)) / 1000,
      peakHostLoad1: Math.max(...this.samples.map(sample => sample.load[0])), samples: this.samples,
      shards: [...this.shards.values()], records: [...this.engine.records.values()].filter(record => record.id.startsWith('release_checks/')),
    }, null, 2));
  }
}

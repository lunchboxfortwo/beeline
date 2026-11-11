import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { withKernelLock } from './kernel-lock.js';
import {
  beelineInstallLayout,
  prepareLatestRelease,
  readInstalledBundleIdentity,
  readUpdateState,
  writeUpdateState,
  type BeelineInstallLayout,
} from './self-update.js';

const UPDATE_HANDOFF_TIMEOUT_MS = 3 * 60_000;

export function withInstallLock<T>(
  layout: BeelineInstallLayout,
  work: () => Promise<T>,
  options: { waitMs?: number } = {},
): Promise<T> {
  return withKernelLock(`beeline-install:${resolve(layout.libDir)}`, work, options.waitMs);
}

export function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(value);
    return match ? [...match.slice(1, 4).map(Number), match[4] === undefined ? Infinity : Number(match[4])] : undefined;
  };
  const left = parse(actual),
    right = parse(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 4; index++)
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  return true;
}

/** One cancellable update attempt; no agent or control request awaits it. */
export class ReleaseTransaction {
  #attempt?: { controller: AbortController; timer: NodeJS.Timeout };
  #preparing?: Promise<void>;
  #handingOff?: Promise<void>;
  #prepared?: string;
  #minimum?: string;
  #completed = false;
  #pendingCheck = false;
  constructor(
    readonly options: {
      layout: BeelineInstallLayout;
      loadedRelease?: string;
      env: NodeJS.ProcessEnv;
      prepare?: (signal: AbortSignal) => Promise<void>;
      idle: () => boolean;
      handoff: (releaseId: string, interrupted: boolean, signal: AbortSignal) => Promise<void>;
      changed: (desiredRelease?: string) => void;
      failed: (error: unknown, minimum?: string) => void;
    },
  ) {}
  get desiredRelease(): string | undefined { return this.#prepared; }
  get pending(): Promise<void> | undefined { return this.#preparing ?? this.#handingOff; }

  private begin() {
    if (this.#attempt) return this.#attempt;
    const controller = new AbortController();
    const timer = setTimeout(() => this.fail(controller.signal,
      new Error('update handoff timed out; keeping current release')), UPDATE_HANDOFF_TIMEOUT_MS);
    timer.unref();
    return this.#attempt = { controller, timer };
  }

  private fail(signal: AbortSignal, error: unknown, releaseId = this.#prepared): void {
    if (this.#attempt?.controller.signal !== signal) return;
    this.dispose();
    this.#prepared = undefined;
    this.#preparing = this.#handingOff = undefined;
    this.options.changed(undefined);
    this.options.failed(error, this.#minimum);
    if (releaseId) {
      // A failed/rolled-back handoff must not remain a boot selection. Only
      // discard this attempt's target: a newer worker may already have staged.
      const cleanup = withInstallLock(this.options.layout, async () => {
        const state = await readUpdateState(this.options.layout);
        if (state.stagedReleaseId === releaseId)
          await writeUpdateState(this.options.layout, { ...state, stagedReleaseId: undefined,
            lastCheckResult: 'failed', lastCheckError: String(error) });
      }).catch(cleanupError => this.options.failed(cleanupError, this.#minimum)).finally(() => {
        if (this.#preparing !== cleanup) return;
        this.#preparing = undefined;
        if (this.#pendingCheck) this.notify();
      });
      this.#preparing = cleanup;
    }
  }

  notify(_releaseKey?: string, minimum?: string): void {
    if (minimum && (!this.#minimum || !versionAtLeast(this.#minimum, minimum)))
      this.#minimum = minimum;
    if (this.#completed) return;
    if (this.#preparing || this.#handingOff) { this.#pendingCheck = true; return; }
    this.#pendingCheck = false;
    const { controller } = this.begin();
    const { signal } = controller;
    const operation = Promise.resolve().then(async () => {
      if (this.options.prepare) await this.options.prepare(signal);
      else await prepareReleaseInWorker(this.options.env, Date.now() + UPDATE_HANDOFF_TIMEOUT_MS, undefined, signal);
      if (signal.aborted) return;
      const target = (await readUpdateState(this.options.layout)).stagedReleaseId;
      if (!signal.aborted && target) await this.prepared(target);
      else if (!signal.aborted && !this.#pendingCheck) this.dispose();
    }).catch(error => this.fail(signal, error)).finally(() => {
      if (this.#preparing !== operation) return;
      this.#preparing = undefined;
      if (signal.aborted) return;
      if (this.#pendingCheck) this.notify();
      else this.idleChanged();
    });
    this.#preparing = operation;
  }

  async prepared(releaseId: string): Promise<void> {
    if (this.#completed) return;
    const { signal } = this.begin().controller;
    try {
      const targetLayout = { ...this.options.layout,
        libDir: resolve(this.options.layout.releasesRoot, releaseId) };
      const identity = await readInstalledBundleIdentity(targetLayout);
      const loaded = this.options.loadedRelease ? await readInstalledBundleIdentity({
        ...this.options.layout, libDir: resolve(this.options.layout.releasesRoot, this.options.loadedRelease),
      }) : undefined;
      if (identity?.version && loaded?.version && identity.version !== loaded.version &&
          versionAtLeast(loaded.version, identity.version) && !versionAtLeast(identity.version, loaded.version))
        throw new Error(`requested helper ${identity.version} is older than running ${loaded.version}`);
      if (this.#minimum) {
        if (!identity?.version || !versionAtLeast(identity.version, this.#minimum))
          throw new Error(`published helper ${identity?.version ?? 'unknown'} is below required ${this.#minimum}`);
      }
      if (signal.aborted) return;
      if (releaseId === this.options.loadedRelease) {
        this.#prepared = undefined;
        if (!this.#pendingCheck) this.dispose();
        this.options.changed(undefined);
        return;
      }
      this.#prepared = releaseId;
      this.options.changed(releaseId);
      this.idleChanged();
    } catch (error) { this.fail(signal, error, releaseId); }
  }

  idleChanged(): void {
    if (this.#completed || !this.#prepared || this.#preparing || this.#handingOff) return;
    const { signal } = this.begin().controller;
    const operation = Promise.resolve().then(async () => {
      if (signal.aborted) return;
      const interrupted = Boolean(this.#minimum);
      if (!interrupted && !this.options.idle()) return;
      await this.options.handoff(this.#prepared!, interrupted, signal);
      if (!signal.aborted) {
        this.#completed = true;
        this.dispose();
      }
    }).catch(error => this.fail(signal, error)).finally(() => {
      if (this.#handingOff !== operation) return;
      this.#handingOff = undefined;
      if (!signal.aborted && this.#pendingCheck) this.notify();
    });
    this.#handingOff = operation;
  }

  dispose(): void {
    this.#pendingCheck = false;
    if (!this.#attempt) return;
    clearTimeout(this.#attempt.timer);
    this.#attempt.controller.abort();
    this.#attempt = undefined;
  }
}

/** This entry is also bundled independently from the body CLI. */
export async function runManagedUpdateWorker(): Promise<{
  releaseId: string;
  identity: { version?: string; commit?: string };
}> {
  const layout = beelineInstallLayout(process.env);
  if (!layout) throw new Error('release preparation requires an installed layout');
  return withInstallLock(layout, () =>
    prepareLatestRelease(layout, {
      env: process.env,
      force: process.env.BEELINE_FORCE_REPAIR === '1',
      deadlineAt: Number(process.env.BEELINE_PREPARE_DEADLINE_AT) || Date.now() + 180_000,
      logger: (line) => console.error(line),
    }),
  );
}

export async function prepareReleaseInWorker(
  env: NodeJS.ProcessEnv,
  deadlineAt: number,
  entrypoint?: string,
  signal?: AbortSignal,
): Promise<{ releaseId: string; identity: { version?: string; commit?: string } }> {
  const layout = beelineInstallLayout(env)!;
  const bootstrap = entrypoint ?? resolve(layout.libDir, '../beeline-bootstrap.mjs');
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [bootstrap, 'managed-update-worker'], {
      detached: true,
      env: {
        ...env,
        BEELINE_INTERNAL_UPDATE_WORKER: '1',
        BEELINE_UPDATE_GROUP_OWNER: '1',
        BEELINE_PREPARE_DEADLINE_AT: String(deadlineAt),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const abort = () => {
      try {
        if (child.pid && child.exitCode === null && child.signalCode === null)
          process.kill(-child.pid, 'SIGKILL');
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') reject(error); }
      reject(signal?.reason ?? new Error('update handoff abandoned'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('close', () => signal?.removeEventListener('abort', abort));
    let stdout = '',
      stderr = '';
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-16_000);
    });
    child.stderr!.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_000);
    });
    child.once('error', (error) => {
      reject(error);
    });
    child.once('exit', (code) => {
      if (code !== 0)
        return reject(new Error(`release preparation failed (${code}): ${stderr.trim()}`));
      try {
        const result = JSON.parse(stdout);
        if (!result.releaseId) throw new Error('no verified release');
        done(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

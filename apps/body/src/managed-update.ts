import { resolve } from 'node:path';
import { runOwned } from './wait.js';
import { withKernelLock } from './kernel-lock.js';
import {
  beelineInstallLayout,
  prepareLatestRelease,
  readInstalledBundleIdentity,
  readUpdateState,
  writeUpdateState,
  type BeelineInstallLayout,
} from './self-update.js';

/** A busy install lock fails at once with its holder; a second updater never queues behind the first. */
export function withInstallLock<T>(
  layout: BeelineInstallLayout,
  work: () => Promise<T>,
  step = 'Beeline install',
): Promise<T> {
  return withKernelLock(`beeline-install:${resolve(layout.libDir)}`, work, { step });
}

export { versionAtLeast } from './self-update-manifest.js';
import { versionAtLeast } from './self-update-manifest.js';

/**
 * One cancellable update attempt. It ends on its owned worker's exit, a
 * refusal, or the handoff; no timer bounds it.
 */
export class ReleaseTransaction {
  #attempt?: { controller: AbortController };
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
      /** This process's own install-lock work (release pruning) that preparation follows instead of racing. */
      ownWork?: () => Promise<unknown>;
      handoff: (releaseId: string, signal: AbortSignal) => Promise<void>;
      changed: (desiredRelease?: string) => void;
      failed: (error: unknown, minimum?: string) => void;
    },
  ) {}
  get desiredRelease(): string | undefined { return this.#prepared; }
  get pending(): Promise<void> | undefined { return this.#preparing ?? this.#handingOff; }

  private begin() {
    return this.#attempt ??= { controller: new AbortController() };
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
      await this.options.ownWork?.().catch(() => undefined);
      if (signal.aborted) return;
      if (this.options.prepare) await this.options.prepare(signal);
      else await prepareReleaseInWorker(this.options.env, undefined, signal);
      if (signal.aborted) return;
      const target = (await readUpdateState(this.options.layout)).stagedReleaseId;
      if (!signal.aborted && target) await this.prepared(target);
      else if (!signal.aborted && !this.#pendingCheck) this.dispose();
    }).catch(error => this.fail(signal, error)).finally(() => {
      if (this.#preparing !== operation) return;
      this.#preparing = undefined;
      if (signal.aborted) return;
      if (this.#pendingCheck) this.notify();
      else this.handoff();
    });
    this.#preparing = operation;
  }

  /**
   * `current`: the loaded release already satisfies the target. `handed-off`:
   * the handoff already ran. `pending`: the handoff or a failure answers later.
   */
  async prepared(releaseId: string): Promise<'current' | 'handed-off' | 'pending'> {
    if (this.#completed) return 'handed-off';
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
      {
        await withInstallLock(this.options.layout, async () => {
          const state = await readUpdateState(this.options.layout);
          if (state.stagedReleaseId === releaseId)
            await writeUpdateState(this.options.layout, { ...state, stagedReleaseId: undefined,
              lastCheckResult: 'current' });
        });
        this.#prepared = undefined;
        this.options.changed(undefined);
        if (!this.#pendingCheck) this.dispose();
        return 'current';
      }
      if (this.#minimum) {
        if (!identity?.version || !versionAtLeast(identity.version, this.#minimum))
          throw new Error(`published helper ${identity?.version ?? 'unknown'} is below required ${this.#minimum}`);
      }
      if (signal.aborted) return 'pending';
      if (releaseId === this.options.loadedRelease) {
        this.#prepared = undefined;
        if (!this.#pendingCheck) this.dispose();
        this.options.changed(undefined);
        return 'current';
      }
      this.#prepared = releaseId;
      this.options.changed(releaseId);
      this.handoff();
    } catch (error) { this.fail(signal, error, releaseId); }
    return 'pending';
  }

  /** Queued and in-flight items live on the server, so the handoff never waits for agents. */
  private handoff(): void {
    if (this.#completed || !this.#prepared || this.#preparing || this.#handingOff) return;
    const { signal } = this.begin().controller;
    const operation = Promise.resolve().then(async () => {
      if (signal.aborted) return;
      await this.options.handoff(this.#prepared!, signal);
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
      logger: (line) => console.error(line),
    }),
    'release preparation',
  );
}

/** The worker is an owned child: its stderr streams as progress and it dies with its caller. */
export async function prepareReleaseInWorker(
  env: NodeJS.ProcessEnv,
  entrypoint?: string,
  signal?: AbortSignal,
): Promise<{ releaseId: string; identity: { version?: string; commit?: string } }> {
  const layout = beelineInstallLayout(env)!;
  const bootstrap = entrypoint ?? resolve(layout.libDir, '../beeline-bootstrap.mjs');
  const step = 'preparing verified release';
  const child = await runOwned({
    step,
    file: process.execPath,
    args: [bootstrap, 'managed-update-worker'],
    env: { ...env, BEELINE_INTERNAL_UPDATE_WORKER: '1', BEELINE_UPDATE_GROUP_OWNER: '1' },
    ownerLink: true,
    ...(signal ? { signal } : {}),
  });
  if (child.code !== 0)
    throw new Error(`${step}: worker exited ${child.code ?? child.signal}${child.stderr ? `: ${child.stderr.trim().split('\n').at(-1)}` : ''}`);
  const result = JSON.parse(child.stdout);
  if (!result.releaseId) throw new Error('release preparation: no verified release');
  return result;
}

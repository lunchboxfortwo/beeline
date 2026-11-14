import { captureHelperError } from './sentry.js';
import type { EventEmitter } from 'node:events';
export type HelperExitReason = 'stopped' | 'update' | 'failed';
export const HELPER_EXIT_CODES: Readonly<Record<HelperExitReason, 0 | 75>> = {
  stopped: 0,
  update: 0,
  failed: 75,
};
export type AgentExitReason = HelperExitReason | 'agent-removed';
export type HelperLifecycleState =
  { kind: 'starting' } | { kind: 'serving' } | { kind: 'stopping'; reason: HelperExitReason };

/** Cancellation for one hosted agent never controls process exit. */
export class AgentLifecycle {
  #reason: AgentExitReason | undefined;
  constructor(private readonly options: { controller: AbortController }) {}
  get serving(): boolean {
    return !this.options.controller.signal.aborted;
  }
  get state(): { kind: 'serving' } | { kind: 'stopping'; reason: AgentExitReason } {
    return this.#reason ? { kind: 'stopping', reason: this.#reason } : { kind: 'serving' };
  }
  get stopReason(): AgentExitReason | undefined {
    return this.#reason;
  }
  stop(reason: AgentExitReason): void {
    this.#reason ??= reason;
    this.options.controller.abort();
  }
}

/** Only the native service manager decides whether an exited helper restarts. */
export class HelperLifecycle {
  #state: HelperLifecycleState = { kind: 'starting' };
  #exited = false;
  constructor(
    private readonly options: {
      controller: AbortController;
      exitProcess?: (code: number) => void;
    },
  ) {}
  get state(): HelperLifecycleState {
    return this.#state;
  }
  get serving(): boolean {
    return this.#state.kind === 'serving';
  }
  get stopReason(): HelperExitReason | undefined {
    return this.#state.kind === 'stopping' ? this.#state.reason : undefined;
  }
  beginServing(): void {
    if (this.#state.kind === 'starting') this.#state = { kind: 'serving' };
  }
  stop(reason: HelperExitReason): void {
    if (this.#state.kind === 'stopping') return;
    this.#state = { kind: 'stopping', reason };
    this.options.controller.abort();
  }
  exit(reason: HelperExitReason): void {
    if (this.#exited) return;
    this.#exited = true;
    (this.options.exitProcess ?? process.exit)(HELPER_EXIT_CODES[reason]);
  }
  installSignals(emitter: EventEmitter = process): () => void {
    const stop = () => this.stop('stopped');
    emitter.once('SIGINT', stop);
    emitter.once('SIGTERM', stop);
    return () => {
      emitter.removeListener('SIGINT', stop);
      emitter.removeListener('SIGTERM', stop);
    };
  }
}

/**
 * Log an unhandled rejection and keep serving. A stray promise (a watchdog
 * feed, a fire-and-forget wake) must not take every Room down with it.
 */
export function installUnhandledRejectionGuard(emitter: EventEmitter = process): () => void {
  const log = (reason: unknown) => {
    captureHelperError(reason);
    console.error('[thin-core] unhandled rejection (kept running):', reason);
  };
  emitter.on('unhandledRejection', log);
  return () => emitter.removeListener('unhandledRejection', log);
}

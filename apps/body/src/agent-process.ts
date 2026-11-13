import { wall } from '@beeline/api-contract/daemon';
import { type AcpClient } from './acp.js';

/** All production ACP process starts and stops pass through this module. */
export async function startAgentProcess(client: AcpClient): Promise<void> {
  try {
    await client.startProcess();
  } catch (error) {
    await client.stopProcess().catch(() => undefined);
    throw wall('sandbox', error instanceof Error ? error : { message: String(error), status: 503 });
  }
}
export async function stopAgentProcess(client: AcpClient): Promise<void> {
  await client.stopProcess();
}

export const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;
export function resolveSessionIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.BEELINE_BODY_SESSION_IDLE_MS);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_SESSION_IDLE_MS;
}

/**
 * Places with a live session, across every agent this helper hosts. Storage
 * sweeps skip them and try again on their next pass; a session never waits
 * for a sweep.
 */
export class HostPlaces {
  private static readonly live = new Map<string, number>();
  private static readonly maintained = new Set<string>();
  private static hostSweep = false;

  static enter(key: string): void { this.live.set(key, (this.live.get(key) ?? 0) + 1); }
  static leave(key: string): void {
    const count = (this.live.get(key) ?? 0) - 1;
    if (count > 0) this.live.set(key, count); else this.live.delete(key);
  }
  static get hostStoragePaused(): boolean { return this.hostSweep; }

  /** Run `task` only while no session serves `key`. */
  static async withIdleHostRoom(key: string, task: () => Promise<void>): Promise<boolean> {
    if (this.live.has(key) || this.maintained.has(key)) return false;
    this.maintained.add(key);
    try { await task(); return true; }
    finally { this.maintained.delete(key); }
  }

  /** One whole-host sweep at a time; live sessions keep running beside it. */
  static async withIdleHostStorage(task: () => Promise<void>): Promise<boolean> {
    if (this.hostSweep) return false;
    this.hostSweep = true;
    try { await task(); return true; }
    finally { this.hostSweep = false; }
  }
}

import { tryLock, type LockHolder } from './wait.js';

/** The lock is held by another live owner; the caller reports it and does not queue. */
export class KernelLockBusyError extends Error {
  constructor(readonly holder: LockHolder) {
    super(`${holder.step ?? holder.key} already running as pid ${holder.pid || 'unknown'} since ${holder.since}${holder.log ? `; log ${holder.log}` : ''}`);
  }
}

/** Cache reuse is optional: never queue a serving agent behind its owner. */
export async function tryWithKernelLock<T>(key: string, work: () => Promise<T>): Promise<T | undefined> {
  const lock = await tryLock(key);
  if (!lock.held) { lock.close(); return undefined; }
  try {
    return await work();
  } finally {
    await lock.release();
  }
}

/** A kernel-owned local socket is released on process death; a busy lock fails at once with its holder. */
export async function withKernelLock<T>(
  key: string,
  work: () => Promise<T>,
  about: { step?: string; log?: string; generation?: string } = {},
): Promise<T> {
  const lock = await tryLock(key, about);
  if (!lock.held) { lock.close(); throw new KernelLockBusyError(lock.holder); }
  try {
    return await work();
  } finally {
    await lock.release();
  }
}

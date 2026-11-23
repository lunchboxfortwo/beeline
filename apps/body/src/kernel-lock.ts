import { tryLock, type LockHolder } from './wait.js';

/** The lock is held by another live owner; the caller reports it and does not queue. */
export class KernelLockBusyError extends Error {
  constructor(readonly holder: LockHolder) {
    super(
      `${holder.step ?? holder.key} already running as pid ${holder.pid || 'unknown'} since ${holder.since}${holder.log ? `; log ${holder.log}` : ''}`,
    );
  }
}

async function holding<T>(lock: { release: () => Promise<void> }, work: () => Promise<T>) {
  try {
    return await work();
  } finally {
    await lock.release();
  }
}

/** Cache reuse is optional: never queue a serving agent behind its owner. */
export async function tryWithKernelLock<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T | undefined> {
  const lock = await tryLock(key);
  if (lock.held) return holding(lock, work);
  lock.close();
  return undefined;
}

/** A kernel-owned local socket is released on process death; a busy lock fails at once with its holder. */
export async function withKernelLock<T>(
  key: string,
  work: () => Promise<T>,
  about: { step?: string; log?: string; generation?: string } = {},
): Promise<T> {
  const lock = await tryLock(key, about);
  if (lock.held) return holding(lock, work);
  lock.close();
  throw new KernelLockBusyError(lock.holder);
}

/** The holder's socket was refused or reset before its record: it is gone, not busy. */
export function holderVanished(error: unknown): boolean {
  return ['ECONNRESET', 'ECONNREFUSED', 'ENOENT', 'EPIPE'].includes(
    (error as NodeJS.ErrnoException)?.code ?? '',
  );
}

/**
 * A short shared-file critical section (session state, operator secrets).
 * A busy lock is followed to its holder's close, which the kernel delivers on
 * release or death, and then contended again; a holder that vanishes between
 * the busy bind and its record is contended again at once. Every step waits
 * on a kernel event, with no timer and no count. A holder that `follows`
 * declines is refused at once. Residual: under endless contention a caller
 * can keep losing the race (starvation), and a live but stuck holder is
 * followed for as long as it holds.
 */
export async function withKernelLockWhenFree<T>(
  key: string,
  work: () => Promise<T>,
  about: { step?: string; log?: string } = {},
  follows: (holder: LockHolder) => boolean = () => true,
): Promise<T> {
  for (;;) {
    const lock = await tryLock(key, about).catch((error: unknown) => {
      if (holderVanished(error)) return undefined;
      throw error;
    });
    if (!lock) continue;
    if (lock.held) return holding(lock, work);
    // A different key on the same address (a Darwin port collision) is never followed.
    if (lock.holder.key !== key || !follows(lock.holder)) {
      lock.close();
      throw new KernelLockBusyError(lock.holder);
    }
    await lock.released();
  }
}

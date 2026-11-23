import { resolve } from 'node:path';
import { adapterStoreRoot } from './adapter-store.js';
import { tryWithKernelLock, withKernelLock } from './kernel-lock.js';

/**
 * Guards adapter state reads and promotion writes only. A busy lock fails at
 * once ("adapter refresh already running as pid N"); nothing queues behind it.
 */
export async function withAdapterInstallLock<T>(
  work: () => Promise<T> | T,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  return withKernelLock(`beeline-adapters:${resolve(adapterStoreRoot(env))}`, async () => work(), {
    step: 'adapter refresh',
  });
}

const candidateKey = (prefix: string) => `beeline-adapter-candidate:${resolve(prefix)}`;

/** Held by the installer from before its prefix exists until it is promoted or removed. */
export async function withAdapterCandidateLock<T>(prefix: string, work: () => Promise<T>): Promise<T> {
  return withKernelLock(candidateKey(prefix), work, { step: 'adapter candidate install' });
}

/** Runs `work` only while no live installer holds `prefix`; returns false when one does. */
export async function withIdleAdapterCandidate(prefix: string, work: () => Promise<void>): Promise<boolean> {
  return (await tryWithKernelLock(candidateKey(prefix), async () => (await work(), true))) ?? false;
}

import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tryLock } from './wait.js';
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
  return (await tryWithKernelLock(candidateKey(prefix), async () => {
    const directory = join(prefix, '.beeline-users');
    for (const id of await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[];
      throw error;
    })) {
      const use = await tryLock(`beeline-adapter-use:${resolve(prefix)}:${id}`);
      if (!use.held) { use.close(); return false; }
      await use.release();
      await rm(join(directory, id), { force: true });
    }
    await work();
    return true;
  })) ?? false;
}

export async function useAdapterCommand(command: string): Promise<() => Promise<void>> {
  if (!isAbsolute(command)) return async () => {};
  const prefix = resolve(command, '../../..');
  if (!basename(prefix).startsWith('candidate-') || basename(dirname(command)) !== '.bin' ||
      basename(dirname(dirname(command))) !== 'node_modules') return async () => {};
  return withKernelLock(`beeline-adapters:${resolve(prefix, '../..')}`, async () => {
    const id = randomUUID();
    const use = await tryLock(`beeline-adapter-use:${prefix}:${id}`);
    if (!use.held) { use.close(); throw new Error('Adapter session use already owned'); }
    const directory = join(prefix, '.beeline-users');
    try {
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { await use.release(); throw error; }
    }
    const marker = join(directory, id);
    try { await writeFile(marker, ''); }
    catch (error) { await use.release(); throw error; }
    return async () => { try { await rm(marker, { force: true }); } finally { await use.release(); } };
  }, { step: 'adapter session start' });
}

import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
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

export function initializeAdapterCandidate(prefix: string): void {
  mkdirSync(join(prefix, '.beeline-users'));
  writeFileSync(join(prefix, '.beeline-tracked'), '');
}

export async function withIdleAdapterCandidate(prefix: string, work: () => Promise<void>): Promise<boolean> {
  return (await tryWithKernelLock(candidateKey(prefix), async () => {
    if (!existsSync(join(prefix, '.beeline-tracked'))) return false;
    const directory = join(prefix, '.beeline-users');
    let users: string[];
    try { users = readdirSync(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; users = []; }
    for (const id of users) {
      const marker = join(directory, id);
      let pid: number;
      try { pid = Number(readFileSync(marker, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      try { process.kill(pid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
      rmSync(marker, { force: true });
    }
    try { rmdirSync(directory); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
      if (code !== 'ENOENT') throw error;
    }
    await work();
    return true;
  })) ?? false;
}

export function useAdapterCommand(command: string): () => void {
  if (!isAbsolute(command)) return () => {};
  const prefix = resolve(command, '../../..');
  if (!basename(prefix).startsWith('candidate-') || basename(dirname(command)) !== '.bin' ||
      basename(dirname(dirname(command))) !== 'node_modules' || !existsSync(join(prefix, '.beeline-tracked'))) return () => {};
  const marker = join(prefix, '.beeline-users', randomUUID());
  writeFileSync(marker, String(process.pid), { flag: 'wx' });
  return () => rmSync(marker, { force: true });
}

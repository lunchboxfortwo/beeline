import { resolve } from 'node:path';
import { discoveredBeelineInstallLayout, resolveBundleEntrypoint } from './self-update.js';
import { runOwned } from './wait.js';

/** Dependency convergence is an owned child: its output is the progress and it dies with this command. */
export async function convergeDependencies(
  layout: ReturnType<typeof discoveredBeelineInstallLayout>,
  releaseId?: string,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<void> {
  const libDir = releaseId ? resolve(layout.releasesRoot, releaseId) : layout.libDir;
  const entry = await resolveBundleEntrypoint(libDir);
  if (!entry) throw new Error('dependency phase has no selected body');
  const step = 'converging dependencies';
  const child = await runOwned({
    step,
    file: process.execPath,
    args: [entry, 'converge-dependencies'],
    env: { ...env, BEELINE_LIB_DIR: libDir, BEELINE_INTERNAL_RECOVERY: '1' },
    ownerLink: true,
    ...(signal ? { signal } : {}),
  });
  if (child.code !== 0) throw new Error(`${step}: child exited ${child.code ?? child.signal}`);
}

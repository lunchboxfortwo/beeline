import { resolve } from 'node:path';
import { discoveredBeelineInstallLayout, resolveBundleEntrypoint } from './self-update.js';
import { runWorker } from './owner-link.js';

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
  await runWorker(
    'converging dependencies',
    entry,
    'converge-dependencies',
    { ...env, BEELINE_LIB_DIR: libDir, BEELINE_INTERNAL_RECOVERY: '1' },
    signal,
  );
}

import { resolve } from 'node:path';
import { observeChild } from './update-child.js';
import { discoveredBeelineInstallLayout, resolveBundleEntrypoint } from './self-update.js';

export async function convergeDependencies(
  layout: ReturnType<typeof discoveredBeelineInstallLayout>,
  releaseId?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const libDir = releaseId ? resolve(layout.releasesRoot, releaseId) : layout.libDir;
  const entry = await resolveBundleEntrypoint(libDir);
  if (!entry) throw new Error('dependency phase has no selected body');
  await observeChild({
    step: 'converging dependencies',
    forwardStdout: true,
    args: [entry, 'converge-dependencies'],
    env: { ...env, BEELINE_LIB_DIR: libDir, BEELINE_INTERNAL_RECOVERY: '1' },
  });
}

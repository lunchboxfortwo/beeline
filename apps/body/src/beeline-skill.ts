import { beelineManagedSkills as sharedManagedSkills } from '@beeline/api-contract/beeline-guides';
export * from '@beeline/api-contract/beeline-guides';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function runningBeelineReleaseId(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string {
  try {
    const lib = env.BEELINE_LIB_DIR;
    if (!lib) return 'source';
    const manifest = JSON.parse(read(resolve(lib, 'bundle.json'))) as {
      version?: string;
      commit?: string;
    };
    return [manifest.version, manifest.commit].filter(Boolean).join('-') || 'source';
  } catch {
    return 'source';
  }
}


/** Helper environment defaults stay at the helper boundary. */
export function beelineManagedSkills(releaseId: string, options: Parameters<typeof sharedManagedSkills>[1]) {
  return sharedManagedSkills(releaseId, {
    ...options, freeAgent: options.freeAgent ?? Boolean(process.env.BEELINE_FREE_AGENT_ID),
  });
}

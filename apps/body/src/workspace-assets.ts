import { createHash } from 'node:crypto';
import { resolve } from 'node:path';


/** Rebuildable assets belong to a Workspace, not to an agent or Room. */
export function workspaceAssetRoot(supervisorRoot: string, workspaceId: string): string {
  if (!workspaceId) throw new Error('Workspace id is required for shared assets');
  const digest = createHash('sha256').update(workspaceId).digest('hex').slice(0, 24);
  return resolve(supervisorRoot, 'beeline', 'workspaces', digest, 'shared-home');
}

export interface WorkspaceAssetPaths {
  root: string;
  cache: string;
  tools: string;
}

export const SHARED_LAYOUT_MARKER = 'layout-live-v1.json';
export const PACKAGE_CACHE_DIRS = [
  'npm', 'pnpm', 'uv', 'go-mod', 'go-build', 'turbo', 'huggingface',
  'browser/playwright', 'browser/puppeteer', 'cargo/registry',
] as const;

export function workspaceAssetPaths(root: string): WorkspaceAssetPaths {
  const absolute = resolve(root);
  return {
    root: absolute,
    cache: resolve(absolute, 'cache'),
    tools: resolve(absolute, 'tools'),
  };
}

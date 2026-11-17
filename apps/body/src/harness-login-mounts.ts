import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentKind } from './agent-command.js';

/**
 * Writable operator login destinations for an isolated session. Everything
 * else stays on the read-only host mount; the harness's private state remains
 * writable, including its credential links, locks and staging files.
 *
 * Never single-file-bind an atomic replacement destination: rename fails on a
 * mountpoint, and a helper /login would leave the session reading a stale inode.
 * Unknown native login writers retain their whole credential directory until
 * both login and refresh have been proved with narrower mounts.
 */
export function harnessLoginWritablePaths(kind: AgentKind | undefined, operatorHome: string): string[] {
  const directories: string[] = [];
  switch (kind) {
    case 'pi':
      // Complete login writer not proved with narrower mounts. Keep the
      // directory writable, including auth.json.lock and any staging files.
      directories.push('.pi/agent');
      break;
    case 'codex':
      // Codex resolves credential symlinks and atomically replaces auth.json
      // using .auth-* siblings. auth.lock also needs its writable state root.
      directories.push('.codex');
      break;
    case 'grok':
      // Native login/refresh writer not proved safe with a single-file mount.
      directories.push('.grok');
      break;
    case 'cursor':
      // Native login also maintains agent-cli-state.json; retain both stores
      // until the complete login/refresh writer can be exercised independently.
      directories.push('.cursor', '.config/cursor');
      break;
    case 'opencode':
      // /login atomically replaces auth.json; native refresh remains unproved.
      directories.push('.local/share/opencode');
      break;
    // Claude atomically replaces its PRIVATE credential link. The helper's
    // existing watcher writes back only that credential outside the sandbox.
    // Goose receives private copies of config.yaml/secrets.yaml and env keys.
    // Neither requires a writable operator directory. Custom/reference have
    // no known shared credential store.
  }
  const writable: string[] = [];
  for (const directory of directories) {
    const path = resolve(operatorHome, directory);
    try {
      const stats = lstatSync(path);
      if (stats.isDirectory() || stats.isSymbolicLink()) writable.push(realpathSync(path));
    } catch { /* No store until the helper completes the first /login. */ }
  }
  return [...new Set(writable)].sort();
}

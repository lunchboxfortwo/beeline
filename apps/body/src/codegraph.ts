import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, appendFile, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { McpServerWire } from './acp.js';
import type { BodyConfig } from './config.js';
import { withKernelLockWhenFree } from './kernel-lock.js';
import { runOwned, runOwnedFile } from './wait.js';

const CODEGRAPH_INDEX_PATH = '.codegraph/codegraph.db';
const CODEGRAPH_READONLY_SNAPSHOT_NAME = 'codegraph.readonly.db';

/**
 * ESM preload injected via `NODE_OPTIONS` for read-only CodeGraph MCP sessions.
 *
 * Read-only checkouts cannot create SQLite `-wal`/`-shm` side files next to
 * `.codegraph/codegraph.db`. Opening the published immutable snapshot at
 * `.codegraph/codegraph.readonly.db` (falling back to `codegraph.db` when no
 * snapshot exists yet) as an immutable read-only SQLite URI avoids side files
 * and write PRAGMAs while leaving the live database and its WAL/SHM untouched.
 * Extending `DatabaseConnection.isReplacedOnDisk()` to track the resolved
 * target path, inode, size, and timestamps ensures CodeGraph reopens after
 * every snapshot publication.
 */
const READONLY_SQLITE_PRELOAD_SOURCE = `
import Module from 'node:module';
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIVE_DB_NAME = 'codegraph.db';
const SNAPSHOT_DB_NAME = '${CODEGRAPH_READONLY_SNAPSHOT_NAME}';
const origLoad = Module._load;
const dbFingerprints = new WeakMap();
let patchedSqlite;

function resolveReadonlyTarget(filePath) {
  if (typeof filePath !== 'string' || filePath === '' || filePath === ':memory:') return filePath;
  let diskPath = filePath;
  if (filePath.startsWith('file:')) {
    try {
      diskPath = fileURLToPath(new URL(filePath));
    } catch {
      return filePath;
    }
  }
  if (basename(diskPath) === LIVE_DB_NAME) {
    const snapshotPath = join(dirname(diskPath), SNAPSHOT_DB_NAME);
    if (existsSync(snapshotPath)) return snapshotPath;
  }
  return diskPath;
}

function dbFingerprint(filePath) {
  const target = resolveReadonlyTarget(filePath);
  if (!target || target === ':memory:') return null;
  try {
    const stat = statSync(target, { bigint: true });
    return target + '|' + stat.dev + ':' + stat.ino + ':' + stat.size + ':' + stat.mtimeNs + ':' + stat.ctimeNs;
  } catch {
    return null;
  }
}

Module._load = function (request, parent, isMain) {
  const mod = origLoad.apply(this, arguments);
  if (request === 'node:sqlite' || request === 'sqlite') {
    if (!patchedSqlite) {
      const OrigDatabaseSync = mod.DatabaseSync;
      class ImmutableDatabaseSync extends OrigDatabaseSync {
        constructor(location, options) {
          if (typeof location === 'string' && location !== '' && location !== ':memory:') {
            const target = resolveReadonlyTarget(location);
            let uri;
            if (target.startsWith('file:')) {
              const url = new URL(target);
              url.searchParams.set('immutable', '1');
              uri = url.href;
            } else {
              uri = pathToFileURL(target).href + '?immutable=1';
            }
            const nextOptions =
              options && typeof options === 'object'
                ? { ...options, readOnly: true }
                : { readOnly: true };
            super(uri, nextOptions);
          } else {
            super(location, options);
          }
        }
        exec(sql) {
          if (
            typeof sql === 'string' &&
            /^\\s*PRAGMA\\s+(?:journal_mode|synchronous|journal_size_limit)\\s*=/i.test(sql)
          ) {
            return;
          }
          return super.exec(sql);
        }
      }
      patchedSqlite = { ...mod, DatabaseSync: ImmutableDatabaseSync };
    }
    return patchedSqlite;
  }
  if (
    mod &&
    typeof mod === 'object' &&
    typeof mod.DatabaseConnection === 'function' &&
    mod.DatabaseConnection.prototype &&
    !mod.DatabaseConnection.prototype.__beelineReadonlyPatched
  ) {
    const proto = mod.DatabaseConnection.prototype;
    proto.__beelineReadonlyPatched = true;
    const origIsReplaced = proto.isReplacedOnDisk;
    proto.isReplacedOnDisk = function () {
      if (typeof origIsReplaced === 'function' && origIsReplaced.call(this)) return true;
      const filePath = typeof this.getPath === 'function' ? this.getPath() : this.dbPath;
      if (!filePath || filePath === ':memory:') return false;
      const current = dbFingerprint(filePath);
      const opened = dbFingerprints.get(this);
      if (opened === undefined) {
        if (current !== null) dbFingerprints.set(this, current);
        return false;
      }
      return current !== null && current !== opened;
    };
    const origOpen = mod.DatabaseConnection.open;
    if (typeof origOpen === 'function') {
      mod.DatabaseConnection.open = function (dbPath) {
        const fingerprint = dbFingerprint(dbPath);
        const connection = origOpen.apply(this, arguments);
        if (fingerprint !== null) dbFingerprints.set(connection, fingerprint);
        return connection;
      };
    }
  }
  return mod;
};
`.trim();

const READONLY_SQLITE_NODE_OPTION = `--import=data:text/javascript;base64,${Buffer.from(READONLY_SQLITE_PRELOAD_SOURCE).toString('base64')}`;

export const CODEGRAPH_MCP_SERVER_NAME = 'codegraph';

/** Release-owned, repository-scoped CodeGraph MCP server. */
export function codegraphMcpServer(
  config: BodyConfig,
  cwd: string,
  options: { readonly: boolean },
): McpServerWire | undefined {
  if (!config.codegraphCommand) return undefined;
  return {
    name: CODEGRAPH_MCP_SERVER_NAME,
    command: config.codegraphCommand,
    args: ['serve', '--mcp', '--path', resolve(cwd), ...(options.readonly ? ['--no-watch'] : [])],
    // One MCP child per harness session is easier to contain than a daemon
    // that can outlive the place whose index and permissions it used.
    env: [
      { name: 'CODEGRAPH_TELEMETRY', value: '0' },
      { name: 'CODEGRAPH_NO_DAEMON', value: '1' },
      ...(options.readonly ? [{ name: 'NODE_OPTIONS', value: READONLY_SQLITE_NODE_OPTION }] : []),
    ],
  };
}

async function isGitWorktree(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await runOwnedFile('git', ['rev-parse', '--show-toplevel'], {
      cwd,
    });
    const [top, target] = await Promise.all([
      realpath(stdout.trim()).catch(() => resolve(stdout.trim())),
      realpath(cwd).catch(() => resolve(cwd)),
    ]);
    return top === target;
  } catch {
    return false;
  }
}

/** Keep CodeGraph's generated local index out of arbitrary repository changes. */
async function excludeIndexFromGitStatus(cwd: string): Promise<void> {
  try {
    const { stdout } = await runOwnedFile('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd,
    });
    const gitPath = stdout.trim();
    if (!gitPath) return;
    const path = isAbsolute(gitPath) ? gitPath : resolve(cwd, gitPath);
    await mkdir(dirname(path), { recursive: true });
    const existing = await readFile(path, 'utf8').catch(() => '');
    if (existing.split('\n').includes('.codegraph/')) return;
    await appendFile(path, `${existing && !existing.endsWith('\n') ? '\n' : ''}.codegraph/\n`);
  } catch {
    // Index hygiene is best-effort and must never block a Room or corner.
  }
}

interface SqliteStatementLike {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementLike;
  close(): void;
}

type SqliteModuleLike = {
  DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => SqliteDatabaseLike;
};

/**
 * Publish a self-contained immutable read-only snapshot at a separate path
 * (`.codegraph/codegraph.readonly.db`) via `VACUUM INTO` + atomic `rename`.
 *
 * The live `.codegraph/codegraph.db` and its `-wal`/`-shm` sidecars are never
 * replaced or removed, so concurrent connections keep writing safely while
 * immutable readers always see every committed update with a fresh inode.
 */
async function publishReadonlySnapshot(command: string, indexPath: string): Promise<void> {
  const snapshotPath = resolve(dirname(indexPath), CODEGRAPH_READONLY_SNAPSHOT_NAME);
  const stagingPath = `${snapshotPath}.tmp-${process.pid}-${randomUUID()}`;
  let sqlite: SqliteModuleLike | undefined;
  try {
    const require = createRequire(import.meta.url);
    sqlite = require('node:sqlite') as SqliteModuleLike;
  } catch {
    sqlite = undefined;
  }

  if (sqlite) {
    const db = new sqlite.DatabaseSync(indexPath);
    let created = false;
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      try {
        db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
      } catch {
        // Best-effort checkpoint; VACUUM INTO still reads all committed WAL frames.
      }
      db.prepare('VACUUM INTO ?').run(stagingPath);
      created = true;
    } finally {
      db.close();
      if (!created) await rm(stagingPath, { force: true }).catch(() => undefined);
    }
    try {
      await rename(stagingPath, snapshotPath);
    } catch (error) {
      await rm(stagingPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return;
  }

  // Fallback for Node < 22.5 hosts: use CodeGraph's bundled Node runtime.
  const resolvedCommand = await realpath(command).catch(() => resolve(command));
  const candidates = [
    resolve(dirname(resolvedCommand), '..', 'node'),
    resolve(dirname(resolvedCommand), '..', 'lib', 'beeline', 'codegraph', 'node'),
  ];
  let bundledNode = candidates[0]!;
  for (const candidate of candidates) {
    if (
      await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      )
    ) {
      bundledNode = candidate;
      break;
    }
  }
  const script = `
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const [indexPath, stagingPath, snapshotPath] = process.argv.slice(1);
const db = new DatabaseSync(indexPath);
let created = false;
try {
  db.exec('PRAGMA busy_timeout = 5000');
  try { db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get(); } catch {}
  db.prepare('VACUUM INTO ?').run(stagingPath);
  created = true;
} finally {
  db.close();
  if (!created) { try { fs.rmSync(stagingPath, { force: true }); } catch {} }
}
try {
  fs.renameSync(stagingPath, snapshotPath);
} catch (error) {
  try { fs.rmSync(stagingPath, { force: true }); } catch {}
  throw error;
}
`.trim();
  await runOwnedFile(
    bundledNode,
    ['--disable-warning=ExperimentalWarning', '-e', script, indexPath, stagingPath, snapshotPath],
    {
      cwd: dirname(indexPath),
      maxBuffer: 1024 * 1024,
    },
  );
}

/** Verify the index opens and answers a real MCP query before claiming it is ready. */
async function verifyCodegraphIndex(
  config: BodyConfig,
  cwd: string,
  options: { readonly: boolean },
): Promise<boolean> {
  const server = codegraphMcpServer(config, cwd, options);
  if (!server) return false;
  const target = resolve(cwd);
  const serverArgs = server.args ?? [];
  const args = serverArgs.includes('--no-watch') ? serverArgs : [...serverArgs, '--no-watch'];
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const entry of server.env ?? []) env[entry.name] = entry.value;
  const requests =
    [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'beeline-codegraph-probe', version: '1.0.0' },
        },
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'codegraph_explore', arguments: { query: 'index', projectPath: target } },
      }),
    ].join('\n') + '\n';

  let child: ChildProcess | undefined;
  let reply:
    | {
        error?: unknown;
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      }
    | undefined;
  try {
    await runOwned({
      step: 'codegraph probe',
      file: server.command,
      args,
      cwd: target,
      env,
      stdin: 'pipe',
      machineRead: true,
      maxBuffer: 4 * 1024 * 1024,
      onSpawn: (spawned) => {
        child = spawned;
        spawned.stdin?.on('error', () => undefined);
        spawned.stdin?.write(requests);
      },
      onLine: (line, stream) => {
        if (stream !== 'stdout' || reply) return;
        try {
          const message = JSON.parse(line) as {
            id?: unknown;
            error?: unknown;
            result?: { isError?: boolean; content?: Array<{ text?: string }> };
          };
          if (message.id !== 2) return;
          reply = message;
          child?.stdin?.end();
        } catch {
          // Ignore non-JSON lines.
        }
      },
    });
  } catch (error) {
    console.warn(
      `[body] CodeGraph test query failed for ${cwd}; continuing with Beeline read tools:`,
      error,
    );
    return false;
  }

  const text = (reply?.result?.content ?? [])
    .map((entry) => entry.text ?? '')
    .join('\n')
    .trim();
  const ok =
    Boolean(reply) &&
    !reply?.error &&
    reply?.result?.isError !== true &&
    text.length > 0 &&
    !/isn't indexed with codegraph/i.test(text);
  if (!ok) {
    console.warn(
      `[body] CodeGraph test query did not succeed for ${cwd}; continuing with Beeline read tools:`,
      reply?.error ?? (text || 'no MCP query reply'),
    );
  }
  return ok;
}

/**
 * Build or refresh the index before exposing CodeGraph tools, then confirm a
 * test query succeeds. Repository-less surfaces skip this quietly; failures
 * leave the ordinary Beeline read tools available and never prevent startup.
 */
export async function prepareCodegraphIndex(
  config: BodyConfig,
  cwd: string,
  options: { readonly?: boolean } = {},
): Promise<boolean> {
  const command = config.codegraphCommand;
  if (!command || !(await isGitWorktree(cwd))) return false;
  const canonicalCwd = await realpath(cwd).catch(() => resolve(cwd));
  const indexPath = resolve(canonicalCwd, CODEGRAPH_INDEX_PATH);
  const indexedBefore = await access(indexPath).then(
    () => true,
    () => false,
  );
  const canWrite = await access(indexedBefore ? dirname(indexPath) : canonicalCwd, constants.W_OK).then(
    () => true,
    () => false,
  );
  const readonly = options.readonly ?? !canWrite;
  if (canWrite) {
    const built = await withKernelLockWhenFree(
      `codegraph-index:${canonicalCwd}`,
      async () => {
        await excludeIndexFromGitStatus(canonicalCwd);
        const indexed = await access(indexPath).then(
          () => true,
          () => false,
        );
        const args = indexed ? ['sync', '--quiet', canonicalCwd] : ['init', '--yes', canonicalCwd];
        try {
          await runOwnedFile(command, args, {
            cwd: canonicalCwd,
            env: { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_DAEMON: '1' },
            maxBuffer: 4 * 1024 * 1024,
          });
          if (readonly) await publishReadonlySnapshot(command, indexPath);
          return true;
        } catch (error) {
          console.warn(
            `[body] CodeGraph ${args[0]} failed for ${cwd}; continuing with Beeline read tools:`,
            error,
          );
          return false;
        }
      },
      { step: `indexing CodeGraph at ${canonicalCwd}` },
    );
    if (!built) return false;
  } else if (!indexedBefore) {
    console.warn(
      `[body] CodeGraph index missing on read-only checkout ${cwd}; continuing with Beeline read tools.`,
    );
    return false;
  }
  return verifyCodegraphIndex(config, cwd, { readonly });
}

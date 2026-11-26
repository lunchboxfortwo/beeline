import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, appendFile, mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { McpServerWire } from './acp.js';
import type { BodyConfig } from './config.js';
import { runOwned, runOwnedFile } from './wait.js';

const CODEGRAPH_INDEX_PATH = '.codegraph/codegraph.db';

/**
 * ESM preload injected via `NODE_OPTIONS` for read-only CodeGraph MCP sessions.
 *
 * Read-only checkouts cannot create SQLite `-wal`/`-shm` side files next to
 * `.codegraph/codegraph.db`. Opening file-backed databases as immutable
 * read-only SQLite URIs avoids side files and write PRAGMAs, while extending
 * `DatabaseConnection.isReplacedOnDisk()` to check size and timestamps ensures
 * CodeGraph reopens the immutable handle after any reindex.
 */
const READONLY_SQLITE_PRELOAD_SOURCE = `
import Module from 'node:module';
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const origLoad = Module._load;
const dbFingerprints = new WeakMap();
let patchedSqlite;

function dbFingerprint(filePath) {
  try {
    const stat = statSync(filePath, { bigint: true });
    return stat.dev + ':' + stat.ino + ':' + stat.size + ':' + stat.mtimeNs + ':' + stat.ctimeNs;
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
            let uri;
            if (location.startsWith('file:')) {
              const url = new URL(location);
              url.searchParams.set('immutable', '1');
              uri = url.href;
            } else {
              uri = pathToFileURL(location).href + '?immutable=1';
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

/** Release-owned, repository-scoped CodeGraph MCP server. */
export function codegraphMcpServer(
  config: BodyConfig,
  cwd: string,
  options: { readonly: boolean },
): McpServerWire | undefined {
  if (!config.codegraphCommand) return undefined;
  return {
    name: 'codegraph',
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
  prepare(sql: string): SqliteStatementLike;
  close(): void;
}

type SqliteModuleLike = {
  DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => SqliteDatabaseLike;
};

/**
 * Merge any committed WAL frames into the main SQLite database file so
 * immutable read-only connections see the latest index even when another
 * SQLite connection remained open during reindexing. If a concurrent reader
 * blocks WAL truncation, publish a self-contained snapshot via `VACUUM INTO`.
 */
async function checkpointCodegraphIndex(command: string, indexPath: string): Promise<void> {
  const walPath = `${indexPath}-wal`;
  const shmPath = `${indexPath}-shm`;
  const snapshotPath = `${indexPath}.checkpoint-${process.pid}-${randomUUID()}`;
  let sqlite: SqliteModuleLike | undefined;
  try {
    const require = createRequire(import.meta.url);
    sqlite = require('node:sqlite') as SqliteModuleLike;
  } catch {
    sqlite = undefined;
  }

  if (sqlite) {
    const db = new sqlite.DatabaseSync(indexPath);
    let publishedSnapshot = false;
    try {
      const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
        | { busy?: number; log?: number; checkpointed?: number }
        | undefined;
      const walSize = await stat(walPath).then(
        (info) => info.size,
        () => 0,
      );
      const incomplete =
        (result?.busy ?? 0) !== 0 ||
        ((result?.log ?? 0) > 0 && (result?.checkpointed ?? 0) < (result?.log ?? 0)) ||
        walSize > 0;
      if (incomplete) {
        db.prepare('VACUUM INTO ?').run(snapshotPath);
        publishedSnapshot = true;
      }
    } finally {
      db.close();
      if (!publishedSnapshot) await rm(snapshotPath, { force: true }).catch(() => undefined);
    }
    if (publishedSnapshot) {
      try {
        await rename(snapshotPath, indexPath);
      } catch (error) {
        await rm(snapshotPath, { force: true }).catch(() => undefined);
        throw error;
      }
      await rm(walPath, { force: true }).catch(() => undefined);
      await rm(shmPath, { force: true }).catch(() => undefined);
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
const [indexPath, snapshotPath] = process.argv.slice(1);
const walPath = indexPath + '-wal';
const shmPath = indexPath + '-shm';
const db = new DatabaseSync(indexPath);
let publishedSnapshot = false;
try {
  const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() || {};
  let walSize = 0;
  try { walSize = fs.statSync(walPath).size; } catch {}
  const incomplete = (result.busy || 0) !== 0 || ((result.log || 0) > 0 && (result.checkpointed || 0) < result.log) || walSize > 0;
  if (incomplete) {
    db.prepare('VACUUM INTO ?').run(snapshotPath);
    publishedSnapshot = true;
  }
} finally {
  db.close();
  if (!publishedSnapshot) { try { fs.rmSync(snapshotPath, { force: true }); } catch {} }
}
if (publishedSnapshot) {
  fs.renameSync(snapshotPath, indexPath);
  try { fs.rmSync(walPath, { force: true }); } catch {}
  try { fs.rmSync(shmPath, { force: true }); } catch {}
}
`.trim();
  await runOwnedFile(bundledNode, ['--disable-warning=ExperimentalWarning', '-e', script, indexPath, snapshotPath], {
    cwd: dirname(indexPath),
    maxBuffer: 1024 * 1024,
  });
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
  const indexPath = resolve(cwd, CODEGRAPH_INDEX_PATH);
  const indexed = await access(indexPath).then(
    () => true,
    () => false,
  );
  const canWrite = await access(indexed ? dirname(indexPath) : cwd, constants.W_OK).then(
    () => true,
    () => false,
  );
  const readonly = options.readonly ?? !canWrite;
  if (canWrite) {
    await excludeIndexFromGitStatus(cwd);
    const args = indexed ? ['sync', '--quiet', cwd] : ['init', '--yes', cwd];
    try {
      await runOwnedFile(command, args, {
        cwd,
        env: { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_DAEMON: '1' },
        maxBuffer: 4 * 1024 * 1024,
      });
      if (readonly) await checkpointCodegraphIndex(command, indexPath);
    } catch (error) {
      console.warn(
        `[body] CodeGraph ${args[0]} failed for ${cwd}; continuing with Beeline read tools:`,
        error,
      );
      return false;
    }
  } else if (!indexed) {
    console.warn(
      `[body] CodeGraph index missing on read-only checkout ${cwd}; continuing with Beeline read tools.`,
    );
    return false;
  }
  return verifyCodegraphIndex(config, cwd, { readonly });
}

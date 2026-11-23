/**
 * The only place a helper command or agent tool waits.
 *
 * A wait ends on (a) the answer to its own request, or (b) the exit of a child
 * it owns. It never waits for a condition: "every agent serving", "agents
 * idle", "a socket or result file appears", "a lock frees up", "stdin ends".
 * A wait also ends on its channel's explicit failure event (`error`,
 * close/EOF, ENOENT, ECONNREFUSED, child `exit`). Nothing here arms a timer,
 * retries, polls or caps; a silent remote peer is bounded only by its
 * transport's own read failure. `helper.waits` in
 * docs/architecture/invariants.json keeps every other wait out of apps/body/src.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createConnection, createServer, type Socket } from 'node:net';

const say = (line: string) => process.stderr.write(`[beeline] ${line}\n`);

/** A local line-protocol peer: one JSON line out, one JSON line back. */
export interface SocketChannel {
  socket: string;
  peer: string;
  report?: ((line: string) => void) | false;
}
/** An HTTP peer; the transport's own read failure ends a silent wait. */
export interface HttpChannel {
  url: string | URL;
  peer?: string;
  fetch?: typeof fetch;
  report?: ((line: string) => void) | false;
}

/** The peer answered with `{ error }`: an explicit refusal, not a lost channel. */
export class PeerRefusal extends Error {}

export function ask<T = unknown>(channel: SocketChannel, request: unknown): Promise<T>;
export function ask(channel: HttpChannel, request?: RequestInit): Promise<Response>;
export async function ask(
  channel: SocketChannel | HttpChannel,
  request?: unknown,
): Promise<unknown> {
  const report = channel.report === false ? undefined : (channel.report ?? say);
  if ('url' in channel) {
    const init = request as RequestInit | undefined;
    const peer = channel.peer ?? new URL(channel.url).host;
    report?.(`waiting for ${peer} (${init?.method ?? 'GET'} ${new URL(channel.url).pathname})`);
    return (channel.fetch ?? fetch)(channel.url, init);
  }
  report?.(`waiting for ${channel.peer}`);
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection(channel.socket);
    let input = '';
    let settled = false;
    const settle = (error?: Error, answer?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(answer);
    };
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      input += chunk;
      const end = input.indexOf('\n');
      if (end < 0) return;
      try {
        const answer = JSON.parse(input.slice(0, end)) as { error?: unknown };
        if (answer && typeof answer === 'object' && answer.error)
          settle(new PeerRefusal(`${channel.peer}: ${String(answer.error)}`));
        else settle(undefined, answer);
      } catch {
        settle(new Error(`${channel.peer}: unreadable answer`));
      }
    });
    socket.once('error', (error: NodeJS.ErrnoException) =>
      settle(
        Object.assign(new Error(`${channel.peer}: ${error.code ?? error.message}`), {
          code: error.code,
        }),
      ),
    );
    socket.once('close', () =>
      settle(
        Object.assign(new Error(`${channel.peer} closed the connection before answering`), {
          code: 'ECONNRESET',
        }),
      ),
    );
  });
}

export interface OwnedCommand {
  /** Names the child in progress lines and errors. */
  step: string;
  file: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Written to stdin, which is then closed. Without it stdin is closed at once. */
  input?: string;
  /**
   * One of our own workers: its stdin stays an open pipe this owner holds, so
   * the worker sees EOF when the owner dies, even by SIGKILL (see owner-link.ts).
   */
  ownerLink?: boolean;
  /** Called for each output line as it arrives. By default stderr lines stream to the terminal. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Forward stdout lines too (the child's stdout is progress, not a result). */
  streamStdout?: boolean;
  /** A terminal program: inherits stdio and stays in the terminal's process group. */
  interactive?: boolean;
  /** The caller left: kill the child's process group. */
  signal?: AbortSignal;
}
export interface OwnedResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const owned = new Set<ChildProcess>();
const groupLeaders = new WeakSet<ChildProcess>();
/** Set in every owned child: one owned tree shares its outermost owner's process group. */
const OWNED_GROUP = 'BEELINE_OWNED_GROUP';
let ownerHooks = false;
function killGroup(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    // A terminal program, or a child inside an outer owner's group, is killed
    // by pid; the outermost owner kills the whole group.
    process.kill(groupLeaders.has(child) ? -child.pid : child.pid, 'SIGKILL');
  } catch {
    // The group is already gone.
  }
}
/**
 * Run a child this caller owns until it exits. Output lines stream as they
 * arrive, so the child's own output is the progress. On exit the child's
 * process group is killed, so grandchildren holding its pipes die and the
 * output closes; nothing is left running after the result.
 */
export function runOwned(command: OwnedCommand): Promise<OwnedResult> {
  // Owned children never outlive their owner: exit and SIGINT/SIGTERM kill each group.
  if (!ownerHooks) {
    ownerHooks = true;
    process.once('exit', () => {
      for (const child of owned) killGroup(child);
    });
    for (const name of ['SIGINT', 'SIGTERM'] as const) {
      const onSignal = () => {
        for (const child of owned) killGroup(child);
        process.removeListener(name, onSignal);
        // Keep the default disposition when nobody else handles the signal.
        if (!process.listenerCount(name)) process.kill(process.pid, name);
        else process.once(name, onSignal);
      };
      process.once(name, onSignal);
    }
  }
  const onLine =
    command.onLine ??
    ((line: string, stream: 'stdout' | 'stderr') => {
      if (stream === 'stderr' || command.streamStdout) process.stderr.write(`${line}\n`);
    });
  return new Promise((resolve, reject) => {
    if (command.signal?.aborted) {
      reject(new Error(`${command.step}: cancelled before start`));
      return;
    }
    // The outermost owner puts its child in a new process group, so the whole
    // tree, including nested owners' children, dies with one kill.
    const leader = !command.interactive && process.env[OWNED_GROUP] !== '1';
    const env = { ...(command.env ?? process.env) };
    if (command.interactive) delete env[OWNED_GROUP];
    else env[OWNED_GROUP] = '1';
    if (command.ownerLink) env.BEELINE_OWNER_LINK = '1';
    else delete env.BEELINE_OWNER_LINK;
    const child = spawn(command.file, [...command.args], {
      env,
      ...(command.cwd ? { cwd: command.cwd } : {}),
      detached: leader,
      stdio: command.interactive
        ? 'inherit'
        : [command.input === undefined && !command.ownerLink ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (leader) groupLeaders.add(child);
    owned.add(child);
    const output = { stdout: '', stderr: '' };
    const pending = { stdout: '', stderr: '' };
    const read = (stream: 'stdout' | 'stderr') => (chunk: string) => {
      output[stream] += chunk;
      pending[stream] += chunk;
      let end: number;
      while ((end = pending[stream].indexOf('\n')) >= 0) {
        onLine(pending[stream].slice(0, end), stream);
        pending[stream] = pending[stream].slice(end + 1);
      }
    };
    child.stdout?.setEncoding('utf8').on('data', read('stdout'));
    child.stderr?.setEncoding('utf8').on('data', read('stderr'));
    if (command.input !== undefined) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(command.input);
    }
    const abort = () => killGroup(child);
    command.signal?.addEventListener('abort', abort, { once: true });
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const finish = (error?: Error) => {
      owned.delete(child);
      command.signal?.removeEventListener('abort', abort);
      for (const stream of ['stdout', 'stderr'] as const)
        if (pending[stream]) onLine(pending[stream], stream);
      if (error) reject(error);
      else resolve({ ...exited!, ...output });
    };
    child.once('error', (error) => {
      killGroup(child);
      finish(new Error(`${command.step}: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      // Settled by exit: leftover pipe holders in the group die now.
      if (leader) killGroup(child);
    });
    // After the group is gone the pipes reach EOF; `close` only collects output.
    child.once('close', () => {
      if (!exited) return;
      if (command.signal?.aborted)
        finish(new Error(`${command.step}: cancelled; process group killed`));
      else finish();
    });
  });
}

export interface LockHolder {
  pid: number;
  key: string;
  since: string;
  step?: string;
  log?: string;
}
export type LockAttempt =
  | { held: true; release: () => Promise<void> }
  | { held: false; holder: LockHolder; released: () => Promise<void> };

function lockAddress(key: string): { path: string } | { port: number; host: string } {
  const hash = createHash('sha256').update(key).digest();
  // Linux abstract sockets have no stale filesystem inode and are released on
  // process death. macOS uses loopback ports below its ephemeral range; hash
  // collisions only serialize otherwise unrelated owners.
  return process.platform === 'linux'
    ? { path: `\0beeline-lock-${hash.toString('hex')}` }
    : { port: 20_000 + (hash.readUInt32BE(0) % 10_000), host: '127.0.0.1' };
}

/**
 * A kernel-owned lock that never queues. A busy lock returns at once with the
 * holder's record; `released()` follows the holder's socket until it closes,
 * which the kernel does on release or holder death.
 */
export async function tryLock(
  key: string,
  about: { step?: string; log?: string } = {},
): Promise<LockAttempt> {
  const address = lockAddress(key);
  // A second bind happens only when the holder closed between our bind and its answer.
  for (const last of [false, true]) {
    const peers = new Set<Socket>();
    const since = new Date().toISOString();
    const server = createServer((peer) => {
      peers.add(peer);
      peer.on('error', () => undefined);
      peer.once('close', () => peers.delete(peer));
      peer.write(`${JSON.stringify({ pid: process.pid, key, since, ...about })}\n`);
    });
    const bound = await new Promise<boolean>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) =>
        error.code === 'EADDRINUSE' ? resolve(false) : reject(error),
      );
      server.listen(address, () => resolve(true));
    });
    if (bound)
      return {
        held: true,
        release: () =>
          new Promise<void>((done) => {
            for (const peer of peers) peer.destroy();
            server.close(() => done());
          }),
      };
    // The holder answers its record on connect.
    const holder = await new Promise<LockHolder | undefined>((resolve) => {
      const peer = createConnection(address);
      let input = '';
      peer.setEncoding('utf8');
      peer.on('data', (chunk: string) => {
        input += chunk;
        const end = input.indexOf('\n');
        if (end < 0) return;
        peer.destroy();
        try {
          resolve(JSON.parse(input.slice(0, end)) as LockHolder);
        } catch {
          resolve(undefined);
        }
      });
      peer.once('error', () => resolve(undefined));
      peer.once('close', () => resolve(undefined));
    });
    if (holder || last)
      return {
        held: false,
        holder: holder ?? { pid: 0, key, since: 'unknown' },
        released: () =>
          new Promise<void>((done) => {
            const peer = createConnection(address);
            // Consume the record so a released holder's connection reaches EOF.
            peer.on('data', () => undefined);
            peer.once('close', () => done());
            peer.once('error', () => done());
          }),
      };
  }
  throw new Error('unreachable');
}

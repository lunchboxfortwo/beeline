/**
 * Shared wait primitives for helper commands and agent tools.
 *
 * A wait ends on (a) the answer to its own request, or (b) the exit of a child
 * it owns. It never waits for a condition: "every agent serving", "agents
 * idle", "a socket or result file appears", "a lock frees up", "stdin ends".
 * A wait also ends on its channel's explicit failure event (`error`,
 * close/EOF, ENOENT, ECONNREFUSED, child `exit`). Nothing here arms a timer,
 * retries or polls; a silent remote peer is bounded only by its
 * transport's own read failure. `helper.waits` in
 * docs/architecture/invariants.json ratchets remaining sites outside these owners.
 */
import { spawn, type ChildProcess, type ExecFileOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createConnection, createServer, type Socket } from 'node:net';

const waitSay = (line: string) => process.stderr.write(`[beeline] ${line}\n`);

let waitMachineReadOutput = false;
export function setMachineReadOutput(machineRead: boolean): void {
  waitMachineReadOutput = machineRead;
}

/**
 * The one switch for wait lines. Every wait prints one stderr line naming the
 * peer it waits on, so a human-facing command is never silent. Only a caller
 * whose stdout/stderr is read by a machine (session tool JSON, hook output,
 * the MCP stdio tool process and what it calls) sets `machineRead: true`, and
 * then no line is written.
 */
interface WaitReport {
  report?: (line: string) => void;
  machineRead?: boolean;
}
function waitCommandReporter(channel: WaitReport): ((line: string) => void) | undefined {
  return waitMachineReadOutput || channel.machineRead ? undefined : (channel.report ?? waitSay);
}

/** A local line-protocol peer: one JSON line out, one JSON line back. */
export interface SocketChannel extends WaitReport {
  socket: string;
  peer: string;
}
/** An HTTP peer; the transport's own read failure ends a silent wait. */
export interface HttpChannel extends WaitReport {
  url: string | URL;
  peer?: string;
  fetch?: typeof fetch;
}

/** The peer answered with `{ error }`: an explicit refusal, not a lost channel. */
export class PeerRefusal extends Error {}

export function ask<T = unknown>(channel: SocketChannel, request: unknown): Promise<T>;
export function ask(channel: HttpChannel, request?: RequestInit): Promise<Response>;
export async function ask(
  channel: SocketChannel | HttpChannel,
  request?: unknown,
): Promise<unknown> {
  const report = waitCommandReporter(channel);
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

export interface OwnedCommand extends WaitReport {
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
  stdin?: 'pipe';
  captureOutput?: boolean;
  /** Byte limit per output stream; exceeding it kills the child group and rejects. */
  maxBuffer?: number;
  onSpawn?: (child: ChildProcess) => void;
  /** Called for each output line as it arrives. By default stdout and stderr lines stream to the terminal. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
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

const waitOwnedChildren = new Set<ChildProcess>();
const waitGroupLeaders = new WeakSet<ChildProcess>();
const waitLinkedWorkers = new WeakSet<ChildProcess>();
let waitOwnerHooks = false;
function waitKillGroup(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(
      waitGroupLeaders.has(child) ? -child.pid : child.pid,
      waitLinkedWorkers.has(child) && child.exitCode === null && child.signalCode === null
        ? 'SIGTERM'
        : 'SIGKILL',
    );
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
export function runOwned(command: OwnedCommand, childProcess = { spawn }): Promise<OwnedResult> {
  // Owned children never outlive their owner: exit and SIGINT/SIGTERM kill each group.
  if (!waitOwnerHooks) {
    waitOwnerHooks = true;
    process.once('exit', () => {
      for (const child of waitOwnedChildren) waitKillGroup(child);
    });
    for (const name of ['SIGINT', 'SIGTERM'] as const) {
      const onSignal = () => {
        for (const child of waitOwnedChildren) waitKillGroup(child);
        process.removeListener(name, onSignal);
        // Keep the default disposition when nobody else handles the signal.
        // Prepended, this runs before other handlers remove themselves, so the
        // count says whether anyone else handles the signal.
        if (!process.listenerCount(name)) process.kill(process.pid, name);
        else process.prependOnceListener(name, onSignal);
      };
      process.prependOnceListener(name, onSignal);
    }
  }
  const report = waitCommandReporter(command);
  const onLine =
    command.onLine ??
    ((line: string) => {
      if (report) process.stderr.write(`${line}\n`);
    });
  return new Promise((resolve, reject) => {
    if (command.signal?.aborted) {
      reject(new Error(`${command.step}: cancelled before start`));
      return;
    }
    report?.(`waiting for ${command.step}`);
    const leader = !command.interactive;
    const env = { ...(command.env ?? process.env) };
    if (command.ownerLink) env.BEELINE_OWNER_LINK = '1';
    else delete env.BEELINE_OWNER_LINK;
    const child = childProcess.spawn(command.file, [...command.args], {
      env,
      ...(command.cwd ? { cwd: command.cwd } : {}),
      detached: leader,
      stdio: command.interactive
        ? 'inherit'
        : [
            command.input === undefined && !command.ownerLink && command.stdin !== 'pipe'
              ? 'ignore'
              : 'pipe',
            'pipe',
            'pipe',
          ],
    });
    if (leader) waitGroupLeaders.add(child);
    if (command.ownerLink) waitLinkedWorkers.add(child);
    waitOwnedChildren.add(child);
    const output = { stdout: '', stderr: '' };
    const bytes = { stdout: 0, stderr: 0 };
    let failure: Error | undefined;
    const pending = { stdout: '', stderr: '' };
    const read = (stream: 'stdout' | 'stderr') => (chunk: string) => {
      if (failure) return;
      bytes[stream] += Buffer.byteLength(chunk);
      if (command.maxBuffer !== undefined && bytes[stream] > command.maxBuffer) {
        failure = new Error(`${command.step}: ${stream} maxBuffer exceeded`);
        waitKillGroup(child);
        return;
      }
      output[stream] += chunk;
      pending[stream] += chunk;
      let end: number;
      while ((end = pending[stream].indexOf('\n')) >= 0) {
        onLine(pending[stream].slice(0, end), stream);
        pending[stream] = pending[stream].slice(end + 1);
      }
    };
    if (command.captureOutput !== false) {
      child.stdout?.setEncoding('utf8').on('data', read('stdout'));
      child.stderr?.setEncoding('utf8').on('data', read('stderr'));
    }
    command.onSpawn?.(child);
    if (command.input !== undefined) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(command.input);
    }
    const abort = () => waitKillGroup(child);
    command.signal?.addEventListener('abort', abort, { once: true });
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const leave = () => {
      waitKillGroup(child);
      command.signal?.removeEventListener('abort', abort);
    };
    child.once('error', (error) => {
      failure = Object.assign(new Error(`${command.step}: ${error.message}`), {
        code: (error as NodeJS.ErrnoException).code,
      });
      leave();
    });
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      leave();
    });
    child.once('close', () => {
      waitOwnedChildren.delete(child);
      for (const stream of ['stdout', 'stderr'] as const)
        if (pending[stream]) onLine(pending[stream], stream);
      if (failure) reject(Object.assign(failure, output));
      else if (command.signal?.aborted)
        reject(new Error(`${command.step}: cancelled; process group killed`));
      else resolve({ ...exited!, ...output });
    });
  });
}

export interface LockHolder {
  pid: number;
  key: string;
  since: string;
  step?: string;
  log?: string;
  generation?: string;
}
export type LockAttempt =
  | { held: true; release: () => Promise<void> }
  | { held: false; holder: LockHolder; released: () => Promise<void>; close: () => void };

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
  about: { step?: string; log?: string; generation?: string } = {},
): Promise<LockAttempt> {
  const address = lockAddress(key);
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
  return new Promise<LockAttempt>((resolve, reject) => {
    const peer = createConnection(address);
    let input = '';
    let answered = false;
    const released = new Promise<void>((done) => peer.once('close', () => done()));
    peer.setEncoding('utf8');
    peer.on('data', (chunk: string) => {
      if (answered) return;
      input += chunk;
      const end = input.indexOf('\n');
      if (end < 0) return;
      try {
        const holder = JSON.parse(input.slice(0, end)) as LockHolder;
        answered = true;
        peer.unref();
        resolve({
          held: false,
          holder,
          close: () => peer.destroy(),
          released: () => {
            peer.ref();
            return released;
          },
        });
      } catch {
        peer.destroy(new Error('Lock holder returned an unreadable record'));
      }
    });
    peer.once('error', reject);
    peer.once('close', () => {
      if (!answered) reject(new Error('Lock holder closed before answering'));
    });
  });
}

export async function runOwnedFile(
  file: string,
  args: readonly string[],
  options: ExecFileOptions = {},
): Promise<OwnedResult> {
  const result = await runOwned({
    step: [file, ...args].join(' '),
    file,
    args,
    cwd: options.cwd === undefined ? undefined : String(options.cwd),
    env: options.env,
    signal: options.signal,
    machineRead: true,
    maxBuffer: options.maxBuffer,
  });
  if (result.code !== 0)
    throw Object.assign(
      new Error(result.stderr.trim() || `${file} exited ${result.code ?? result.signal}`),
      result,
      { code: result.code },
    );
  return result;
}

export function ownedCommandModule(): string {
  const source = `import { spawn } from 'node:child_process';
const waitSay = line => process.stderr.write('[beeline] ' + line + '\\n');
const __name = fn => fn;
let waitMachineReadOutput = false, waitOwnerHooks = false;
const waitOwnedChildren = new Set(), waitGroupLeaders = new WeakSet(), waitLinkedWorkers = new WeakSet();
${waitCommandReporter.toString()}
${waitKillGroup.toString()}
const own = ${runOwned.toString()};
export const runOwned = command => own(command, { spawn });`;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

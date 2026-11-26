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
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';

/**
 * How an `ask` writes its request and reads the answer. `line` (the default)
 * writes one JSON line and answers with the first JSON line back, where
 * `{ error }` is a `PeerRefusal`. The others write the request's exact bytes:
 * `eof` half-closes and answers with every byte before the peer's orderly EOF;
 * `flush` half-closes and settles once the local write is flushed, which says
 * the bytes left this process, not that the peer used them; `read` keeps the
 * socket open and sees every byte so far, returning the answer once it is
 * complete (undefined keeps reading; a throw refuses).
 */
export type AskFraming = 'line' | 'eof' | 'flush' | { read: (input: Buffer) => unknown };

/** A stream peer: a local socket path or a loopback TCP port. */
export interface SocketChannel {
  socket: string | { host: string; port: number };
  peer: string;
  framing?: AskFraming;
}
/** An HTTP peer; the transport's own read failure ends a silent wait. */
export interface HttpChannel {
  url: string | URL;
  fetch?: typeof fetch;
}

/** The peer answered with `{ error }`: an explicit refusal, not a lost channel. */
export class PeerRefusal extends Error {}

/** Opens the stream a socket `ask` or `connect` uses; tests and serialized copies pass their own. */
export interface SocketOpener {
  createConnection: (to: { path: string } | { host: string; port: number }) => Socket;
}

export function ask<T = unknown>(
  channel: SocketChannel,
  request: unknown,
  net?: SocketOpener,
): Promise<T>;
export function ask(channel: HttpChannel, request?: RequestInit): Promise<Response>;
export async function ask(
  channel: SocketChannel | HttpChannel,
  request?: unknown,
  net: SocketOpener = { createConnection },
): Promise<unknown> {
  if ('url' in channel) return (channel.fetch ?? fetch)(channel.url, request as RequestInit);
  const framing = channel.framing ?? 'line';
  return new Promise((resolve, reject) => {
    const socket: Socket = net.createConnection(
      typeof channel.socket === 'string' ? { path: channel.socket } : channel.socket,
    );
    let input = Buffer.alloc(0);
    let settled = false;
    const settle = (error?: Error, answer?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(answer);
    };
    socket.once('connect', () => {
      if (framing === 'line') socket.write(`${JSON.stringify(request)}\n`);
      else if (framing === 'flush')
        socket.end(request as string | Uint8Array, (error?: Error | null) =>
          settle(error ?? undefined, undefined),
        );
      else if (framing === 'eof') socket.end(request as string | Uint8Array);
      else socket.write(request as string | Uint8Array);
    });
    socket.on('data', (chunk: Buffer) => {
      input = Buffer.concat([input, chunk]);
      if (framing === 'eof' || framing === 'flush') return;
      if (framing !== 'line') {
        try {
          const answer = framing.read(input);
          if (answer !== undefined) settle(undefined, answer);
        } catch (error) {
          settle(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      const end = input.indexOf(0x0a);
      if (end < 0) return;
      try {
        const answer = JSON.parse(input.subarray(0, end).toString('utf8')) as { error?: unknown };
        if (answer && typeof answer === 'object' && answer.error)
          settle(new PeerRefusal(`${channel.peer}: ${String(answer.error)}`));
        else settle(undefined, answer);
      } catch {
        settle(new Error(`${channel.peer}: unreadable answer`));
      }
    });
    // An orderly EOF is the whole answer for `eof`; for the others it is a close before answering.
    socket.once('end', () => {
      if (framing === 'eof') settle(undefined, input.toString('utf8'));
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
  /** Names the child in errors. */
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
  /** Byte limit per output stream; exceeding it kills the owned child/group and rejects. */
  maxBuffer?: number;
  onSpawn?: (child: ChildProcess) => void;
  /** Called for each output line as it arrives. By default stdout and stderr lines stream to the terminal. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Capture the child's output without echoing it to stderr by default. */
  machineRead?: boolean;
  /** A terminal program: inherits stdio and stays in the terminal's process group. */
  interactive?: boolean;
  /**
   * `caller`: a piped child that stays in this process's group (or resource
   * scope), so whoever ends this process's group also ends it. Exit and the
   * caller's abort kill only the child itself, not a group. Default `own`.
   */
  group?: 'own' | 'caller';
  /**
   * For a child in the caller's group (`interactive` or `group: 'caller'`):
   * the service manager or terminal signals it itself, so SIGINT/SIGTERM leave
   * it to shut down on its own instead of killing it first. Exit still kills it.
   */
  sharedSignals?: boolean;
  /** The caller left: kill the owned group, or just the child with `group: 'caller'`. */
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
const waitSharedSignals = new WeakSet<ChildProcess>();
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
 * arrive, so the child's own output is the progress. By default, exit kills
 * the owned process group, including grandchildren holding its pipes. With
 * `group: 'caller'` or `interactive`, teardown targets only the child; the
 * surrounding group or resource scope owns descendants. The result settles
 * after the child's output pipes close.
 */
export function runOwned(command: OwnedCommand, childProcess = { spawn }): Promise<OwnedResult> {
  // Exit tears down each owned child/group; sharedSignals delegates SIGINT/SIGTERM.
  if (!waitOwnerHooks) {
    waitOwnerHooks = true;
    process.once('exit', () => {
      for (const child of waitOwnedChildren) waitKillGroup(child);
    });
    for (const name of ['SIGINT', 'SIGTERM'] as const) {
      const onSignal = () => {
        for (const child of waitOwnedChildren)
          if (!waitSharedSignals.has(child)) waitKillGroup(child);
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
  const onLine =
    command.onLine ??
    ((line: string) => {
      if (!command.machineRead) process.stderr.write(`${line}\n`);
    });
  return new Promise((resolve, reject) => {
    if (command.signal?.aborted) {
      reject(new Error(`${command.step}: cancelled before start`));
      return;
    }
    const leader = !command.interactive && command.group !== 'caller';
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
    if (!leader && command.sharedSignals) waitSharedSignals.add(child);
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
          // Close the listening handle before peers see EOF and try to bind it.
          server.close(() => done());
          for (const peer of peers) peer.destroy();
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
      if (!answered)
        reject(
          Object.assign(new Error('Lock holder closed before answering'), { code: 'ECONNRESET' }),
        );
    });
  });
}

/** A short machine-read child: resolves with its output on exit 0, otherwise throws with it. */
export async function runOwnedFile(
  file: string,
  args: readonly string[],
  options: Pick<OwnedCommand, 'cwd' | 'env' | 'input' | 'signal' | 'maxBuffer'> = {},
): Promise<OwnedResult> {
  const result = await runOwned({
    step: [file, ...args].join(' '),
    file,
    args,
    cwd: options.cwd,
    env: options.env,
    input: options.input,
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

/**
 * An event that ends an `answer`. `[source, event]` fails it: with the event's
 * Error argument, or a named error (an outcome callback builds your own). `[source,
 * event, 'answer']` settles it with the event's first argument. An
 * AbortSignal fails it with its reason.
 */
export type AnswerEnd =
  | AbortSignal
  | readonly [
      source: NodeJS.EventEmitter,
      event: string,
      outcome?: 'answer' | ((...args: never[]) => Error),
    ];
export interface Settle<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

/** The event already happened and will not be emitted again. `disconnect` is only for IPC channels. */
function waitLatched(source: object, event: string): boolean {
  const state = source as {
    exitCode?: unknown;
    signalCode?: unknown;
    readableEnded?: unknown;
    closed?: unknown;
    connected?: unknown;
    readyState?: unknown;
  };
  if (event === 'exit')
    return 'signalCode' in state && (state.exitCode !== null || state.signalCode !== null);
  if (event === 'end') return state.readableEnded === true;
  // A WebSocket has no `closed` flag; readyState 3 is CLOSED.
  if (event === 'close') return state.closed === true || state.readyState === 3;
  if (event === 'disconnect') return state.connected === false;
  return false;
}

/**
 * A reply that arrives later on a channel this process already holds: a
 * JSON-RPC id, an IPC message, a parked loop's wake. It settles only through
 * `settle` (called by the caller's own answer handler) or on the first of its
 * `ends`, the channel's explicit failure events, which are registered before
 * `start` runs and checked for having already happened. Every listener is
 * removed when it settles. There is no timer.
 */
export function answer<T = unknown>(
  peer: string,
  ends: readonly AnswerEnd[],
  start?: (settle: Settle<T>) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const undo: Array<() => void> = [];
    let settled = false;
    const finish = (error: Error | undefined, value?: T) => {
      if (settled) return;
      settled = true;
      for (const off of undo.splice(0)) off();
      if (error) reject(error);
      else resolve(value as T);
    };
    for (const end of ends) {
      if (settled) return;
      if (!Array.isArray(end)) {
        const signal = end as AbortSignal;
        const aborted = () =>
          finish(signal.reason instanceof Error ? signal.reason : new Error(`${peer}: cancelled`));
        if (signal.aborted) aborted();
        else {
          signal.addEventListener('abort', aborted, { once: true });
          undo.push(() => signal.removeEventListener('abort', aborted));
        }
        continue;
      }
      const [source, event, outcome] = end as Exclude<AnswerEnd, AbortSignal>;
      const ended = (...args: unknown[]) => {
        if (outcome === 'answer') finish(undefined, args[0] as T);
        else if (outcome) finish((outcome as (...values: unknown[]) => Error)(...args));
        else if (args[0] instanceof Error) finish(args[0]);
        else
          finish(
            Object.assign(
              new Error(
                event === 'close'
                  ? `${peer} closed before answering`
                  : `${peer}: ${event} before answering`,
              ),
              { code: event === 'close' ? 'ECONNRESET' : undefined },
            ),
          );
      };
      source.on(event, ended);
      undo.push(() => source.removeListener(event, ended));
      if (waitLatched(source, event)) ended();
    }
    if (settled) return;
    try {
      start?.({ resolve: (value) => finish(undefined, value), reject: (error) => finish(error) });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * A teardown subscription, not a wait: `handler` runs once on the first of
 * `events` (or at once if one already happened), and every sibling listener is
 * removed. Returns the unsubscribe. Listing `error` handles that error.
 */
export function onEnd(
  source: NodeJS.EventEmitter,
  events: readonly string[],
  handler: (event: string, ...args: unknown[]) => void,
): () => void {
  let done = false;
  const listeners = events.map(
    (event) =>
      [
        event,
        (...args: unknown[]) => {
          if (done) return;
          off();
          handler(event, ...args);
        },
      ] as const,
  );
  const off = () => {
    done = true;
    for (const [event, listener] of listeners) source.removeListener(event, listener);
  };
  for (const [event, listener] of listeners) source.on(event, listener);
  const latched = events.find((event) => waitLatched(source, event));
  if (latched !== undefined) listeners[events.indexOf(latched)]![1]();
  return off;
}

export interface Listening {
  /**
   * Stop admitting connections, end every connection still open once its
   * pending writes flush (a peer with an unfinished request does not hold the
   * close), and resolve on the server's close. Answer in-flight requests first.
   */
  close: () => Promise<void>;
}

/** Bind a server: settles on `listening` or the bind's `error` (say EADDRINUSE). */
export async function listen(
  server: Server,
  address: string | { port: number; host: string },
): Promise<Listening> {
  const peers = new Set<Socket>();
  server.on('connection', (peer: Socket) => {
    peers.add(peer);
    // A reset peer is a closed connection, never an unhandled error in the server's process.
    peer.on('error', () => undefined);
    onEnd(peer, ['close'], () => peers.delete(peer));
  });
  const name = typeof address === 'string' ? address : `${address.host}:${address.port}`;
  await answer(
    `listener ${name}`,
    [
      [server, 'listening', 'answer'],
      [server, 'error'],
    ],
    () => {
      server.listen(address);
    },
  );
  let closed: Promise<void> | undefined;
  return {
    close: () =>
      (closed ??= answer<void>(`listener ${name}`, [[server, 'close', 'answer']], () => {
        server.close();
        for (const peer of peers) peer.destroySoon();
      })),
  };
}

/**
 * Open a stream socket for a relay or probe: settles on `connect`, or on the
 * attempt's `error`, `close` or the caller's abort (the socket is destroyed).
 * After it settles the caller owns the socket and its later errors.
 */
export async function connect(
  address: string | { host: string; port: number },
  options: { peer: string; signal?: AbortSignal },
  net: SocketOpener = { createConnection },
): Promise<Socket> {
  const socket = net.createConnection(typeof address === 'string' ? { path: address } : address);
  // A synchronous connect failure can latch `closed` before Node emits its
  // queued error. Keep that error handled until close even if answer settles
  // from the latched state and removes its own listeners first.
  const ignoreError = () => undefined;
  socket.on('error', ignoreError);
  const removeGuard = () => {
    socket.removeListener('error', ignoreError);
    socket.removeListener('close', removeGuard);
  };
  socket.on('close', removeGuard);
  try {
    if (socket.errored) throw socket.errored;
    await answer(options.peer, [
      [socket, 'connect', 'answer'],
      [socket, 'error'],
      [socket, 'close'],
      ...(options.signal ? [options.signal] : []),
    ]);
  } catch (error) {
    socket.destroy();
    throw error;
  }
  removeGuard();
  return socket;
}

/**
 * A filesystem push subscription, never awaited. `onChange` gets the changed
 * name, or null when the platform did not say which (treat it as "anything
 * changed"); it may only start work that has its own ending event. The
 * watcher's `error` closes it and goes to `onError`, which owns the
 * consequence. Returns the stop.
 */
export function watchChanges(
  path: string,
  onChange: (name: string | null) => void,
  options: { recursive?: boolean; onError: (error: Error) => void },
  fs = { watch },
): () => void {
  const watcher = fs.watch(path, { recursive: options.recursive ?? false }, (_event, name) =>
    onChange(name === null ? null : String(name)),
  );
  watcher.on('error', (error: Error) => {
    watcher.close();
    options.onError(error);
  });
  return () => watcher.close();
}

export interface DetachedCommand {
  file: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** stdin, stdout, stderr: `ignore` or an open file descriptor. Default all `ignore`. */
  stdio?: readonly ['ignore' | number, 'ignore' | number, 'ignore' | number];
  /** Keep an IPC channel for a startup handshake; `release()` drops it. */
  ipc?: boolean;
}
export type DetachedEnd = { code: number | null; signal: NodeJS.Signals | null } | { error: Error };
export interface Detached {
  child: ChildProcess;
  /** The child's exit or spawn error, while this process still holds it. Never rejects. */
  exited: Promise<DetachedEnd>;
  /** Stop holding the child: drop its IPC channel and let this process exit without it. */
  release: () => void;
}

/**
 * The one intentional detach: a process that must outlive its launcher (a
 * session bridge, a background finisher). It runs in its own session with no
 * owner hooks. Without `ipc` it is released at once.
 */
export function launchDetached(command: DetachedCommand): Detached {
  const stdio = command.stdio ?? ['ignore', 'ignore', 'ignore'];
  const child = spawn(command.file, [...command.args], {
    detached: true,
    env: command.env ?? process.env,
    stdio: command.ipc ? [...stdio, 'ipc'] : [...stdio],
  });
  const exited = answer<DetachedEnd>(command.file, [], (settle) => {
    child.once('exit', (code, signal) => settle.resolve({ code, signal }));
    child.once('error', (error) => settle.resolve({ error }));
  });
  const release = () => {
    if (child.connected) child.disconnect();
    child.unref();
  };
  if (!command.ipc) release();
  return { child, exited, release };
}

/** `runOwned`, `ask`, `answer` and `watchChanges` as a standalone module for generated scripts and harness extensions. */
export function ownedCommandModule(): string {
  const source = `import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { createConnection } from 'node:net';
const __name = fn => fn;
let waitOwnerHooks = false;
const waitOwnedChildren = new Set(), waitGroupLeaders = new WeakSet(), waitLinkedWorkers = new WeakSet(), waitSharedSignals = new WeakSet();
${waitKillGroup.toString()}
${waitLatched.toString()}
const PeerRefusal = ${PeerRefusal.toString()};
const own = ${runOwned.toString()};
const waitAsk = ${ask.toString()};
const waitWatch = ${watchChanges.toString()};
export const answer = ${answer.toString()};
export const runOwned = command => own(command, { spawn });
export const ask = (channel, request) => waitAsk(channel, request, { createConnection });
export const watchChanges = (path, onChange, options) => waitWatch(path, onChange, options, { watch });`;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

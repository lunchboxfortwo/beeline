/**
 * Beeline-owned, connect-only replacement for Squire's own relay
 * (`npx @trusty-squire/mcp server`, the installed package's `dist/relay.js`).
 *
 * `squireBrokerSocketReady` (`squire-host.ts`) only gates the MOMENT a façade
 * starts. Once running, Squire's own relay calls its internal
 * `ensureSharedMcp()` on every (re)connect — including a mid-session drop —
 * and `ensureSharedMcp` spawns a detached broker itself whenever its
 * `managedBrokerUnitIsLive()` probe (`systemctl --user show ...`) doesn't see
 * the host unit as live. That is not merely racy during a restart-loop: it
 * always fails closed to "spawn" from inside a bwrap-sandboxed agent
 * session, because the session bus it needs is unreachable there. Verified
 * on this host:
 *
 *   $ bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --unshare-pid \
 *       env XDG_RUNTIME_DIR=/run/user/1000 systemctl --user show \
 *       --type=service -p Id -p ActiveState trusty-squire-broker.service
 *   Failed to connect to bus: No data available
 *
 * So relaying through Squire's own `server` subcommand can never be made
 * connect-only from the outside — the unsafe fallback lives inside code
 * Beeline does not own and the installed package exposes no env/flag to
 * disable it (checked npm dist-tag `latest` at 1.1.21 through the newest
 * `1.1.22-rc.1` prerelease; `dist/bot/broker/discovery.js`'s
 * `connectOrLaunchBroker`/`ensureSharedMcp` take no such override, and only
 * `.`/`./browser` are public `exports`). This module replaces that
 * subcommand entirely for every agent-launched façade: it IS the façade's
 * MCP transport for the life of the process, speaking exactly the protocol
 * the broker's shared MCP socket expects (`bot/broker/mcp-socket.js`
 * `listenSharedMcp`: one identity line, then newline-delimited JSON-RPC) and
 * retaining framing and pending-request bookkeeping without timed retries.
 * An established connection loss admits an immediate replacement. If the
 * broker is still restarting, publication of its Unix socket admits the next
 * attempt, without a retry timer. Initialization and one tool inventory read
 * reconcile each replacement. Requests may wait during a connect attempt or
 * initialization replay; with no socket and no attempt, they fail as not-sent.
 * Failed attempts also end queued requests as not-sent; sent requests lose
 * their outcome on disconnect and are never replayed. No path launches a broker.
 */
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { basename, dirname } from 'node:path';
import { SQUIRE_BROKER_UNAVAILABLE, TRUSTY_SQUIRE_BROKER_UNIT_NAME } from './squire-host.js';
import { answer, connect as connectStream, onEnd, watchChanges } from './wait.js';

type JsonRpcFrame = { id?: string | number; method?: string; error?: unknown };

function frameLines(
  chunk: Buffer<ArrayBufferLike>,
  buffered: Buffer<ArrayBufferLike>,
  receive: (line: string) => void,
): Buffer<ArrayBufferLike> {
  let input = Buffer.concat([buffered, chunk]);
  for (;;) {
    const end = input.indexOf(10);
    if (end < 0) return input;
    receive(input.subarray(0, end).toString('utf8'));
    input = input.subarray(end + 1);
  }
}

export type SquireBrokerLinkOptions = {
  readonly agentId: string;
  readonly socketPath: string;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly logError?: (message: string) => void;
  /** Injectable for tests: opens the (not yet connected) socket; defaults to a real Unix socket. */
  readonly connect?: (path: string) => Socket;
  /** Injectable for tests; defaults to real process signals. */
  readonly onShutdownSignal?: (handler: () => void) => void;
};

/** Keep the agent's stdio MCP connection alive across broker restarts, connect-only. */
export async function runSquireBrokerLink(
  options: SquireBrokerLinkOptions,
): Promise<{ ok: boolean }> {
  const {
    agentId,
    socketPath,
    input = process.stdin,
    output = process.stdout,
    logError = (message: string) => process.stderr.write(`${message}\n`),
    connect,
    onShutdownSignal = (handler: () => void) => {
      process.once('SIGHUP', handler);
      process.once('SIGTERM', handler);
      process.once('SIGINT', handler);
    },
  } = options;

  let socket: Socket | undefined;
  // The one connect attempt in flight; a late peer from an abandoned one is destroyed.
  let attempt: AbortController | undefined;
  let stopWatching: (() => void) | undefined;
  let socketChanged = false;
  let inBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let outBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let initializeLine: string | undefined;
  let initializedLine: string | undefined;
  let replayId: string | undefined;
  let inventoryId: string | undefined;
  let stopped = false;
  let gaveUp = false;
  let connectedOnce = false;
  let ready = false;
  const pending = new Map<string, string | number>();
  const queued: string[] = [];

  let resolveDone!: (ok: boolean) => void;
  // The link's whole life: it ends on input EOF, a shutdown signal, or giving up.
  const done = answer<boolean>('Trusty Squire broker link', [], ({ resolve }) => {
    resolveDone = resolve;
  });

  const failResponse = (
    id: string | number,
    outcome: 'unknown' | 'not-sent',
    reconnect: 'in-progress' | 'failed' = 'failed',
  ) =>
    `${JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: 'Trusty Squire broker connection lost',
        data: { outcome, reconnect },
      },
    })}\n`;

  const flush = () => {
    while (queued.length) {
      const line = queued.shift()!;
      const frame = JSON.parse(line) as JsonRpcFrame;
      if (frame.id !== undefined && frame.method) pending.set(JSON.stringify(frame.id), frame.id);
      socket?.write(`${line}\n`);
    }
  };

  function stop(ok: boolean): void {
    if (stopped) return;
    stopped = true;
    stopWatching?.();
    attempt?.abort();
    socket?.destroy();
    resolveDone(ok);
  }

  /** Requests that arrived during a connect attempt that failed were never sent. */
  const failQueued = (reconnect: 'in-progress' | 'failed') => {
    for (const line of queued.splice(0)) {
      const frame = JSON.parse(line) as JsonRpcFrame;
      if (frame.id !== undefined && frame.method)
        output.write(failResponse(frame.id, 'not-sent', reconnect));
    }
  };

  const giveUp = () => {
    if (gaveUp) return;
    gaveUp = true;
    logError(
      `${SQUIRE_BROKER_UNAVAILABLE}: ${TRUSTY_SQUIRE_BROKER_UNIT_NAME} is not reachable at ${socketPath}`,
    );
    for (const id of pending.values()) output.write(failResponse(id, 'unknown'));
    pending.clear();
    // A request that arrived before any successful connect was never
    // flushed, so it was never added to `pending` either — without this it
    // would hang silently instead of failing.
    for (const line of queued.splice(0)) {
      const frame = JSON.parse(line) as JsonRpcFrame;
      if (frame.id !== undefined && frame.method) output.write(failResponse(frame.id, 'not-sent'));
    }
    stop(false);
  };

  /** A connected peer: greet it, then replay initialization or flush what waited. */
  const attach = (peer: Socket) => {
    socket = peer;
    outBuffer = Buffer.alloc(0);
    peer.on('error', (error) => {
      if (!stopped)
        logError(`squire relay: ${error instanceof Error ? error.message : String(error)}`);
    });
    peer.write(`${agentId}\n`);
    if (connectedOnce && initializeLine) {
      replayId = `beeline-squire-relay-${randomUUID()}`;
      const frame = JSON.parse(initializeLine) as Record<string, unknown>;
      peer.write(`${JSON.stringify({ ...frame, id: replayId })}\n`);
    } else {
      ready = true;
      flush();
    }
    connectedOnce = true;
    peer.on('data', (chunk: Buffer) => {
      if (socket !== peer || stopped) return;
      outBuffer = frameLines(chunk, outBuffer, (line) => {
        const frame = JSON.parse(line) as JsonRpcFrame;
        // A server notification has no id; without the replay check it would
        // match an unset replayId and be dropped (approval_decided included).
        if (replayId !== undefined && frame.id === replayId) {
          replayId = undefined;
          if (frame.error) {
            giveUp();
            return;
          }
          if (initializedLine) peer.write(`${initializedLine}\n`);
          inventoryId = `beeline-squire-inventory-${randomUUID()}`;
          peer.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: inventoryId, method: 'tools/list', params: {} })}\n`,
          );
          return;
        }
        if (inventoryId !== undefined && frame.id === inventoryId) {
          inventoryId = undefined;
          if (frame.error) {
            giveUp();
            return;
          }
          ready = true;
          output.write(
            `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`,
          );
          flush();
          return;
        }
        if (frame.id !== undefined && !frame.method) pending.delete(JSON.stringify(frame.id));
        output.write(`${line}\n`);
      });
    });
    onEnd(peer, ['close'], () => {
      if (socket !== peer || stopped) return;
      socket = undefined;
      ready = false;
      replayId = undefined;
      inventoryId = undefined;
      for (const id of pending.values()) output.write(failResponse(id, 'unknown', 'in-progress'));
      pending.clear();
      // An established connection's loss admits one immediate replacement.
      doConnect();
    });
  };

  const doConnect = () => {
    if (stopped || attempt || socket) return;
    socketChanged = false;
    const controller = new AbortController();
    attempt = controller;
    connectStream(
      socketPath,
      { peer: 'Trusty Squire broker', signal: controller.signal },
      connect ? { createConnection: () => connect(socketPath) } : undefined,
    ).then(
      (peer) => {
        if (attempt !== controller || stopped) {
          peer.destroy();
          return;
        }
        attempt = undefined;
        attach(peer);
      },
      (error: unknown) => {
        if (attempt !== controller) return;
        attempt = undefined;
        if (stopped) return;
        logError(`squire relay: ${error instanceof Error ? error.message : String(error)}`);
        if (!connectedOnce) {
          giveUp();
          return;
        }
        // The broker is restarting: nothing waits for it. What arrived during
        // this attempt was never sent; the socket's next publication reconnects.
        failQueued('in-progress');
        if (socketChanged) doConnect();
      },
    );
  };

  input.on('data', (chunk: Buffer) => {
    inBuffer = frameLines(chunk, inBuffer, (line) => {
      const frame = JSON.parse(line) as JsonRpcFrame;
      if (gaveUp) {
        // Given up already stops the process in production, but a caller
        // that keeps writing after that (as the injected-stream tests do)
        // gets a clean, immediate failure rather than silence.
        if (frame.id !== undefined && frame.method)
          output.write(failResponse(frame.id, 'not-sent'));
        return;
      }
      if (frame.method === 'initialize') initializeLine = line;
      if (frame.method === 'notifications/initialized') initializedLine = line;
      // With no broker socket and no attempt in flight, a request is answered
      // at once as never sent: it never waits for the broker to come back.
      if (connectedOnce && !socket && !attempt) {
        if (frame.id !== undefined && frame.method)
          output.write(failResponse(frame.id, 'not-sent', 'in-progress'));
        return;
      }
      queued.push(line);
      if (ready) flush();
    });
  });

  const close = () => stop(!gaveUp);
  onEnd(input, ['end', 'close'], close);
  onShutdownSignal(close);

  // Watch the directory, not the socket inode that a restart unlinks. Start
  // before connecting so publication during a failing attempt is not lost.
  // The publication only starts a reconnect; no request waits for it.
  try {
    stopWatching = watchChanges(
      dirname(socketPath),
      (filename) => {
        if ((filename !== null && filename !== basename(socketPath)) || stopped) return;
        socketChanged = true;
        if (connectedOnce && !socket) doConnect();
      },
      { onError: giveUp },
    );
    doConnect();
  } catch {
    giveUp();
  }
  const ok = await done;
  return { ok };
}

// The machine's one session bridge: for every joined session it waits on Beeline for tags and wakes, and hands each
// to the session's app by the fastest way the app has. It needs no public address: it only calls out to Beeline.
import { sessionAgentBehavior } from '../agent-command.js';
import { agentMessageText, replyNeeded, type MessageAsk } from '@beeline/api-contract/daemon';
import type { DaemonAttachment } from '@beeline/api-contract/daemon';
import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { preparePrivateSocketDirectory } from '../local-socket.js';
import { bridgeOwnerKey, bridgeSocketPath } from './bridge-socket.js';
import {
  answer,
  ask,
  listen,
  PeerRefusal,
  tryLock,
  watchChanges,
  type LockAttempt,
} from '../wait.js';
import { externalAgentRules } from '@beeline/api-contract/phone';
import { accessToken, callTool, memberStream } from './beeline-api.js';
import { memberStreamFrame } from './stream-frame.js';
import { createHash } from 'node:crypto';
import { codexQueue, turnRunning } from './codex.js';
import { postToClaude } from './claude.js';
import { hasClaudeMcp } from './claude-mcp.js';
import {
  findSession,
  liveSessions,
  machineSources,
  type LiveSession,
  type Sources,
} from './sessions.js';
import { bundleDigest } from './bridge-launch.js';
import {
  pidAlive,
  queueInbox,
  queueInboxOnce,
  readState,
  takeInbox,
  updateState,
  type JoinedSession,
  hasLocalDelivery,
} from './store.js';

export interface Mention {
  memberId?: string;
  replyRule?: string;
  id: string;
  room_id: string;
  room_name?: string;
  author_handle?: string | null;
  author_name?: string | null;
  text: string;
  institutionalContext?: string;
  attachments?: readonly DaemonAttachment[];
}
export interface Wake {
  id: string;
  address: string;
  from?: { agent: string; place: string };
  fromName?: string | null;
  placeName?: string | null;
  reason?: string;
  kind?: string;
  ask?: MessageAsk;
  text?: string;
  institutionalContext?: string;
  attachments?: readonly DaemonAttachment[];
  createdAt: string;
  next?: string;
  receipt?: { generation: string; nonce: string; conversation: string };
}

/** How the session runs Beeline commands: the stable bundle copy and this member's id. */
export interface Runner {
  node: string;
  bundle: string;
  /** A new npx entry to validate before replacing the stable command path. */
  candidate?: string;
}

function command(runner: Runner, joined: JoinedSession, args: string): string {
  const q = (v: string) =>
    /^[A-Za-z0-9_./:@=-]+$/.test(v) ? v : `"${v.replace(/(["\\$`])/g, '\\$1')}"`;
  return `${q(runner.node)} ${q(runner.bundle)} session ${args} --as ${q(joined.key)}`;
}

export function renderAttachments(attachments: readonly DaemonAttachment[] = []): string[] {
  return attachments.map((attachment) => `Attachment: ${JSON.stringify(attachment)}`);
}

/** What the session reads: the one message format, then its memory context. */
export function renderMention(m: Mention): string {
  return [
    agentMessageText({
      from: m.author_name ?? (m.author_handle ? `@${m.author_handle}` : 'Someone'),
      place: m.room_name ?? m.room_id,
      id: m.id,
      replyNeeded: true,
      text: m.text,
      attachments: m.attachments?.map((file) => JSON.stringify(file)),
    }),
    ...(m.institutionalContext ? [m.institutionalContext] : []),
  ].join('\n');
}

/**
 * Who the session is on Beeline and the rules it works by, spelled with its own commands
 * (`EXTERNAL_AGENT_RULES`, the same rules the connector serves as MCP instructions).
 */
export function renderRules(joined: JoinedSession, runner: Runner): string {
  return [
    `Beeline: you are @${joined.handle ?? joined.name}, a member of your person's Beeline chats. How to work there:`,
    externalAgentRules('session', command(runner, joined, `tool <name> '<json arguments>'`)),
  ].join('\n');
}

/** A delivered wake carries its message id and immutable origin tuple. */
export function renderWake(w: Wake, joined: JoinedSession, runner: Runner): string {
  if (w.kind === 'join_probe' && w.receipt)
    return [
      'Beeline join delivery check: this probe arrived through your selected receiver. It grants no work authority.',
      'In this exact host conversation, run the receipt command once. Do not post a chat message:',
      `  ${command(runner, joined, `tool confirm_delivery '${JSON.stringify(w.receipt).replace(/'/g, "'\\''")}'`)}`,
    ].join('\n');
  return [
    agentMessageText({
      from: w.fromName ?? w.from?.agent ?? 'Beeline',
      place: w.placeName ?? w.from?.place ?? w.address,
      id: w.id,
      replyNeeded: replyNeeded(w.reason, w.ask),
      text: w.text ?? '',
      attachments: w.attachments?.map((file) => JSON.stringify(file)),
    }),
    ...(w.institutionalContext ? [w.institutionalContext] : []),
  ].join('\n');
}

/** A real handoff error is explicit; a quiet session never becomes a timed failure. */
export async function recordDeliveryFailure(
  dir: string,
  joined: JoinedSession,
  reason: string,
): Promise<void> {
  try {
    if (joined.deliveryGeneration)
      await callTool(joined, await accessToken(dir, joined.key), 'delivery_failed', {
        generation: joined.deliveryGeneration,
        reason,
      });
  } catch {
    /* The durable inbox stays owed if the server is unreachable. */
  }
}

export interface DeliverDeps {
  postClaude: typeof postToClaude;
  queueCodex: (bin: string, threadId: string, text: string) => Promise<void>;
  codexBusy: (rollout: string) => boolean | undefined;
}

const realDeps: DeliverDeps = {
  postClaude: postToClaude,
  queueCodex: (bin, thread, text) => codexQueue(thread, text, bin),
  codexBusy: (rollout) => turnRunning(rollout),
};

/**
 * Hands waiting text to a joined session. Claude Code takes it in its inbox socket and Codex through `codex queue`;
 * both start a turn when idle. Every other app takes it from the inbox at its next hook or plugin poll, so it stays
 * there. Returns how it went, for the log.
 */
const failedLocalHandoffs = new Map<string, string>();
export async function deliver(
  dir: string,
  joined: JoinedSession,
  session: LiveSession | undefined,
  deps: DeliverDeps = realDeps,
): Promise<string> {
  if (!sessionAgentBehavior(joined.agent).delivery) return 'waiting for the app to collect it';
  if (!session) return 'waiting for the session to open';
  if (joined.agent === 'claude-code' && hasClaudeMcp(dir, session.pid))
    return 'waiting for the in-session MCP server';
  const binding = `${session.sessionId}:${session.pid ?? ''}:${joined.deliveryGeneration ?? ''}`;
  if (failedLocalHandoffs.get(joined.key) === binding)
    return 'waiting for host recovery after failed handoff';
  const text = takeInbox(dir, joined.key);
  if (!text) return 'nothing waiting';
  try {
    if (joined.agent === 'claude-code') {
      if (!session.socket) throw new Error('this Claude Code session has no inbox');
      await deps.postClaude({ path: session.socket }, text);
      return 'pushed into the Claude Code session';
    }
    // Read before queueing: an idle thread starts its turn the moment it takes the message.
    const busy = session.rollout ? deps.codexBusy(session.rollout) : undefined;
    await deps.queueCodex(joined.agentBin ?? 'codex', session.sessionId, text);
    return busy ? 'queued for after the current Codex turn' : 'queued into the idle Codex thread';
  } catch (error) {
    failedLocalHandoffs.set(joined.key, binding);
    queueInbox(dir, joined.key, text);
    await recordDeliveryFailure(dir, joined, 'local_handoff_failed');
    return `left waiting: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Persistence precedes cursor advancement. The same delivery after a lost
 * checkpoint or process crash joins its durable inbox identity. */
export async function acceptMemberDelivery(
  dir: string,
  key: string,
  runner: Runner,
  raw: unknown,
): Promise<number> {
  const frame = memberStreamFrame(raw);
  if (frame.type === 'ended') return 0;
  return updateState(dir, (state) => {
    const joined = state.sessions.find((session) => session.key === key);
    if (!joined) return 0;
    let queued = 0;
    if (frame.type === 'delivery') {
      const proof = frame.wakes.find((wake) => wake.kind === 'join_probe' && wake.receipt)?.receipt;
      if (proof) {
        joined.deliveryGeneration = proof.generation;
        joined.deliveryMechanism = 'local';
      }
      const parts = [
        ...frame.mentions.map((mention) => renderMention(mention)),
        ...frame.wakes
          .filter((wake) => !joined.deliveredWakes.includes(wake.id))
          .map((wake) => renderWake(wake, joined, runner)),
      ];
      if (parts.length && queueInboxOnce(dir, key, frame.deliveryId, parts.join('\n\n')))
        queued = parts.length;
      joined.deliveredWakes = [
        ...new Set([...joined.deliveredWakes, ...frame.wakes.map((wake) => wake.id)]),
      ];
    } else {
      const old = joined.streamCursor;
      if (old?.epoch === frame.cursor.epoch && old.through > frame.cursor.through)
        throw new Error('Beeline stream cursor moved backwards');
      joined.streamCursor = frame.cursor;
    }
    if (BigInt(frame.mentionCursor) > BigInt(joined.cursor)) joined.cursor = frame.mentionCursor;
    return queued;
  });
}

function log(dir: string, line: string): void {
  try {
    writeFileSync(join(dir, 'bridge.log'), `${new Date().toISOString()} ${line}\n`, {
      flag: 'a',
      mode: 0o600,
    });
  } catch {
    /* best effort */
  }
}

/** Finds each joined session's live conversation, records it, and hands over what waits. */
export async function flush(
  dir: string,
  sources: Sources,
  deps: DeliverDeps = realDeps,
): Promise<void> {
  const state = readState(dir);
  const live = liveSessions(sources);
  for (const joined of state.sessions) {
    const session = findSession(joined, live, state.sessions);
    if (
      session &&
      (session.sessionId !== joined.sessionId ||
        session.pid !== joined.pid ||
        (hasLocalDelivery(joined) && !joined.deliveryGeneration))
    ) {
      if (
        hasLocalDelivery(joined) &&
        (!joined.deliveryGeneration || session.sessionId !== joined.sessionId)
      ) {
        const binding = (await callTool(
          joined,
          await accessToken(dir, joined.key),
          'setup_delivery',
          {
            mechanism: 'local',
            host: joined.agent,
            surface: joined.agent === 'antigravity' ? 'app' : 'local_session',
            conversation: session.sessionId,
            installed: true,
          },
        )) as { delivery: { generation: string } };
        joined.deliveryGeneration = binding.delivery.generation;
        joined.deliveryMechanism = 'local';
      }
      await updateState(dir, (s) => {
        const current = s.sessions.find((x) => x.key === joined.key);
        if (current) {
          current.sessionId = session.sessionId;
          current.pid = session.pid;
          current.deliveryGeneration = joined.deliveryGeneration;
          current.deliveryMechanism = joined.deliveryMechanism;
        }
      });
      log(dir, `${joined.key}: in session ${session.sessionId}`);
    }
    const outcome = await deliver(dir, joined, session, deps);
    if (outcome !== 'nothing waiting' && !outcome.startsWith('waiting'))
      log(dir, `${joined.key}: ${outcome}`);
  }
}

/**
 * Tool calls for joined sessions, over a private socket. A sandboxed app (Codex's default) blocks the network but
 * not this socket, so its replies go out without asking the person to approve network access each time.
 */
async function serveTools(dir: string, path: string, sessionsChanged: () => void) {
  if (dirname(path) !== dir) await preparePrivateSocketDirectory(path);
  rmSync(path, { force: true });
  const requests = new Set<Promise<void>>();
  let closing = false;
  const server = createServer((connection) => {
    if (closing) {
      connection.destroy();
      return;
    }
    let buffer = '',
      taken = false;
    connection.setEncoding('utf8');
    connection.on('data', (chunk) => {
      if (closing) return;
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0 || taken) return;
      taken = true;
      const request = (async () => {
        let answer: object;
        try {
          const request = JSON.parse(buffer.slice(0, end)) as {
            type?: string;
            key: string;
            name: string;
            args: Record<string, unknown>;
          };
          if (request.type === 'sessions-changed') {
            sessionsChanged();
            answer = { ok: true };
          } else {
            const joined = readState(dir).sessions.find((s) => s.key === request.key);
            if (!joined) throw new Error('This session has not joined Beeline');
            const token = await accessToken(dir, joined.key);
            if (token !== joined.accessToken) sessionsChanged();
            answer = {
              ok: true,
              data: await callTool(joined, token, request.name, request.args ?? {}),
            };
          }
        } catch (error) {
          answer = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        connection.end(JSON.stringify(answer) + '\n');
      })();
      requests.add(request);
      void request.then(() => requests.delete(request), () => requests.delete(request));
    });
  });
  const listening = await listen(server, path);
  chmodSync(path, 0o600);
  server.unref();
  let closed: Promise<void> | undefined;
  return {
    close: () => {
      closing = true;
      return (closed ??= (async () => {
        await Promise.allSettled(requests);
        await listening.close();
      })());
    },
  };
}

/** Calls a tool through the bridge; undefined when no bridge answers, so the caller goes direct. */
export function toolViaBridge(
  dir: string,
  key: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; data?: unknown; error?: string } | undefined> {
  return bridgeRequest(dir, { key, name, args });
}

/** State is durable storage; its writer tells the serving bridge to read it. */
export async function notifyBridgeSessions(dir: string): Promise<void> {
  const answer = await bridgeRequest(dir, { type: 'sessions-changed' });
  if (!answer?.ok) throw new Error(answer?.error ?? 'Beeline tool result is awaiting confirmation');
}

const BRIDGE_PEER = 'Beeline bridge';
/** Connect failures: the request never reached a bridge. */
const UNSENT = new Set(['ENOENT', 'ECONNREFUSED', 'EACCES', 'EPERM', 'ENOTSOCK']);

/** One request to the bridge; it settles on the bridge's answer or the socket's explicit failure. */
async function bridgeRequest(
  dir: string,
  request: object,
): Promise<{ ok: boolean; data?: unknown; error?: string } | undefined> {
  try {
    return await ask<{ ok: boolean; data?: unknown; error?: string }>(
      { socket: bridgeSocketPath(dir), peer: BRIDGE_PEER },
      request,
    );
  } catch (error) {
    if (error instanceof PeerRefusal)
      return { ok: false, error: error.message.slice(BRIDGE_PEER.length + 2) };
    if (UNSENT.has(String((error as NodeJS.ErrnoException).code))) return undefined;
    return { ok: false, error: 'Beeline tool result is awaiting confirmation' };
  }
}

/** Runs until no session is joined. One per machine user: a second exits at once. */
export async function runBridge(dir: string, runner: Runner): Promise<void> {
  const staged = process.env.BEELINE_SESSION_BRIDGE_STAGING === '1' && Boolean(process.send);
  let activated = !staged,
    stopping = false;
  let activate!: () => void, begin!: () => void;
  // The launcher's `activate`; losing the launcher before activation exits (below).
  const handoff = staged
    ? answer<void>('Beeline bridge launcher', [], ({ resolve }) => {
        begin = () => resolve();
      })
    : Promise.resolve();
  // Received frames wait here until this candidate owns delivery.
  const activation = staged
    ? answer<void>('Beeline bridge activation', [], ({ resolve }) => {
        activate = () => resolve();
      })
    : Promise.resolve();
  if (staged) {
    process.once('message', (message) => {
      if (message === 'activate') begin();
    });
    process.once('disconnect', () => {
      if (!activated) process.exit(1);
    });
  }
  const digest = bundleDigest({ ...runner, bundle: runner.candidate ?? runner.bundle });
  const pidFile = join(dir, 'bridge.pid');
  const claim = (): boolean => {
    try {
      const fd = openSync(pidFile, 'wx', 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
    } catch {
      const holder = Number(readFileSync(pidFile, 'utf8'));
      if (holder && holder !== process.pid && pidAlive(holder)) return false;
      writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
    }
    return true;
  };
  if (!staged && !claim()) return;
  let owner: Extract<LockAttempt, { held: true }> | undefined;
  const own = async () => {
    const lock = await tryLock(bridgeOwnerKey(dir), {
      step: 'Beeline session bridge',
      log: join(dir, 'bridge.log'),
    });
    if (!lock.held) {
      lock.close();
      throw new Error(`Beeline bridge owner changed: pid ${lock.holder.pid || 'unknown'} serves`);
    }
    owner = lock;
  };
  if (!staged) await own();
  const socket = bridgeSocketPath(dir, staged ? process.pid : undefined);
  let localDirty = true,
    wake: (() => void) | undefined;
  const changed = () => {
    localDirty = true;
    wake?.();
  };
  const tools = await serveTools(dir, socket, changed).catch((error) => {
    // A refused bind happens before the startup cleanup block. Release the
    // launcher channel so its readiness wait observes this candidate's exit.
    if (staged && process.connected) process.disconnect();
    throw error;
  });
  const sources = machineSources(dir);
  type Stream = { fingerprint: string; controller: AbortController; recovered: boolean };
  const streams = new Map<string, Stream>();
  // A change without a name is any change. A failed watcher would leave this
  // bridge deaf, so it stops and the next session start launches a new one.
  const stopWatching = watchChanges(
    dir,
    (path) => {
      // A new subdirectory can be reported by its own name only.
      if (path === null || /^(?:hooks|inbox|deliveries|claude-mcp)(?:\/|$)/.test(path)) changed();
    },
    {
      recursive: true,
      onError: (error) => {
        log(dir, `local watcher failed: ${error.message}`);
        stop();
      },
    },
  );
  const stop = () => {
    if (!activated) process.exit(0);
    stopping = true;
    for (const stream of streams.values()) stream.controller.abort();
    changed();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const jobs = new Set<Promise<void>>();
  const expected = new Set(
    readState(dir)
      .sessions.filter(hasLocalDelivery)
      .map((session) => session.key),
  );
  const openedKeys = new Set<string>();
  const failedStartup = (error: unknown) => {
    if (staged && !activated) {
      log(dir, `candidate startup failed: ${String(error)}`);
      process.exit(1);
    }
  };
  const fingerprint = (session: JoinedSession) =>
    createHash('sha256')
      .update(
        JSON.stringify([
          session.server,
          session.clientId,
          session.refreshToken,
          session.accessToken,
          session.accessExpiresAt,
          session.joinedAt,
        ]),
      )
      .digest('hex');
  const start = (joined: JoinedSession, recovered = false) => {
    const controller = new AbortController(),
      entry: Stream = { fingerprint: fingerprint(joined), controller, recovered };
    streams.set(joined.key, entry);
    const job = (async () => {
      while (!controller.signal.aborted) {
        let opened = false,
          terminal = false;
        try {
          const token = await accessToken(dir, joined.key);
          const current = readState(dir).sessions.find((session) => session.key === joined.key);
          if (!current) {
            failedStartup('session disappeared');
            changed();
            return;
          }
          if (staged && !activated) entry.fingerprint = fingerprint(current);
          if (fingerprint(current) !== entry.fingerprint) {
            changed();
            return;
          }
          for await (const raw of memberStream(current, token, controller.signal, () => {
            opened = true;
            if (staged && !activated) {
              openedKeys.add(joined.key);
              if ([...expected].every((key) => openedKeys.has(key))) process.send?.('ready');
            }
          })) {
            // A candidate has a live stream before it can commit or deliver.
            // The old owner drains first; replay then joins durable identities.
            const frame = memberStreamFrame(raw);
            if (frame.type === 'ended' && !activated)
              failedStartup(`member stream ended: ${frame.reason}`);
            await activation;
            if (controller.signal.aborted) return;
            if (staged && frame.type === 'checkpoint') {
              const committed = readState(dir).sessions.find(
                (session) => session.key === joined.key,
              )?.streamCursor;
              if (
                committed?.epoch === frame.cursor.epoch &&
                committed.through > frame.cursor.through
              )
                continue;
            }
            if (frame.type === 'ended') {
              terminal = true;
              break;
            }
            if (await acceptMemberDelivery(dir, joined.key, runner, frame)) {
              entry.recovered = false;
              await flush(dir, sources);
            }
          }
        } catch (error) {
          failedStartup(error);
          if (!controller.signal.aborted)
            log(dir, `${joined.key}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!activated) failedStartup('member stream ended before activation');
        if (controller.signal.aborted || terminal || !opened || entry.recovered) return;
        // One replacement after an established stream drops. A failed initial
        // or replacement connection parks until credentials/join state changes.
        entry.recovered = true;
      }
    })();
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
  };
  try {
    if (staged) {
      if (!expected.size) throw new Error('No joined sessions to activate');
      for (const joined of readState(dir).sessions.filter(hasLocalDelivery)) start(joined);
      await handoff;
      // Commands embedded in delivered messages always use the retained path.
      runner = { ...runner, bundle: join(dir, 'usebeeline.mjs') };
      // Own the bridge before publishing anything: a candidate that loses the
      // claim leaves the serving bridge's public socket where it is.
      if (!claim()) throw new Error('Beeline bridge owner changed during handoff');
      await own();
      renameSync(socket, bridgeSocketPath(dir));
    }
    writeFileSync(join(dir, 'bridge-owner.json'), JSON.stringify({ pid: process.pid, digest }), {
      mode: 0o600,
    });
    if (staged) {
      activated = true;
      activate();
      process.send?.('active');
    }
    log(dir, `bridge ${process.pid} started`);
    for (; !stopping;) {
      localDirty = false;
      const sessions = readState(dir).sessions.filter(hasLocalDelivery);
      if (!sessions.length) break;
      for (const [key, stream] of streams)
        if (!sessions.some((session) => session.key === key)) {
          stream.controller.abort();
          streams.delete(key);
        }
      for (const joined of sessions) {
        const old = streams.get(joined.key);
        if (!old || old.fingerprint !== fingerprint(joined)) {
          // Token rotation replaces this owner too; retain its one recovery
          // allowance until a real delivery proves the replacement works.
          old?.controller.abort();
          start(joined, old?.recovered);
        }
      }
      await flush(dir, sources).catch((error) => log(dir, `flush: ${String(error)}`));
      // A change during flush set localDirty; otherwise park until the next one.
      if (!localDirty)
        await answer<void>('Beeline bridge changes', [], ({ resolve }) => {
          wake = () => resolve();
        });
      wake = undefined;
    }
  } catch (error) {
    failedStartup(error);
    // A failed bridge leaves through its caller, which must not keep the lock's listener open.
    await owner?.release();
    throw error;
  } finally {
    stopWatching();
    for (const stream of streams.values()) {
      stream.controller.abort();
    }
    if (staged && !activated) activate();
    await Promise.allSettled(jobs);
    await tools.close();
  }
  log(
    dir,
    `bridge ${process.pid} stopped: ${stopping ? 'handoff or shutdown' : 'no joined sessions'}`,
  );
  // Clean up only what this bridge still owns.
  try {
    if (Number(readFileSync(pidFile, 'utf8')) === process.pid) rmSync(pidFile, { force: true });
  } catch {
    /* already gone */
  }
  rmSync(bridgeSocketPath(dir), { force: true });
  process.exit(0);
}

export { bridgeRunning, ensureBridge, refreshJoinedSessionBridge } from './bridge-launch.js';

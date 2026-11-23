import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { watchChanges } from '../wait.js';
import { ancestors } from './agents.js';
import { postToClaude, scanClaude, type ClaudeSession } from './claude.js';
import { pidAlive, queueInbox, readState, takeInbox, type JoinedSession } from './store.js';

interface InSession {
  pid: number;
  claudePid: number;
}

export function hasClaudeMcp(dir: string, claudePid?: number): boolean {
  if (!claudePid) return false;
  let files: string[];
  try {
    files = readdirSync(join(dir, 'claude-mcp'));
  } catch {
    return false;
  }
  return files.some((file) => {
    try {
      const entry = JSON.parse(readFileSync(join(dir, 'claude-mcp', file), 'utf8')) as InSession;
      return entry.claudePid === claudePid && pidAlive(entry.pid);
    } catch {
      return false;
    }
  });
}

/** The token stays in the MCP child's memory, never in the bridge state, registry, argv or stdout. */
export async function flushClaudeMcp(
  dir: string,
  session: ClaudeSession,
  token: string,
  post: typeof postToClaude = postToClaude,
  requeued?: (path: string) => void,
): Promise<boolean> {
  if (!session.messagingSocketPath) return false;
  const joined = joinedFor(dir, session);
  if (!joined) return false;
  const text = takeInbox(dir, joined.key);
  if (!text) return false;
  try {
    await post({ path: session.messagingSocketPath, token }, text);
    return true;
  } catch {
    const path = queueInbox(dir, joined.key, text);
    requeued?.(path);
    return false;
  }
}

/** The live Claude Code session this process runs inside. */
function ownClaude(env: NodeJS.ProcessEnv, chain: number[]): ClaudeSession | undefined {
  const live = scanClaude(env);
  return chain.map((pid) => live.find((s) => s.pid === pid)).find(Boolean);
}

/** The joined record of a Claude Code session, if it joined. */
function joinedFor(dir: string, session: ClaudeSession): JoinedSession | undefined {
  return readState(dir).sessions.find(
    (s) =>
      s.agent === 'claude-code' && (s.pid === session.pid || s.sessionId === session.sessionId),
  );
}

/**
 * Claude starts this stdio server inside each session and supplies that session's messaging token. Its
 * initialize answer carries the session's Beeline rules as server instructions, which Claude shows the model.
 */
export async function runClaudeMcp(
  dir: string,
  env: NodeJS.ProcessEnv,
  rulesFor?: (joined: JoinedSession) => string,
  post: typeof postToClaude = postToClaude,
): Promise<void> {
  const chain = ancestors(process.pid);
  let registration: string | undefined;
  let flushing = false,
    dirty = false,
    deaf = false;
  let requeuedPath: string | undefined;
  const flush = async () => {
    dirty = true;
    if (flushing || !env.CLAUDE_CODE_MESSAGING_TOKEN) return;
    flushing = true;
    try {
      while (dirty) {
        dirty = false;
        const session = ownClaude(env, chain);
        if (!session) return;
        if (!registration && !deaf) {
          const folder = join(dir, 'claude-mcp');
          mkdirSync(folder, { recursive: true, mode: 0o700 });
          registration = join(folder, `${process.pid}.json`);
          writeFileSync(
            registration,
            JSON.stringify({ pid: process.pid, claudePid: session.pid }),
            { mode: 0o600 },
          );
        }
        await flushClaudeMcp(dir, session, env.CLAUDE_CODE_MESSAGING_TOKEN, post, (path) => {
          requeuedPath = relative(dir, path);
        });
      }
    } finally {
      flushing = false;
    }
  };
  // A change without a name is any change. If the watcher fails this server
  // can no longer hear deliveries, so it gives delivery back to the bridge.
  const stopWatching = watchChanges(
    dir,
    (path) => {
      if (
        path !== null &&
        path.startsWith('deliveries/') &&
        /\.(?:pending|done)(?:\.|$)/.test(path) &&
        (!path.endsWith('.pending') || path === requeuedPath || !existsSync(join(dir, path)))
      )
        return;
      if (path === null || path === 'state.json' || /^(?:inbox|deliveries)(?:\/|$)/.test(path))
        void flush().catch(() => undefined);
    },
    {
      recursive: true,
      onError: () => {
        deaf = true;
        if (registration) rmSync(registration, { force: true });
        registration = undefined;
      },
    },
  );
  try {
    await flush();
    for await (const line of createInterface({ input: process.stdin })) {
      let request: { id?: unknown; method?: string; params?: { protocolVersion?: string } };
      try {
        request = JSON.parse(line);
      } catch {
        continue;
      }
      if (request.id === undefined) continue;
      const session = request.method === 'initialize' && rulesFor && ownClaude(env, chain);
      const joined = session ? joinedFor(dir, session) : undefined;
      const result =
        request.method === 'initialize'
          ? {
              protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'beeline', version: '1.0.0' },
              ...(joined && rulesFor ? { instructions: rulesFor(joined) } : {}),
            }
          : request.method === 'tools/list'
            ? { tools: [] }
            : request.method === 'ping'
              ? {}
              : undefined;
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          ...(result ? { result } : { error: { code: -32601, message: 'Method not found' } }),
        }) + '\n',
      );
    }
  } finally {
    stopWatching();
    if (registration) rmSync(registration, { force: true });
  }
}

#!/usr/bin/env node
/**
 * Beeline-owned ACP bridge for `cursor-agent`.
 *
 * cursor-agent has no native ACP server. The only published third-party
 * adapter (`cursor-agent-acp@0.1.1`) is an unfinished stub: `prompt()` returns
 * `{ stopReason: "end_turn" }` without waiting, and its catch path returns
 * `{ stopReason: "refusal" }` — the exact Room failure line. This process
 * speaks ACP over stdio and drives cursor-agent in the verified non-interactive
 * streaming mode, translating stream-json events into `session/update`
 * notifications so `acp.ts` sees real `agent_message_chunk` text.
 */
import { agentBehavior, CURSOR_ACP_BRIDGE_LABEL } from './agent-command.js';
import type { ChildProcess } from 'node:child_process';
import { chmod, lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { enumerateCursorModels, type CursorModelCatalog } from './cursor-models.js';
import { runOwned } from './wait.js';

/** Hidden CLI flag so a bundled `beeline` process can be the ACP child. */
export { CURSOR_ACP_BRIDGE_FLAG } from './agent-command.js';

/**
 * Stable harness identity for classification. Spawn argv is `node` plus this
 * module (or the bundled CLI plus {@link CURSOR_ACP_BRIDGE_FLAG}), so callers
 * that match on the spawn command would otherwise classify every cursor
 * session as `node`.
 */
export { CURSOR_ACP_BRIDGE_LABEL } from './agent-command.js';

/**
 * cursor-agent's non-interactive allow-all switch (`--force` / `--yolo`).
 * Beeline already sandboxes the child and owns tool permission, so Cursor
 * must not prompt for commands in a Room or corner.
 */
export const CURSOR_AGENT_FORCE_FLAG = '--force';

/** Skips the Workspace Trust gate that otherwise wedges a fresh worktree. */
export const CURSOR_AGENT_TRUST_FLAG = '--trust';

/**
 * Approves every MCP server in the isolated home so cursor-agent does not
 * silently skip the session servers the bridge just wrote.
 */
export const CURSOR_AGENT_APPROVE_MCPS_FLAG = '--approve-mcps';

/** Session MCP servers `session/new` hands this bridge. Same wire as ACP. */
export type CursorMcpServer = {
  name: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
};

/** Match the owned bridge and the retired stub so leftover labels still classify. */
export const CURSOR_HARNESS_COMMAND = /(^|[/\\])(cursor-acp-bridge|cursor-agent-acp)(\.[a-z]+)?$/i;

const STDERR_TAIL_MAX_CHARS = 2_000;
const MODEL_AXIS_ID = 'model';

export type AcpSessionUpdate = {
  sessionUpdate: string;
  content?: { type: 'text'; text: string } | unknown;
  toolCallId?: string;
  title?: string;
  name?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: unknown;
};

export type CursorStreamEvent = {
  type?: unknown;
  subtype?: unknown;
  text?: unknown;
  is_error?: unknown;
  result?: unknown;
  message?: unknown;
  call_id?: unknown;
  tool_call_id?: unknown;
  id?: unknown;
  name?: unknown;
  tool?: unknown;
  tool_call?: unknown;
  arguments?: unknown;
  input?: unknown;
  output?: unknown;
  content?: unknown;
  error?: unknown;
};

export type CursorAcpWriter = (message: Record<string, unknown>) => void;

type JsonRpcMessage = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

type BridgeSession = {
  id: string;
  cwd: string;
  systemPrompt?: string;
  model?: string;
  child?: ChildProcess;
};

export function harnessIdentityLabel(agent: { kind?: string; command?: string }): string {
  return agentBehavior(agent.kind).identityLabel ?? agent.command ?? '';
}

/**
 * The `session/new` server list for one harness. Cursor reads MCP servers
 * only from this list (the bridge rewrites its mcp.json from it), so it also
 * needs the granted host routes. Every other harness already reads those
 * from its isolated home config, and gets the Beeline servers only.
 */
export function sessionNewMcpServers<T extends { name: string }>(
  harnessLabel: string,
  servers: readonly T[],
  grantedRouteServers: readonly T[],
): T[] {
  if (harnessLabel !== CURSOR_ACP_BRIDGE_LABEL) return [...servers];
  const names = new Set(servers.map((server) => server.name));
  return [...servers, ...grantedRouteServers.filter((server) => !names.has(server.name))];
}

export { cursorAcpBridgeLaunch } from './agent-command.js';

/**
 * Argv for one non-interactive cursor-agent turn. The prompt is the last
 * operand — the shape verified to stream thinking + assistant + result.
 */
export function cursorAgentArgv(input: { prompt: string; model?: string }): string[] {
  const argv = [
    '--print',
    '--output-format',
    'stream-json',
    CURSOR_AGENT_TRUST_FLAG,
    CURSOR_AGENT_FORCE_FLAG,
    CURSOR_AGENT_APPROVE_MCPS_FLAG,
  ];
  if (input.model && input.model !== 'auto') argv.push('--model', input.model);
  argv.push(input.prompt);
  return argv;
}

/**
 * Isolated Beeline homes set HOME and CURSOR_HOME as siblings under one
 * agent-home root. That is the only layout this bridge will write: operator
 * `~/.cursor` is never a sibling of `$HOME` in that way.
 */
export function isolatedCursorHome(env: NodeJS.ProcessEnv): string | undefined {
  const cursorHome = typeof env.CURSOR_HOME === 'string' ? env.CURSOR_HOME.trim() : '';
  const home = typeof env.HOME === 'string' ? env.HOME.trim() : '';
  if (!cursorHome || !home) return undefined;
  const resolvedCursor = resolvePath(cursorHome);
  const resolvedHome = resolvePath(home);
  if (dirname(resolvedCursor) !== dirname(resolvedHome)) return undefined;
  return resolvedCursor;
}

/** The `mcp.json` cursor-agent actually loads: `$HOME/.cursor/mcp.json`. */
export function isolatedHomeCursorMcpPath(env: NodeJS.ProcessEnv): string | undefined {
  if (!isolatedCursorHome(env)) return undefined;
  const home = typeof env.HOME === 'string' ? env.HOME.trim() : '';
  if (!home) return undefined;
  return resolvePath(home, '.cursor', 'mcp.json');
}

/**
 * Replace one generated file without following a symlink already occupying
 * the target — same rule as `writeIsolatedHarnessFile` in `agent-home.ts`,
 * kept local so this module does not import the home overlay (that graph
 * loads this file).
 */
async function writeIsolatedCursorFile(path: string, content: string): Promise<void> {
  const parent = dirname(path);
  const parentStats = await lstat(parent);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new Error(`isolated cursor parent is not a real directory: ${parent}`);
  }
  const temporary = resolvePath(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export function cursorSessionMcpConfig(servers: readonly CursorMcpServer[]): {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
} {
  const mcpServers: Record<
    string,
    { command: string; args: string[]; env: Record<string, string> }
  > = {};
  for (const server of servers) {
    mcpServers[server.name] = {
      command: server.command,
      args: server.args ?? [],
      env: Object.fromEntries((server.env ?? []).map((entry) => [entry.name, entry.value])),
    };
  }
  return { mcpServers };
}

/**
 * Write this session's MCP servers into the isolated CURSOR_HOME, and into
 * the `$HOME/.cursor/mcp.json` cursor-agent reads. Never writes the operator's
 * own cursor config.
 */
export async function installCursorSessionMcp(input: {
  env: NodeJS.ProcessEnv;
  servers: readonly CursorMcpServer[];
}): Promise<string | undefined> {
  const cursorHome = isolatedCursorHome(input.env);
  if (!cursorHome || !input.servers.length) return undefined;
  const path = resolvePath(cursorHome, 'mcp.json');
  try {
    await mkdir(cursorHome, { recursive: true, mode: 0o700 });
    const body = `${JSON.stringify(cursorSessionMcpConfig(input.servers), null, 2)}\n`;
    await writeIsolatedCursorFile(path, body);
    const homeMirror = isolatedHomeCursorMcpPath(input.env);
    if (homeMirror) {
      await mkdir(dirname(homeMirror), { recursive: true, mode: 0o700 });
      await writeIsolatedCursorFile(homeMirror, body);
    }
    return path;
  } catch (error) {
    console.error('[body] cursor session MCP could not be written', path, error);
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function parseMcpServers(value: unknown): CursorMcpServer[] {
  if (!Array.isArray(value)) return [];
  const servers: CursorMcpServer[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record || typeof record.name !== 'string' || !record.name) continue;
    if (typeof record.command !== 'string' || !record.command) continue;
    const args = Array.isArray(record.args)
      ? record.args.filter((arg): arg is string => typeof arg === 'string')
      : [];
    const env = Array.isArray(record.env)
      ? record.env.flatMap((entry) => {
          const row = asRecord(entry);
          if (!row || typeof row.name !== 'string' || typeof row.value !== 'string') return [];
          return [{ name: row.name, value: row.value }];
        })
      : [];
    servers.push({ name: record.name, command: record.command, args, env });
  }
  return servers;
}

function textChunksFromContent(content: unknown): string[] {
  if (typeof content === 'string' && content) return [content];
  if (!Array.isArray(content)) return [];
  const chunks: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (!record) continue;
    if (record.type === 'text' && typeof record.text === 'string' && record.text) {
      chunks.push(record.text);
    }
  }
  return chunks;
}

function thoughtText(event: CursorStreamEvent): string {
  if (typeof event.text === 'string') return event.text;
  const record = asRecord(event);
  if (!record) return '';
  if (typeof record.delta === 'string') return record.delta;
  return textChunksFromContent(record.content).join('');
}

function assistantTexts(event: CursorStreamEvent): string[] {
  if (typeof event.text === 'string' && event.text) return [event.text];
  const message = asRecord(event.message);
  if (message) return textChunksFromContent(message.content);
  return textChunksFromContent(asRecord(event)?.content);
}

function chunkUpdate(
  sessionUpdate: 'agent_thought_chunk' | 'agent_message_chunk',
  text: string,
): AcpSessionUpdate {
  return { sessionUpdate, content: { type: 'text', text } };
}

function cursorToolKind(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('read')) return 'read';
  if (lower.includes('edit') || lower.includes('write') || lower.includes('patch')) return 'edit';
  if (lower.includes('delete') || lower.includes('remove')) return 'delete';
  if (lower.includes('shell') || lower.includes('bash') || lower.includes('exec') || lower.includes('terminal')) return 'execute';
  if (lower.includes('search') || lower.includes('grep') || lower.includes('glob') || lower.includes('list')) return 'search';
  return 'other';
}

function unwrapCursorToolCall(event: CursorStreamEvent): {
  toolCallId?: string;
  name: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  isError?: boolean;
} | undefined {
  const callId =
    (typeof event.call_id === 'string' && event.call_id) ||
    (typeof event.tool_call_id === 'string' && event.tool_call_id) ||
    (typeof event.id === 'string' && event.id) ||
    undefined;
  const nested = asRecord(event.tool_call);
  if (nested) {
    const entries = Object.entries(nested);
    if (entries.length > 0) {
      const [key, body] = entries[0]!;
      const bodyRec = asRecord(body);
      const rawName =
        (typeof bodyRec?.name === 'string' && bodyRec.name) ||
        (typeof bodyRec?.tool === 'string' && bodyRec.tool) ||
        key.replace(/ToolCall$/i, '');
      const rawInput = bodyRec?.args ?? bodyRec?.arguments ?? bodyRec?.input;
      const resultRec = asRecord(bodyRec?.result);
      const isError =
        event.is_error === true ||
        bodyRec?.is_error === true ||
        resultRec?.is_error === true ||
        resultRec?.isError === true ||
        'rejected' in (resultRec ?? {}) ||
        'error' in (resultRec ?? {});
      const rawOutput =
        resultRec?.success ?? resultRec?.error ?? resultRec?.rejected ?? bodyRec?.result;
      return { toolCallId: callId, name: rawName || 'tool', rawInput, rawOutput, isError };
    }
  }
  const flatName =
    (typeof event.name === 'string' && event.name) ||
    (typeof event.tool === 'string' && event.tool) ||
    undefined;
  if (!flatName && !callId) return undefined;
  const rawInput = event.arguments ?? event.input;
  const rawOutput = event.output ?? event.result ?? event.error ?? event.content;
  const isError = event.is_error === true || Boolean(event.error);
  return { toolCallId: callId, name: flatName ?? 'tool', rawInput, rawOutput, isError };
}

/**
 * Map one verified cursor-agent stream-json object onto ACP session updates.
 * `thinking` deltas become thoughts; `assistant` message content becomes the
 * durable answer stream; `tool_call`/`tool_result` become ACP tool updates;
 * `result` is the turn-end signal (handled by the caller). Init/user frames
 * are ignored.
 */
export function translateCursorStreamEvent(event: CursorStreamEvent): AcpSessionUpdate[] {
  if (event.type === 'thinking') {
    if (event.subtype === 'completed') return [];
    const text = thoughtText(event);
    return text ? [chunkUpdate('agent_thought_chunk', text)] : [];
  }
  if (event.type === 'assistant') {
    return assistantTexts(event).map((text) => chunkUpdate('agent_message_chunk', text));
  }
  if (event.type === 'tool_call') {
    const info = unwrapCursorToolCall(event);
    if (!info) return [];
    const completed = event.subtype === 'completed' || info.rawOutput !== undefined;
    const status = completed ? (info.isError ? 'failed' : 'completed') : 'in_progress';
    return [
      {
        sessionUpdate: completed ? 'tool_call_update' : 'tool_call',
        ...(info.toolCallId ? { toolCallId: info.toolCallId } : {}),
        name: info.name,
        title: info.name,
        kind: cursorToolKind(info.name),
        status,
        ...(info.rawInput !== undefined ? { rawInput: info.rawInput } : {}),
        ...(info.rawOutput !== undefined ? { rawOutput: info.rawOutput } : {}),
      },
    ];
  }
  if (event.type === 'tool_result') {
    const toolCallId =
      (typeof event.call_id === 'string' && event.call_id) ||
      (typeof event.tool_call_id === 'string' && event.tool_call_id) ||
      (typeof event.id === 'string' && event.id) ||
      undefined;
    const rawOutput = event.output ?? event.result ?? event.error ?? event.content;
    const isError = event.is_error === true || Boolean(event.error);
    return [
      {
        sessionUpdate: 'tool_result',
        ...(toolCallId ? { toolCallId } : {}),
        status: isError ? 'failed' : 'completed',
        ...(rawOutput !== undefined ? { rawOutput } : {}),
      },
    ];
  }
  return [];
}

export function resultEventText(event: CursorStreamEvent): string {
  if (typeof event.result === 'string') return event.result;
  const record = asRecord(event.result);
  if (record && typeof record.text === 'string') return record.text;
  return '';
}

export function isCursorResultEvent(event: CursorStreamEvent): boolean {
  return event.type === 'result';
}

export function cursorResultIsError(event: CursorStreamEvent): boolean {
  return event.is_error === true || event.subtype === 'error';
}

function trimReason(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Named failure for a cursor-agent run that must never become a silent empty turn. */
export function describeCursorTurnFailure(input: {
  isError?: boolean;
  resultText?: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  spawnError?: string;
}): string | undefined {
  if (input.spawnError) {
    return trimReason(`cursor-agent failed to start: ${input.spawnError}`);
  }
  const stderr = input.stderr?.trim() ?? '';
  if (input.isError) {
    const named =
      input.resultText?.trim() || stderr || 'cursor-agent reported an error with no answer text';
    return trimReason(`cursor-agent reported an error: ${named}`);
  }
  if (input.signal) {
    return trimReason(`cursor-agent terminated by ${input.signal}${stderr ? `: ${stderr}` : ''}`);
  }
  if (input.exitCode !== 0 && input.exitCode !== null) {
    return trimReason(
      `cursor-agent exited ${input.exitCode}${stderr ? `: ${stderr}` : ' with no answer text'}`,
    );
  }
  return undefined;
}

function promptTextFromParams(params: unknown, systemPrompt?: string): string {
  const record = asRecord(params);
  const blocks = Array.isArray(record?.prompt) ? record.prompt : [];
  const user = blocks
    .map((block) => {
      const item = asRecord(block);
      return item?.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .filter(Boolean)
    .join('\n');
  return systemPrompt ? `${systemPrompt}\n\n${user}` : user;
}

export interface CursorAcpServerOptions {
  write: CursorAcpWriter;
  enumerateModels?: (env?: NodeJS.ProcessEnv) => Promise<CursorModelCatalog | undefined>;
  env?: NodeJS.ProcessEnv;
}

/**
 * One ACP session server. `handle()` is the test seam; stdio wiring lives in
 * {@link runCursorAcpStdioServer}.
 */
export class CursorAcpServer {
  private readonly write: CursorAcpWriter;
  private readonly enumerateModels: (
    env?: NodeJS.ProcessEnv,
  ) => Promise<CursorModelCatalog | undefined>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sessions = new Map<string, BridgeSession>();
  private models: CursorModelCatalog | undefined;

  constructor(options: CursorAcpServerOptions) {
    this.write = options.write;
    this.enumerateModels = options.enumerateModels ?? enumerateCursorModels;
    this.env = options.env ?? process.env;
  }

  async handle(message: JsonRpcMessage): Promise<void> {
    const method = typeof message.method === 'string' ? message.method : '';
    const id = message.id;
    if (!method) return;
    if (id === undefined) {
      if (method === 'session/cancel') this.cancel(message.params);
      return;
    }
    try {
      const result = await this.dispatch(method, message.params);
      this.write({ jsonrpc: '2.0', id, result });
    } catch (error) {
      const rpcError = error as { code?: number; message?: string };
      this.write({
        jsonrpc: '2.0',
        id,
        error: {
          code: typeof rpcError.code === 'number' ? rpcError.code : -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: 1,
          agentCapabilities: { promptCapabilities: { image: false } },
        };
      case 'session/new':
        return this.sessionNew(params);
      case 'session/prompt':
        return this.sessionPrompt(params);
      case 'session/set_config_option':
        return this.setConfigOption(params);
      case 'session/set_model':
        return this.setModel(params);
      case 'shutdown':
        this.shutdown();
        return {};
      default:
        return {};
    }
  }

  private async loadModels(): Promise<CursorModelCatalog | undefined> {
    if (this.models) return this.models;
    // A failed lookup is unknown, never proof that only Auto is available.
    // Retry once and cache only success so a later session can recover.
    this.models = (await this.enumerateModels(this.env)) ?? (await this.enumerateModels(this.env));
    return this.models;
  }

  private async sessionNew(params: unknown): Promise<Record<string, unknown>> {
    const record = asRecord(params);
    const cwd = typeof record?.cwd === 'string' && record.cwd ? record.cwd : process.cwd();
    const systemPrompt = typeof record?.systemPrompt === 'string' ? record.systemPrompt : undefined;
    await installCursorSessionMcp({
      env: this.env,
      servers: parseMcpServers(record?.mcpServers),
    });
    const catalog = await this.loadModels();
    const session: BridgeSession = {
      id: randomUUID(),
      cwd,
      ...(systemPrompt ? { systemPrompt } : {}),
      model: catalog?.currentValue ?? 'auto',
    };
    this.sessions.set(session.id, session);
    return {
      sessionId: session.id,
      configOptions: catalog
        ? [
            {
              id: MODEL_AXIS_ID,
              category: 'model',
              currentValue: session.model,
              options: catalog.options.map((option) => ({
                id: option.id,
                ...(option.name ? { name: option.name } : {}),
              })),
            },
          ]
        : [],
    };
  }

  private session(params: unknown): BridgeSession {
    const record = asRecord(params);
    const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : '';
    const session = this.sessions.get(sessionId);
    if (!session) {
      const error = new Error(`unknown ACP session ${sessionId || '(missing)'}`);
      (error as { code?: number }).code = -32602;
      throw error;
    }
    return session;
  }

  private setConfigOption(params: unknown): Record<string, unknown> {
    const session = this.session(params);
    const record = asRecord(params);
    if (record?.configId === MODEL_AXIS_ID && typeof record.value === 'string' && record.value) {
      session.model = record.value;
    }
    return {};
  }

  private setModel(params: unknown): Record<string, unknown> {
    const session = this.session(params);
    const record = asRecord(params);
    if (typeof record?.modelId === 'string' && record.modelId) session.model = record.modelId;
    return {};
  }

  private emitUpdate(sessionId: string, update: AcpSessionUpdate): void {
    this.write({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update },
    });
  }

  private async sessionPrompt(params: unknown): Promise<{ stopReason: string }> {
    const session = this.session(params);
    if (session.child) {
      throw new Error('cursor-agent is already running a turn for this session');
    }
    const prompt = promptTextFromParams(params, session.systemPrompt);
    const argv = cursorAgentArgv({ prompt, model: session.model });
    let stderr = '';
    let spawnError: string | undefined;
    let sawAssistant = false;
    let resultEvent: CursorStreamEvent | undefined;
    const pending: string[] = [];

    const consumeLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: CursorStreamEvent;
      try {
        event = JSON.parse(trimmed) as CursorStreamEvent;
      } catch {
        return;
      }
      if (isCursorResultEvent(event)) {
        resultEvent = event;
        return;
      }
      for (const update of translateCursorStreamEvent(event)) {
        if (update.sessionUpdate === 'agent_message_chunk') sawAssistant = true;
        this.emitUpdate(session.id, update);
      }
    };

    // cursor-agent stays in this bridge's process group, so a hard kill of
    // the bridge's group also ends the turn it is running.
    const run = runOwned({
      step: 'cursor-agent',
      file: 'cursor-agent',
      args: argv,
      cwd: session.cwd,
      env: this.env,
      group: 'caller',
      captureOutput: false,
      onSpawn: (child) => {
        session.child = child;
        child.once('error', (error) => {
          spawnError = error instanceof Error ? error.message : String(error);
        });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
          stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL_MAX_CHARS);
        });
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          pending.push(chunk);
          const joined = pending.join('');
          const lines = joined.split(/\r?\n/);
          pending.length = 0;
          const rest = lines.pop();
          if (rest) pending.push(rest);
          for (const line of lines) consumeLine(line);
        });
      },
    });

    try {
      const { code, signal } = await run.then(
        (result) => ({ code: result.code, signal: result.signal }),
        (error: unknown) => {
          // Without a child the spawn itself threw; otherwise its error is spawnError.
          if (!session.child) throw error;
          return { code: 1 as number | null, signal: null as NodeJS.Signals | null };
        },
      );
      if (pending.length) consumeLine(pending.join(''));
      const failure = describeCursorTurnFailure({
        isError: resultEvent ? cursorResultIsError(resultEvent) : false,
        resultText: resultEvent ? resultEventText(resultEvent) : undefined,
        exitCode: spawnError ? 1 : code,
        signal,
        stderr,
        spawnError,
      });
      if (failure) throw new Error(failure);
      if (!sawAssistant) {
        const fallback =
          resultEvent && !cursorResultIsError(resultEvent) ? resultEventText(resultEvent) : '';
        if (fallback) this.emitUpdate(session.id, chunkUpdate('agent_message_chunk', fallback));
      }
      return { stopReason: 'end_turn' };
    } finally {
      session.child = undefined;
    }
  }

  private cancel(params: unknown): void {
    const record = asRecord(params);
    const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : '';
    const session = this.sessions.get(sessionId);
    if (!session?.child?.pid) return;
    try {
      session.child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }

  shutdown(): void {
    for (const session of this.sessions.values()) {
      if (!session.child?.pid) continue;
      try {
        session.child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    this.sessions.clear();
  }
}

export async function runCursorAcpStdioServer(
  options: Omit<CursorAcpServerOptions, 'write'> = {},
): Promise<void> {
  const server = new CursorAcpServer({
    ...options,
    write: (message) => {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    },
  });
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      continue;
    }
    await server.handle(message);
    if (message.method === 'shutdown') break;
  }
}

function isDirectBridgeRun(): boolean {
  const entry = process.argv[1];
  if (!entry || entry.includes('.test.')) return false;
  // Inside a bundle (beeline-readonly-mcp.mjs) import.meta.url is the bundle
  // itself, so it equals argv[1] and would start a second stdio server that
  // answers every MCP request with an empty result.
  if (!/cursor-acp-bridge\.(?:js|ts)$/.test(entry)) return false;
  try {
    return resolvePath(entry) === resolvePath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectBridgeRun()) {
  void runCursorAcpStdioServer();
}

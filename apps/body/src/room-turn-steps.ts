import { maskCredentialResult } from './mask-credential-result.js';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import type { AgentTurnStep, ToolCallEntry } from './acp.js';
import { redactToolDetail } from './turn-failure-reason.js';

type DaemonActivity = DaemonOperationMap['postAgentActivity']['input']['activity'][number];

/** The server's bounds on a reply's steps (`daemon-service.ts`). */
export const MAX_REPLY_STEPS = 2_000;
export const MAX_NOTE_LENGTH = 16_000;
export const MAX_STEP_OUTPUT_BYTES = 4_096;
const MAX_STEP_COMMAND_LENGTH = 500;
const MAX_STEP_INPUT_LENGTH = 500;
const MAX_STEP_INPUT_VALUE_LENGTH = 160;
const MAX_STEP_FILES = 8;
const MAX_STEP_FILE_PATH_LENGTH = 260;
const OUTPUT_OMISSION_MARKER = '\n[… omitted …]\n';

const KNOWN_MCP_SERVERS = [
  'beeline-readonly-mcp',
  'beeline_readonly_mcp',
  'beeline-agent',
  'beeline_agent',
  'codegraph',
  'squire',
] as const;

const INPUT_SUMMARY_KEYS = [
  'action',
  'facet',
  'title',
  'name',
  'query',
  'pattern',
  'regex',
  'path',
  'file_path',
  'filePath',
  'filename',
  'target',
  'url',
  'room',
  'address',
  'slug',
  'toolSummary',
  'mode',
  'scope',
  'service',
  'kind',
  'type',
  'reason',
  'recipient',
  'recipients',
  'state',
] as const;

const FILE_PATH_KEYS = [
  'path',
  'file_path',
  'filePath',
  'filename',
  'file',
  'target_file',
] as const;

const OUTPUT_TEXT_KEYS = new Set([
  'formatted_output',
  'stdout',
  'stderr',
  'output',
  'text',
  'content',
  'message',
  'error',
  'result',
]);

const CREDENTIAL_IDENTITY_PATTERN =
  /fetch_credential|read_credential|raw_credential|[._]netrc\b|\.pgpass\b|\.git-credentials\b|\.npmrc\b|\.pypirc\b|\.docker[\\/]+config\.json\b|\.aws[\\/]+credentials\b|\.env|credentials|\bid_[a-z0-9_]+\b|\.(?:pem|key)\b|private.?key/i;

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function preserveLines(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) return undefined;
    try {
      return asRecord(JSON.parse(trimmed));
    } catch {
      return undefined;
    }
  }
  return asRecord(value);
}

/** Unwrap harness argument envelopes (`arguments`, `tool_input`, `toolInput`). */
function unwrapRawInput(rawInput: unknown): Record<string, unknown> | undefined {
  let current: unknown = rawInput;
  for (let depth = 0; depth < 4; depth += 1) {
    const record = parseJsonObject(current);
    if (!record) return undefined;
    const nested = record.arguments ?? record.tool_input ?? record.toolInput;
    if (nested === undefined) return record;
    current = nested;
  }
  return undefined;
}

function parseMcpToolString(value: string | undefined): { server: string; tool: string } | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const dunder = trimmed.match(/^mcp__([\w.-]+)__([\w.-]+)$/);
  if (dunder?.[1] && dunder[2]) return { server: dunder[1], tool: dunder[2] };
  const dotted = trimmed.match(/^mcp\.([\w-]+)\.([\w.-]+)$/);
  if (dotted?.[1] && dotted[2]) return { server: dotted[1], tool: dotted[2] };
  if (trimmed.startsWith('mcp_')) {
    const rest = trimmed.slice(4);
    for (const server of KNOWN_MCP_SERVERS) {
      if (rest.startsWith(`${server}_`) && rest.length > server.length + 1) {
        return {
          server: server.replaceAll('_', '-'),
          tool: rest.slice(server.length + 1),
        };
      }
    }
    const single = rest.match(/^([a-z0-9-]+)_([a-z0-9_]+)$/i);
    if (single?.[1] && single[2]) return { server: single[1], tool: single[2] };
  }
  return undefined;
}

function parseQualifiedToolString(value: string | undefined): { server: string; tool: string } | undefined {
  if (!value) return undefined;
  const mcp = parseMcpToolString(value);
  if (mcp) return mcp;
  const trimmed = value.trim();
  const dunder = trimmed.match(/^([\w.-]+)__([\w.-]+)$/);
  if (dunder?.[1] && dunder[2]) return { server: dunder[1], tool: dunder[2] };
  const dotted = trimmed.match(/^([\w-]+)\.([\w.-]+)$/);
  if (dotted?.[1] && dotted[2]) return { server: dotted[1], tool: dotted[2] };
  return undefined;
}

function normalizeMcpIdentity(call: ToolCallEntry): { server: string; tool: string } | undefined {
  const outer = parseJsonObject(call.rawInput);
  if (typeof outer?.server === 'string' && typeof outer.tool === 'string' && outer.server.trim() && outer.tool.trim()) {
    return { server: outer.server.trim(), tool: outer.tool.trim() };
  }
  const dispatched =
    (typeof outer?.tool_name === 'string' ? outer.tool_name : undefined) ??
    (typeof outer?.toolName === 'string' ? outer.toolName : undefined);
  if (dispatched) {
    const parsed = parseQualifiedToolString(dispatched);
    if (parsed) return parsed;
  }
  return parseMcpToolString(call.name) ?? parseMcpToolString(call.title);
}

function extractCommand(call: ToolCallEntry): string | undefined {
  const readFromRecord = (record: Record<string, unknown> | undefined): string | undefined => {
    if (!record) return undefined;
    const raw = record.command ?? record.cmd ?? record.CommandLine ?? record.commandLine;
    if (typeof raw === 'string' && raw.trim()) return raw;
    if (Array.isArray(raw) && raw.every((part) => typeof part === 'string')) {
      const joined = raw.join(' ').trim();
      if (joined) return joined;
    }
    return undefined;
  };
  const outer = parseJsonObject(call.rawInput);
  const unwrapped = unwrapRawInput(call.rawInput);
  const direct = readFromRecord(unwrapped) ?? readFromRecord(outer);
  if (direct) return preserveLines(redactToolDetail(direct)).slice(0, MAX_STEP_COMMAND_LENGTH) || undefined;
  if (typeof call.rawInput === 'string' && !call.rawInput.trim().startsWith('{')) {
    const trimmed = preserveLines(redactToolDetail(call.rawInput));
    if (trimmed) return trimmed.slice(0, MAX_STEP_COMMAND_LENGTH);
  }
  return undefined;
}

function sanitizeInputValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const redacted = oneLine(redactToolDetail(value));
    if (!redacted) return undefined;
    return redacted.length > MAX_STEP_INPUT_VALUE_LENGTH
      ? `${redacted.slice(0, MAX_STEP_INPUT_VALUE_LENGTH - 1)}…`
      : redacted;
  }
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) {
    const items = value
      .slice(0, 4)
      .map((entry) => (typeof entry === 'string' ? sanitizeInputValue(entry) : undefined))
      .filter((entry): entry is string => typeof entry === 'string');
    return items.length ? items : undefined;
  }
  return undefined;
}

function extractInputSummary(call: ToolCallEntry, command: string | undefined): string | undefined {
  const args = unwrapRawInput(call.rawInput);
  if (!args) return undefined;
  const picked: Record<string, unknown> = {};
  for (const key of INPUT_SUMMARY_KEYS) {
    if (!(key in args)) continue;
    const sanitized = sanitizeInputValue(args[key]);
    if (sanitized !== undefined) picked[key] = sanitized;
  }
  if (!Object.keys(picked).length) return undefined;
  // Don't repeat a single path-only or empty summary if it duplicates a command identically.
  const serialized = JSON.stringify(picked);
  if (command && serialized === JSON.stringify({ command })) return undefined;
  if (serialized.length <= MAX_STEP_INPUT_LENGTH) return serialized;
  // Drop less-essential keys from the back until within budget.
  const entries = Object.entries(picked);
  const trimmed: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const candidate = JSON.stringify({ ...trimmed, [key]: value });
    if (candidate.length > MAX_STEP_INPUT_LENGTH) break;
    trimmed[key] = value;
  }
  return Object.keys(trimmed).length ? JSON.stringify(trimmed) : undefined;
}

function normalizeFilePath(value: string): string | undefined {
  const clean = oneLine(redactToolDetail(value.replace(/^file:\/\//i, '')));
  if (!clean) return undefined;
  return clean.slice(0, MAX_STEP_FILE_PATH_LENGTH);
}

function extractFiles(call: ToolCallEntry): Array<{ path: string; status?: string }> | undefined {
  const seen = new Set<string>();
  const files: Array<{ path: string; status?: string }> = [];
  const push = (rawPath: unknown, rawStatus?: unknown): void => {
    if (files.length >= MAX_STEP_FILES || typeof rawPath !== 'string') return;
    const path = normalizeFilePath(rawPath);
    if (!path || seen.has(path)) return;
    seen.add(path);
    const status = typeof rawStatus === 'string' && rawStatus.trim() ? rawStatus.trim().slice(0, 32) : undefined;
    files.push(status ? { path, status } : { path });
  };
  if (Array.isArray(call.locations)) {
    for (const location of call.locations) {
      if (typeof location === 'string') push(location);
      else {
        const record = asRecord(location);
        push(record?.path ?? record?.uri, record?.status);
      }
    }
  }
  const args = unwrapRawInput(call.rawInput);
  if (args) {
    for (const key of FILE_PATH_KEYS) push(args[key]);
    if (Array.isArray(args.paths)) {
      for (const entry of args.paths) push(entry);
    }
  }
  return files.length ? files : undefined;
}

/** Line-preserving text extraction over ACP tool content / rawOutput. */
export function extractToolOutputText(value: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 6 || parts.length >= 256 || node === null || node === undefined) return;
    if (typeof node === 'string') {
      if (node.length) parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const record = asRecord(node);
    if (!record) return;
    if (record.type === 'terminal' && !('text' in record) && !('output' in record) && !('content' in record)) {
      return;
    }
    for (const [key, nested] of Object.entries(record)) {
      if (OUTPUT_TEXT_KEYS.has(key.toLowerCase())) {
        walk(nested, depth + 1);
      }
    }
  };
  walk(value, 0);
  return parts.join('\n');
}

function sliceUtf8Head(buffer: Buffer, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let end = Math.min(maxBytes, buffer.length);
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  // Also back off if we landed in the middle of a multi-byte lead sequence whose continuation bytes were cut off.
  let text = buffer.subarray(0, end).toString('utf8');
  while (text.endsWith('\ufffd') && end > 0) {
    end -= 1;
    text = buffer.subarray(0, end).toString('utf8');
  }
  return text;
}

function sliceUtf8Tail(buffer: Buffer, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let start = Math.max(0, buffer.length - maxBytes);
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
  let text = buffer.subarray(start).toString('utf8');
  while (text.startsWith('\ufffd') && start < buffer.length) {
    start += 1;
    text = buffer.subarray(start).toString('utf8');
  }
  return text;
}

/** Keep a UTF-8-safe head + omission marker + tail within `maxBytes`, preferring line boundaries. */
export function boundStepOutputHeadTail(raw: string, maxBytes = MAX_STEP_OUTPUT_BYTES): string {
  const buffer = Buffer.from(raw, 'utf8');
  if (buffer.length <= maxBytes) return raw;
  const markerBytes = Buffer.byteLength(OUTPUT_OMISSION_MARKER, 'utf8');
  const budget = Math.max(0, maxBytes - markerBytes);
  const headBudget = Math.floor(budget * 0.45);
  const tailBudget = budget - headBudget;
  let head = sliceUtf8Head(buffer, headBudget);
  let tail = sliceUtf8Tail(buffer, tailBudget);
  const lastHeadBreak = head.lastIndexOf('\n');
  if (lastHeadBreak > head.length / 2) head = head.slice(0, lastHeadBreak);
  const firstTailBreak = tail.indexOf('\n');
  if (firstTailBreak >= 0 && firstTailBreak < tail.length / 2) tail = tail.slice(firstTailBreak + 1);
  return `${head}${OUTPUT_OMISSION_MARKER}${tail}`;
}

/** Split text into pieces no longer than the note bound, never inside a surrogate pair. */
function notePieces(text: string): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > MAX_NOTE_LENGTH) {
    let cut = MAX_NOTE_LENGTH;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces;
}

/**
 * A Room turn's steps as the activity its reply carries: each earlier text
 * run as a note and each tool call as a one-line ledger row, in the
 * turn's own order.
 *
 * Notes are the agent's words and are never cut or dropped. A run longer
 * than one note may be is split across consecutive notes (`continues`), which
 * the phone joins back into one. When the steps exceed the server's count
 * bound, the oldest tool rows give way, folded into one counted row.
 */
export function roomReplySteps(
  steps: readonly AgentTurnStep[],
  requestedBy?: { pubkey: string; name?: string },
): DaemonActivity[] {
  const pieces = steps.map((step) => (step.kind === 'note' ? notePieces(step.text) : []));
  const noteRows = pieces.reduce((sum, list) => sum + list.length, 0);
  const tools = steps.length - pieces.filter((list) => list.length).length;
  const room = Math.max(0, MAX_REPLY_STEPS - noteRows);
  // Every note first; then the newest tools, with one row counting the rest.
  const folded = noteRows + tools > MAX_REPLY_STEPS ? tools - Math.max(0, room - 1) : 0;
  const rows: DaemonActivity[] = [];
  let skipped = 0;
  steps.forEach((step, index) => {
    if (step.kind === 'note') {
      pieces[index]!.forEach((text, part) =>
        rows.push({ kind: 'note', title: 'Note', text, ...(part ? { continues: true } : {}) }),
      );
      return;
    }
    if (skipped < folded) {
      skipped += 1;
      if (skipped === folded && room > 0) {
        rows.push({
          kind: 'tool',
          title: `${folded} earlier steps`,
          operation: 'tool',
          status: 'completed',
          ...(requestedBy ? { requestedBy } : {}),
        });
      }
      return;
    }
    const call = maskCredentialResult(step.call);
    const operation = oneLine(call.kind ?? '') || 'tool';
    const mcp = normalizeMcpIdentity(call);
    const rawTitle = mcp ? `mcp.${mcp.server}.${mcp.tool}` : (call.title ?? call.name ?? '');
    const title = oneLine(redactToolDetail(rawTitle)) || `${operation} tool`;
    const identity = `${call.name ?? ''} ${call.title ?? ''} ${JSON.stringify(call.rawInput ?? {})} ${JSON.stringify(call.locations ?? [])}`;
    // Credential paths suppress output, command, input, and files regardless of the command used to access them.
    const secret = CREDENTIAL_IDENTITY_PATTERN.test(identity);
    const command = secret ? undefined : extractCommand(call);
    const input = secret ? undefined : extractInputSummary(call, command);
    const files = secret ? undefined : extractFiles(call);
    const raw = secret
      ? ''
      : redactToolDetail(extractToolOutputText(call.content) || extractToolOutputText(call.rawOutput));
    const output = secret ? 'Output hidden: contains a secret.' : boundStepOutputHeadTail(raw);
    rows.push({
      kind: 'tool',
      title: title.slice(0, 240),
      operation: operation.slice(0, 80),
      status: call.status ?? 'completed',
      ...(command ? { command } : {}),
      ...(input ? { input } : {}),
      ...(files ? { files } : {}),
      ...(output ? { output } : {}),
      ...(requestedBy ? { requestedBy } : {}),
    });
  });
  return rows;
}

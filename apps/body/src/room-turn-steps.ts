import { maskCredentialResult } from './mask-credential-result.js';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import type { AgentTurnStep, ToolCallEntry } from './acp.js';
import { redactToolDetail } from './turn-failure-reason.js';
import { extractStepFiles, stripRecognizedDisplayPrefix } from './room-turn-steps-files.js';
import {
  boundStepOutputHeadTail,
  enforceStepByteBudget,
  extractToolOutputText,
  extractToolResult,
  MAX_STEP_AGGREGATE_BYTES,
  MAX_STEP_OUTPUT_BYTES,
  type ExecutionOutcome,
} from './room-turn-steps-result.js';

export {
  boundStepOutputHeadTail,
  extractToolOutputText,
  MAX_STEP_AGGREGATE_BYTES,
  MAX_STEP_OUTPUT_BYTES,
};

type DaemonActivity = DaemonOperationMap['postAgentActivity']['input']['activity'][number];

/** The server's bounds on a reply's steps (`answer-activity.ts`). */
export const MAX_REPLY_STEPS = 2_000;
export const MAX_NOTE_LENGTH = 16_000;
/** Safe aggregate serialized reply cap below server `MAX_REPLY_STEPS_BYTES` (4,000,000). */
export const MAX_REPLY_TOTAL_BYTES = 3_800_000;
const MAX_STEP_COMMAND_LENGTH = 500;
const MAX_STEP_INPUT_LENGTH = 500;
const MAX_STEP_INPUT_VALUE_LENGTH = 160;
const MAX_STEP_SUMMARY_LENGTH = 200;

const KNOWN_MCP_SERVERS = [
  'beeline-readonly-mcp',
  'beeline_readonly_mcp',
  'beeline-agent',
  'beeline_agent',
  'codegraph',
  'squire',
] as const;

const INPUT_SUMMARY_KEYS = [
  'app',
  'tool',
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
  'Path',
  'target',
  'url',
  'room',
  'roomId',
  'address',
  'agent',
  'slug',
  'mode',
  'scope',
  'service',
  'kind',
  'type',
  'reason',
  'recipient',
  'recipients',
  'state',
  'quoteMsgId',
  'description',
  'toolSummary',
  'Role',
  'TypeName',
  'role',
  'subagent_type',
  'Prompt',
  'prompt',
  'text',
] as const;

const CREDENTIAL_IDENTITY_PATTERN =
  /fetch_credential|read_credential|raw_credential|[._]netrc\b|\.pgpass\b|\.git-credentials\b|\.npmrc\b|\.pypirc\b|\.docker[\\/]+config\.json\b|\.aws[\\/]+credentials\b|\.env|(?:(?<![a-z0-9_])credentials\b|credentials\.(?:json|ya?ml|toml|txt|ini|xml|env)|[\\/]+credentials\b)|\bid_[a-z0-9_]+\b|\.(?:pem|key)\b|private.?key/i;

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
  if (
    typeof call.rawInput === 'string' &&
    !call.rawInput.trim().startsWith('{') &&
    !/^\*\*\*\s+(?:Begin Patch|(?:Update|Add|Delete) File:)/.test(call.rawInput.trim())
  ) {
    const trimmed = preserveLines(redactToolDetail(call.rawInput));
    if (trimmed) return trimmed.slice(0, MAX_STEP_COMMAND_LENGTH);
  }
  return undefined;
}

function extractSummary(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const raw =
    (typeof args.description === 'string' && args.description.trim()) ||
    (typeof args.toolSummary === 'string' && args.toolSummary.trim()) ||
    undefined;
  if (!raw) return undefined;
  const clean = oneLine(stripRecognizedDisplayPrefix(redactToolDetail(raw)));
  return clean ? clean.slice(0, MAX_STEP_SUMMARY_LENGTH) : undefined;
}

function sanitizeInputValue(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    const redacted =
      key === 'text' ? preserveLines(redactToolDetail(value)) : oneLine(redactToolDetail(value));
    if (!redacted) return undefined;
    const limit = key === 'text' ? MAX_STEP_INPUT_LENGTH - 80 : MAX_STEP_INPUT_VALUE_LENGTH;
    return redacted.length > limit ? `${redacted.slice(0, limit - 1)}…` : redacted;
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

function sanitizeScalarArgs(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, entry] of Object.entries(record)) {
    if (count >= 6) break;
    const sanitized = sanitizeInputValue(entry);
    if (sanitized !== undefined) {
      out[key] = sanitized;
      count += 1;
    }
  }
  return count ? out : undefined;
}

function extractInputSummary(
  args: Record<string, unknown> | undefined,
  command: string | undefined,
): string | undefined {
  if (!args) return undefined;
  const picked: Record<string, unknown> = {};
  for (const key of INPUT_SUMMARY_KEYS) {
    if (!(key in args)) continue;
    const sanitized = sanitizeInputValue(args[key], key);
    if (sanitized !== undefined) picked[key] = sanitized;
  }
  if ('args' in args) {
    const nestedArgs = sanitizeScalarArgs(args.args);
    if (nestedArgs) picked.args = nestedArgs;
  }
  if (!Object.keys(picked).length) return undefined;
  const serialized = JSON.stringify(picked);
  if (command && serialized === JSON.stringify({ command })) return undefined;
  if (serialized.length <= MAX_STEP_INPUT_LENGTH) return serialized;
  const entries = Object.entries(picked);
  const trimmed: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const candidate = JSON.stringify({ ...trimmed, [key]: value });
    if (candidate.length > MAX_STEP_INPUT_LENGTH) {
      if (key === 'text' && typeof value === 'string') {
        const overhead = JSON.stringify({ ...trimmed, text: '' }).length;
        const room = MAX_STEP_INPUT_LENGTH - overhead - 4;
        if (room > 24) trimmed.text = `${value.slice(0, room - 1)}…`;
      }
      break;
    }
    trimmed[key] = value;
  }
  return Object.keys(trimmed).length ? JSON.stringify(trimmed) : undefined;
}

function extractPlan(
  call: ToolCallEntry,
  args: Record<string, unknown> | undefined,
): DaemonActivity['plan'] | undefined {
  if (!args) return undefined;
  const rawList = Array.isArray(args.todos)
    ? args.todos
    : call.kind === 'plan' || call.name === 'plan'
      ? (Array.isArray(args.items) ? args.items : Array.isArray(args.entries) ? args.entries : [])
      : [];
  if (!rawList.length) return undefined;
  const items: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }> = [];
  for (const entry of rawList.slice(0, 40)) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const rawStep =
      (typeof rec.step === 'string' && rec.step) ||
      (typeof rec.content === 'string' && rec.content) ||
      (typeof rec.title === 'string' && rec.title) ||
      '';
    const step = oneLine(redactToolDetail(rawStep)).slice(0, 200);
    if (!step) continue;
    const rawStatus = typeof rec.status === 'string' ? rec.status.toLowerCase() : '';
    const status: 'pending' | 'in_progress' | 'completed' =
      rawStatus === 'completed' || rawStatus === 'done'
        ? 'completed'
        : rawStatus === 'in_progress' || rawStatus === 'in-progress' || rawStatus === 'working'
          ? 'in_progress'
          : 'pending';
    items.push({ step, status });
  }
  if (!items.length) return undefined;
  const objective =
    typeof args.objective === 'string' && args.objective.trim()
      ? oneLine(redactToolDetail(args.objective)).slice(0, 200)
      : undefined;
  return { ...(objective ? { objective } : {}), items };
}

function readExitCode(record: Record<string, unknown> | undefined): number | undefined {
  if (!record) return undefined;
  const candidate = record.exit_code ?? record.exitCode;
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) ? candidate : undefined;
}

function readSignal(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined;
  const candidate = record.signal;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim().slice(0, 32) : undefined;
}

function extractExecutionOutcome(call: ToolCallEntry): ExecutionOutcome {
  const rawOut = asRecord(call.rawOutput);
  const meta = asRecord(rawOut?._meta);
  const terminalExit = asRecord(meta?.terminal_exit) ?? asRecord(rawOut?.terminal_exit);
  const metadata = asRecord(rawOut?.metadata);

  let exitCode = readExitCode(rawOut) ?? readExitCode(terminalExit) ?? readExitCode(metadata);
  let signal = readSignal(rawOut) ?? readSignal(terminalExit) ?? readSignal(metadata);

  if ((exitCode === undefined || signal === undefined) && Array.isArray(call.content)) {
    for (const item of call.content) {
      const rec = asRecord(item);
      if (rec?.type === 'terminal') {
        exitCode ??= readExitCode(rec);
        signal ??= readSignal(rec);
      }
    }
  }

  const isError =
    rawOut?.isError === true ||
    rawOut?.is_error === true ||
    signal !== undefined ||
    (exitCode !== undefined && exitCode !== 0);

  return {
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(signal !== undefined ? { signal } : {}),
    isError,
  };
}

function resolvedStepStatus(call: ToolCallEntry, outcome = extractExecutionOutcome(call)): string {
  if (call.status && call.status !== 'completed') return call.status;
  if (outcome.isError) return 'failed';
  return call.status ?? 'completed';
}

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
 * run as a note and each tool call as a ledger row, in the turn's own order.
 * Notes are never cut or dropped; oldest tool rows fold when count or total
 * serialized UTF-8 bytes exceed server bounds.
 */
export function roomReplySteps(
  steps: readonly AgentTurnStep[],
  requestedBy?: { pubkey: string; name?: string },
): DaemonActivity[] {
  const pieces = steps.map((step) => (step.kind === 'note' ? notePieces(step.text) : []));
  const noteRows = pieces.reduce((sum, list) => sum + list.length, 0);
  const tools = steps.length - pieces.filter((list) => list.length).length;
  const room = Math.max(0, MAX_REPLY_STEPS - noteRows);
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
    const title =
      oneLine(stripRecognizedDisplayPrefix(redactToolDetail(rawTitle))) || `${operation} tool`;
    const identity = `${call.name ?? ''} ${call.title ?? ''} ${JSON.stringify(call.rawInput ?? {})} ${JSON.stringify(call.locations ?? [])}`;
    const secret = CREDENTIAL_IDENTITY_PATTERN.test(identity);
    const outcome = extractExecutionOutcome(call);
    const args = secret ? undefined : unwrapRawInput(call.rawInput);
    const command = secret ? undefined : extractCommand(call);
    const input = secret ? undefined : extractInputSummary(args, command);
    const summary = secret ? undefined : extractSummary(args);
    const files = secret ? undefined : extractStepFiles(call, args);
    const plan = secret ? undefined : extractPlan(call, args);
    const result = secret ? undefined : extractToolResult(call, outcome);
    const output = secret ? 'Output hidden: contains a secret.' : result?.output;
    const keepBlocks =
      result &&
      result.blocks.length > 0 &&
      (result.blocks.length > 1 || result.blocks[0]!.kind !== 'text');

    const rawRow: DaemonActivity = {
      kind: 'tool',
      title: title.slice(0, 240),
      operation: operation.slice(0, 80),
      status: resolvedStepStatus(call, outcome),
      ...(summary ? { summary } : {}),
      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
      ...(outcome.signal ? { signal: outcome.signal } : {}),
      ...(result?.outputTruncated ? { outputTruncated: true } : {}),
      ...(result?.omittedCount ? { omittedCount: result.omittedCount } : {}),
      ...(result?.terminalOnly ? { terminalOnly: true } : {}),
      ...(secret ? { outputHidden: true } : {}),
      ...(result?.sanitized ? { sanitized: true } : {}),
      ...(call.origin ? { origin: call.origin } : {}),
      ...(command ? { command } : {}),
      ...(input ? { input } : {}),
      ...(files ? { files } : {}),
      ...(plan ? { plan } : {}),
      ...(output ? { output } : {}),
      ...(keepBlocks ? { blocks: result.blocks } : {}),
      ...(requestedBy ? { requestedBy } : {}),
    };
    rows.push(enforceStepByteBudget(rawRow));
  });

  if (Buffer.byteLength(JSON.stringify(rows), 'utf8') <= MAX_REPLY_TOTAL_BYTES) {
    return rows;
  }

  const noteBytes = rows
    .filter((row) => row.kind === 'note')
    .reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row), 'utf8') + 1, 2);
  let remainingToolBudget = Math.max(0, MAX_REPLY_TOTAL_BYTES - noteBytes - 256);

  const keptFlags = rows.map((row) => row.kind === 'note');
  let foldedExtra = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (row.kind === 'note') continue;
    const cost = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
    if (cost <= remainingToolBudget) {
      keptFlags[i] = true;
      remainingToolBudget -= cost;
    } else {
      const compact: DaemonActivity = {
        kind: 'tool',
        title: row.title,
        ...(row.operation ? { operation: row.operation } : {}),
        ...(row.status ? { status: row.status } : {}),
        ...(row.summary ? { summary: row.summary } : {}),
        ...(row.exitCode !== undefined ? { exitCode: row.exitCode } : {}),
        ...(row.signal ? { signal: row.signal } : {}),
        ...(row.origin ? { origin: row.origin } : {}),
        outputTruncated: true,
      };
      const compactCost = Buffer.byteLength(JSON.stringify(compact), 'utf8') + 1;
      if (compactCost <= remainingToolBudget) {
        rows[i] = compact;
        keptFlags[i] = true;
        remainingToolBudget -= compactCost;
      } else {
        foldedExtra += 1;
      }
    }
  }

  const boundedRows: DaemonActivity[] = [];
  let insertedFoldRow = false;
  for (let i = 0; i < rows.length; i += 1) {
    if (keptFlags[i]) {
      boundedRows.push(rows[i]!);
    } else if (!insertedFoldRow && foldedExtra > 0) {
      insertedFoldRow = true;
      boundedRows.push({
        kind: 'tool',
        title: `${foldedExtra} earlier steps`,
        operation: 'tool',
        status: 'completed',
        ...(requestedBy ? { requestedBy } : {}),
      });
    }
  }
  return boundedRows;
}

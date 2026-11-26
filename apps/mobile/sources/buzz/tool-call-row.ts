import type { TurnActivityAction } from './activity-timeline';
import {
  describeMcpCall,
  displayFilePath,
  parseMcpTool,
  peelShellCommand,
  redactDisplayPaths,
} from './tool-call-classify';

/**
 * What a tool call *is*, for the one-line tool ledger (tool-ledger.ts).
 *
 * This module maps a call's unwrapped command, MCP operation, or file target
 * to its ledger verb, compact label, duration, and cleaned output.
 */

/** The object column truncates in the MIDDLE: the flags at the end carry the meaning. */
export const TOOL_CALL_OBJECT_MAX = 56;
/** The ledger line's label cap (owner-approved tool-ledger design, 2026-08-24). */
const TOOL_CALL_LABEL_MAX = 40;
/** Structured MCP receipts keep enough room for target, timing, and causal provenance. */
const TOOL_CALL_RECEIPT_LABEL_MAX = 120;
/** A duration is only worth a column when the call was slow enough to notice. */
export const TOOL_CALL_DURATION_FLOOR_MS = 1000;

/** ACP tool kinds (and the folded-summary verbs) -> the one-word verb column. */
const KIND_VERBS: Readonly<Record<string, string>> = {
  read: 'read',
  open: 'read',
  search: 'found',
  searched: 'found',
  grep: 'found',
  fetch: 'fetched',
  fetched: 'fetched',
  list: 'listed',
  listed: 'listed',
  inspected: 'read',
  edit: 'wrote',
  write: 'wrote',
  create: 'wrote',
  patch: 'wrote',
  move: 'moved',
  delete: 'deleted',
  execute: 'ran',
  ran: 'ran',
};

/** Generic human-readable verbs displayed in the row's leading meta column. */
const GENERIC_LEDGER_VERBS = new Set([
  ...Object.values(KIND_VERBS),
  'git',
  'checked',
  'created',
  'updated',
  'paused',
  'resumed',
  'replied',
  'reported',
  'sent',
  'opened',
  'closed',
  'claimed',
  'approved',
  'saved',
  'used',
  'posted',
  'connected',
  'prepared',
  'requested',
  'stopped',
  'dispatched',
  'set',
  'released',
  'revised',
  'installed',
  'renamed',
  'cleared',
  'asked',
]);

/** A folded rollup row from an older transcript: `reading 8` is 8 read calls. */
const PARTICIPLE_VERBS: Readonly<Record<string, string>> = {
  reading: 'read',
  searching: 'found',
  listing: 'listed',
  fetching: 'fetched',
  inspecting: 'read',
  querying: 'found',
  running: 'ran',
};

/** Verb words the harness leads its own titles with, stripped off the object. */
const TITLE_VERB =
  /^(?:read|ran|run|wrote|write|edited?|searched(?:\s+for)?|listed|fetched|inspected|reasoned\s+about|opened|updated|reviewed)\s+/i;

const GENERIC_SHELL_TITLES =
  /^(?:bash|sh|zsh|shell|terminal|execute|command|exec_command|run_command|tool)$/i;

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Format a possibly multiline shell command onto one readable row line without gluing lines together. */
function singleLineCommand(command: string): string {
  return command
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('; ');
}

/**
 * Keep the head AND the tail. `npm run test -- --coverage --reporter=json`
 * truncated at the end is just `npm run test --…`, which is every test command
 * in the repo; the flags are the half that says which one this was.
 */
export function middleTruncate(value: string, limit = TOOL_CALL_OBJECT_MAX): string {
  const clean = oneLine(value);
  if (clean.length <= limit) return clean;
  const keep = Math.max(2, limit - 1);
  const head = Math.ceil(keep / 2);
  return `${clean.slice(0, head).trimEnd()}…${clean.slice(clean.length - (keep - head)).trimStart()}`;
}

function parsed(value: string | undefined): unknown {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function field(value: unknown, keys: readonly string[]): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function searchPattern(step: TurnActivityAction): string | undefined {
  const fromInput = field(parsed(step.input), ['pattern', 'query', 'regex', 'q', 'search']);
  if (fromInput) return fromInput;
  if (step.input && !step.input.trim().startsWith('{')) return step.input;
  return undefined;
}

/** `12 matches` in the tool's own result — never a count the client invented. */
function hitCount(output: readonly string[]): string | undefined {
  for (const line of output) {
    const hits = line.match(/\b(\d+)\s+(?:matches?|results?|hits?)\b/i);
    if (hits) return `${hits[1]} hits`;
  }
  return undefined;
}

const TEXT_KEYS = [
  'formatted_output',
  'stdout',
  'stderr',
  'output',
  'text',
  'content',
  'message',
  'result',
] as const;

function textLeaves(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(textLeaves);
  if (value && typeof value === 'object') {
    return TEXT_KEYS.flatMap((key) =>
      key in (value as Record<string, unknown>)
        ? textLeaves((value as Record<string, unknown>)[key])
        : [],
    );
  }
  return [];
}

/** Older rows could be cut in the middle of a JSON string. Recover only the
 * known output field, stopping at its closing quote or the end of the row. */
function legacyTruncatedText(raw: string): string | undefined {
  const match =
    /"(?:formatted_output|stdout|stderr|output|text|content|message|result)"\s*:\s*"/.exec(raw);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  let encoded = '';
  for (let index = start; index < raw.length; index++) {
    const char = raw[index]!;
    if (char === '"') break;
    if (char === '\\' && index + 1 < raw.length) {
      encoded += char + raw[++index];
    } else {
      encoded += char;
    }
  }
  // Decode a complete escape at a time. A dangling escape or partial unicode
  // escape remains literal instead of making the entire legacy row disappear.
  return encoded.replace(/\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (escape) => {
    try {
      return JSON.parse(`"${escape}"`) as string;
    } catch {
      return escape;
    }
  });
}

function isTerminalOnlyEnvelope(value: unknown): boolean {
  const items = Array.isArray(value) ? value : [value];
  return (
    items.length > 0 &&
    items.every(
      (entry) =>
        Boolean(entry) &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>).type === 'terminal' &&
        !('text' in (entry as Record<string, unknown>)) &&
        !('output' in (entry as Record<string, unknown>)) &&
        !('content' in (entry as Record<string, unknown>)),
    )
  );
}

/**
 * The call's real output, or nothing.
 *
 * A terminal-backed execute returns `[{"type":"terminal","terminalId":"exec-…"}]`
 * — a machine identifier the reader can do nothing with. Showing nothing is the
 * honest rendering of "we were handed a handle, not a result". Structured JSON
 * results (such as Beeline MCP state receipts and schedule lists) are formatted
 * cleanly rather than discarded.
 */
export function toolCallOutput(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const envelope = parsed(raw);
  let text: string;
  if (envelope === undefined) {
    text = legacyTruncatedText(raw) ?? raw;
  } else {
    const leaves = textLeaves(envelope);
    if (leaves.length) {
      const joined = leaves.join('\n');
      const inner = parsed(joined);
      text =
        inner !== undefined && typeof inner === 'object' && inner !== null
          ? JSON.stringify(inner, null, 2)
          : joined;
    } else if (isTerminalOnlyEnvelope(envelope)) {
      return [];
    } else {
      text = JSON.stringify(envelope, null, 2);
    }
  }
  if (!text.trim()) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trimEnd());
}

/** `1.4s`, `2m 05s` — tabular, and only ever shown above the floor. */
export function formatToolCallDuration(ms: number | undefined): string | undefined {
  if (!ms || ms < TOOL_CALL_DURATION_FLOOR_MS) return undefined;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

function verbAndObject(step: TurnActivityAction, output: readonly string[]) {
  const kind = step.toolKind?.toLowerCase();
  const mcp = parseMcpTool(step.title, step.command, step.input);
  const file =
    step.files?.[0]?.path ??
    field(parsed(step.input), ['path', 'file_path', 'filePath', 'filename']);

  if (mcp) {
    const described = describeMcpCall(mcp, step.input, step.command, step.output);
    return {
      verb: described.verb,
      object: described.object,
      namedTool: described.namedTool,
      hasReceipt: Boolean(described.receipt),
    };
  }

  if (step.command) {
    const command = singleLineCommand(peelShellCommand(step.command));
    const git = command.match(/^git\s+(.+)$/i);
    if (git) return { verb: 'git', object: redactDisplayPaths(git[1] ?? command) };
    return { verb: 'ran', object: redactDisplayPaths(command) };
  }

  if (kind === 'search' || kind === 'searched' || kind === 'grep') {
    const pattern = searchPattern(step);
    const hits = hitCount(output);
    const object = [pattern, hits].filter(Boolean).join(' · ');
    return { verb: 'found', object: object || titleObject(step) };
  }

  if (kind === 'execute' && step.title && !GENERIC_SHELL_TITLES.test(oneLine(step.title))) {
    const peeled = singleLineCommand(peelShellCommand(step.title));
    const git = peeled.match(/^git\s+(.+)$/i);
    if (git) return { verb: 'git', object: redactDisplayPaths(git[1] ?? peeled) };
    return { verb: 'ran', object: redactDisplayPaths(peeled) };
  }

  if (kind && KIND_VERBS[kind] && file) {
    return { verb: KIND_VERBS[kind], object: displayFilePath(file) };
  }
  if (file) {
    return { verb: KIND_VERBS[kind ?? ''] ?? 'read', object: displayFilePath(file) };
  }

  const rollup = oneLine(step.title).match(/^(\w+ing)\s+(\d+)$/i);
  if (rollup) {
    const participle = rollup[1]?.toLowerCase() ?? '';
    return {
      verb: PARTICIPLE_VERBS[participle] ?? KIND_VERBS[kind ?? ''] ?? 'ran',
      object: `${rollup[2]} calls`,
    };
  }
  return { verb: KIND_VERBS[kind ?? ''] ?? 'ran', object: titleObject(step) };
}

/** The harness title, stripped of the verb the column already carries. */
function titleObject(step: TurnActivityAction): string {
  const title = redactDisplayPaths(
    oneLine(step.title)
      .replace(/^#+\s*/, '')
      .replace(/^\*\*|\*\*$/g, ''),
  );
  return title.replace(TITLE_VERB, '') || title;
}

/** The action word shown beside a tool's machine text. */
export function toolCallVerb(step: TurnActivityAction): string {
  return verbAndObject(step, toolCallOutput(step.output)).verb;
}

/**
 * The ledger line's label (owner-approved tool-ledger design, 2026-08-24): the
 * call's object — the command, the file, the search pattern with its hit
 * count — cut to the label cap. The row displays the generic action separately,
 * so its label omits that word. Tool-specific names remain part of the label.
 */
export function toolCallLabel(step: TurnActivityAction): string {
  const output = toolCallOutput(step.output);
  const { verb, object, namedTool, hasReceipt } = verbAndObject(step, output);
  const generic = !namedTool && GENERIC_LEDGER_VERBS.has(verb);
  const label = generic ? object : `${verb} ${object}`;
  const limit = hasReceipt ? TOOL_CALL_RECEIPT_LABEL_MAX : TOOL_CALL_LABEL_MAX;
  return middleTruncate(oneLine(label) || 'tool call', limit);
}

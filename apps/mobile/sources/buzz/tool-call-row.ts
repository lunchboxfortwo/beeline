import type { TurnActivityAction } from './activity-timeline';
import {
  describeMcpCall,
  displayFileLocation,
  displayFilePath,
  parseMcpTool,
  peelShellCommand,
  redactDisplayPaths,
  stripRecognizedDisplayPrefix,
} from './tool-call-classify';
import type { ToolIdentityLookup } from './tool-identity-lookup';
import { cleanToolOutputText } from './tool-output-format';

/**
 * What a tool call *is*, for the universal 3-part tool ledger row (tool-ledger.ts).
 *
 * Maps a call's unwrapped command, MCP operation, file locations, or specific
 * summary to its ledger verb, 2-line-wrappable subject, quiet right stat, and
 * full unwrapped sheet title.
 */

export const TOOL_CALL_OBJECT_MAX = 240;
const TOOL_CALL_LABEL_SAFETY_MAX = 240;
/** A duration is only worth a column when the call was slow enough to notice. */
export const TOOL_CALL_DURATION_FLOOR_MS = 1000;

/** ACP tool kinds (and the folded-summary verbs) -> the one-word verb column. */
const KIND_VERBS: Readonly<Record<string, string>> = {
  read: 'read',
  open: 'read',
  search: 'searched',
  searched: 'searched',
  grep: 'searched',
  fetch: 'fetched',
  fetched: 'fetched',
  list: 'listed',
  listed: 'listed',
  inspected: 'read',
  edit: 'edited',
  write: 'wrote',
  create: 'wrote',
  patch: 'edited',
  move: 'moved',
  delete: 'deleted',
  execute: 'ran',
  ran: 'ran',
};

/** Generic human-readable verbs displayed in the row's leading meta column. */
const GENERIC_LEDGER_VERBS = new Set([
  ...Object.values(KIND_VERBS),
  'wrote',
  'edited',
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
  'loaded',
  'searched',
]);

/** A folded rollup row from an older transcript: `reading 8` is 8 read calls. */
const PARTICIPLE_VERBS: Readonly<Record<string, string>> = {
  reading: 'read',
  searching: 'searched',
  listing: 'listed',
  fetching: 'fetched',
  inspecting: 'read',
  querying: 'searched',
  running: 'ran',
};

/** Verb words the harness leads its own titles with, stripped off the object. */
const TITLE_VERB =
  /^(?:read|ran|run|wrote|write|edited?|searched(?:\s+for)?|listed|fetched|inspected|reasoned\s+about|opened|updated|reviewed)\s+/i;

const GENERIC_SHELL_TITLES =
  /^(?:bash|sh|zsh|shell|terminal|execute|command|exec_command|run_command|tool)$/i;

const GENERIC_SUMMARY_PATTERN =
  /^(?:run(?:ning)?\s+(?:a\s+)?(?:shell\s+)?command|execute\s+(?:shell\s+)?command|shell\s+command|bash\s+command|tool\s+call|read\s+file|edit\s+file|write\s+file|search\s+files?)$/i;

const INLINE_SCRIPT_PATTERN =
  /^(?:python3?|node|ruby|perl|php|bash|sh|zsh|pwsh|powershell)\s+(?:-[a-zA-Z]*[ce]|--eval)\b/i;

export type ToolRowStat =
  | { kind: 'signal'; text: string }
  | { kind: 'exit'; text: string }
  | { kind: 'diff'; added: number; removed: number }
  | { kind: 'text'; text: string };

export type ToolSearchScope = 'web' | 'code' | 'history' | 'memory' | 'tools';

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

function tailClamp(value: string, limit = TOOL_CALL_LABEL_SAFETY_MAX): string {
  const clean = oneLine(value);
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

/**
 * Keep the head AND the tail for callers that explicitly want single-line middle clipping.
 * Step rows themselves now wrap up to 2 lines with natural tail ellipsis.
 */
export function middleTruncate(value: string, limit = 56): string {
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

/** `12 matches` in the tool's own untruncated result — never a count the client invented. */
function hitCount(output: readonly string[], truncated?: boolean): string | undefined {
  if (truncated) return undefined;
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

function legacyTruncatedText(raw: string): string | undefined {
  const match =
    /^\s*\{\s*"(?:formatted_output|stdout|stderr|output|text|content|message|result)"\s*:\s*"/.exec(
      raw,
    );
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

export function isTerminalOnlyOutput(raw: string | undefined): boolean {
  if (!raw?.trim()) return false;
  const envelope = parsed(cleanToolOutputText(raw));
  return envelope !== undefined && isTerminalOnlyEnvelope(envelope);
}

export function toolCallOutput(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const cleaned = cleanToolOutputText(raw);
  const envelope = parsed(cleaned);
  let text: string;
  if (envelope === undefined) {
    text = legacyTruncatedText(cleaned) ?? cleaned;
  } else {
    const leaves = textLeaves(envelope);
    if (leaves.length) {
      const joined = cleanToolOutputText(leaves.join('\n'));
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
  return cleanToolOutputText(text)
    .split('\n')
    .map((line) => line.trimEnd());
}

/** `1.4s`, `2m 05s` — tabular, and only ever shown above the floor. */
export function formatToolCallDuration(ms: number | undefined): string | undefined {
  if (!ms || ms < TOOL_CALL_DURATION_FLOOR_MS) return undefined;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

function specificSummary(step: TurnActivityAction): string | undefined {
  const inputObj = parsed(step.input);
  const candidate =
    step.summary ??
    field(inputObj, ['description', 'toolSummary']);
  if (!candidate) return undefined;
  const clean = oneLine(stripRecognizedDisplayPrefix(candidate));
  if (!clean || clean.length < 4 || GENERIC_SUMMARY_PATTERN.test(clean)) return undefined;
  return clean;
}

function isUnreadableInlineScript(command: string): boolean {
  const trimmed = command.trim();
  if (INLINE_SCRIPT_PATTERN.test(trimmed)) return true;
  if (trimmed.includes('\n') && trimmed.length > 80) return true;
  return trimmed.length > 110 && /[;{}()|]/.test(trimmed);
}

function formatFilesTarget(step: TurnActivityAction): string | undefined {
  const files = step.files;
  if (!files?.length) return undefined;
  const first = files[0]!;
  const primary = displayFileLocation(first);
  if (files.length === 1) return primary;
  const sameFileOtherLines = files
    .slice(1)
    .filter((f) => f.path === first.path && typeof f.line === 'number');
  if (sameFileOtherLines.length === files.length - 1 && sameFileOtherLines.length <= 2) {
    const extra = sameFileOtherLines
      .map((f) => (f.endLine && f.endLine > f.line! ? `:${f.line}–${f.endLine}` : `:${f.line}`))
      .join(', ');
    return `${primary}, ${extra}`;
  }
  return `${primary} (+${files.length - 1})`;
}

type VerbObjectResult = {
  verb: string;
  object: string;
  namedTool?: boolean;
  subjectMono?: boolean;
  replacedCommandBySummary?: boolean;
  searchHits?: string;
  searchScope?: ToolSearchScope;
};

const WEB_SEARCH_TITLE = /^(?:search[_ -]?web|web[_ -]?search|google[_ -]?search)$/i;
const LOCAL_SEARCH_TITLE = /^(?:grep|glob|ripgrep|rg|find|find_by_name|grep_search|search_files)$/i;

function isWebSearchStep(step: TurnActivityAction, inputObj: unknown): boolean {
  const title = oneLine(step.title);
  if (WEB_SEARCH_TITLE.test(title) || /\b(?:web[_ -]?search|search[_ -]?web)\b/i.test(title)) {
    return true;
  }
  if (LOCAL_SEARCH_TITLE.test(title)) return false;
  if (step.files?.length || step.command) return false;
  if (inputObj && typeof inputObj === 'object' && !Array.isArray(inputObj)) {
    const rec = inputObj as Record<string, unknown>;
    const hasQuery = typeof rec.query === 'string' && rec.query.trim().length > 0;
    const hasLocalFields =
      'pattern' in rec ||
      'regex' in rec ||
      'path' in rec ||
      'directory' in rec ||
      'glob' in rec ||
      'scope' in rec ||
      'app' in rec;
    if (hasQuery && !hasLocalFields) return true;
  }
  return false;
}

function verbAndObject(
  step: TurnActivityAction,
  output: readonly string[],
  lookup?: ToolIdentityLookup,
): VerbObjectResult {
  const kind = step.toolKind?.toLowerCase();
  const mcp = parseMcpTool(step.title, step.command, step.input);
  const filesTarget = formatFilesTarget(step);
  const inputObj = parsed(step.input);
  const inputFile = field(inputObj, [
    'path',
    'file_path',
    'filePath',
    'filename',
    'Path',
  ]);
  const fileTarget = filesTarget ?? (inputFile ? displayFilePath(inputFile) : undefined);
  const titleLower = oneLine(step.title).toLowerCase();

  if (titleLower === 'toolsearch' || titleLower === 'tool_search') {
    const query = field(inputObj, ['query', 'pattern']);
    return {
      verb: 'loaded',
      object: query ? `tools · ${query}` : 'tools',
      subjectMono: false,
      searchScope: 'tools',
    };
  }

  if (
    step.plan?.items.length ||
    kind === 'plan' ||
    titleLower === 'todowrite' ||
    titleLower === 'todo_write'
  ) {
    const items = step.plan?.items ?? [];
    const total = items.length;
    const done = items.filter((item) => item.status === 'completed').length;
    const suffix = total
      ? done > 0
        ? `plan · ${done}/${total} done`
        : `plan · ${total} ${total === 1 ? 'item' : 'items'}`
      : 'plan';
    return { verb: 'updated', object: suffix, subjectMono: false };
  }

  if (mcp) {
    const described = describeMcpCall(mcp, step.input, step.command, step.output, lookup);
    const hits =
      described.verb === 'searched' ? hitCount(output, step.outputTruncated) : undefined;
    let searchScope: ToolSearchScope | undefined;
    if (described.verb === 'searched') {
      const scope = field(inputObj, ['scope'])?.toLowerCase();
      if (scope === 'memory') searchScope = 'memory';
      else if (scope === 'history') searchScope = 'history';
      else if (mcp.tool.toLowerCase() === 'app_tool') searchScope = 'tools';
      else searchScope = 'code';
    }
    return {
      verb: described.verb,
      object: described.object,
      namedTool: described.namedTool,
      subjectMono: false,
      ...(hits ? { searchHits: hits } : {}),
      ...(searchScope ? { searchScope } : {}),
    };
  }

  if (step.command) {
    const peeled = peelShellCommand(step.command);
    const summary = specificSummary(step);
    if (summary && isUnreadableInlineScript(peeled)) {
      return {
        verb: 'ran',
        object: summary,
        subjectMono: false,
        replacedCommandBySummary: true,
      };
    }
    const command = singleLineCommand(peeled);
    const git = command.match(/^git\s+(.+)$/i);
    if (git) return { verb: 'git', object: redactDisplayPaths(git[1] ?? command), subjectMono: true };
    return { verb: 'ran', object: redactDisplayPaths(command), subjectMono: true };
  }

  if (kind === 'search' || kind === 'searched' || kind === 'grep' || WEB_SEARCH_TITLE.test(oneLine(step.title))) {
    const pattern = searchPattern(step);
    const hits = hitCount(output, step.outputTruncated);
    const web = isWebSearchStep(step, inputObj);
    return {
      verb: 'searched',
      object: pattern || titleObject(step),
      subjectMono: false,
      searchScope: web ? 'web' : 'code',
      ...(hits ? { searchHits: hits } : {}),
    };
  }

  if (kind === 'execute' && step.title && !GENERIC_SHELL_TITLES.test(oneLine(step.title))) {
    const peeled = peelShellCommand(step.title);
    const summary = specificSummary(step);
    if (summary && isUnreadableInlineScript(peeled)) {
      return {
        verb: 'ran',
        object: summary,
        subjectMono: false,
        replacedCommandBySummary: true,
      };
    }
    const single = singleLineCommand(peeled);
    const git = single.match(/^git\s+(.+)$/i);
    if (git) return { verb: 'git', object: redactDisplayPaths(git[1] ?? single), subjectMono: true };
    return { verb: 'ran', object: redactDisplayPaths(single), subjectMono: true };
  }

  if (kind && KIND_VERBS[kind] && fileTarget) {
    return { verb: KIND_VERBS[kind], object: fileTarget, subjectMono: true };
  }
  if (fileTarget) {
    const hasDiff = Boolean(step.files?.some((f) => f.diff || f.status === 'M' || f.status === 'A' || f.status === 'D'));
    return {
      verb: KIND_VERBS[kind ?? ''] ?? (hasDiff ? 'edited' : 'read'),
      object: fileTarget,
      subjectMono: true,
    };
  }

  const rollup = oneLine(step.title).match(/^(\w+ing)\s+(\d+)$/i);
  if (rollup) {
    const participle = rollup[1]?.toLowerCase() ?? '';
    return {
      verb: PARTICIPLE_VERBS[participle] ?? KIND_VERBS[kind ?? ''] ?? 'ran',
      object: `${rollup[2]} calls`,
      subjectMono: false,
    };
  }
  const summary = specificSummary(step);
  if (summary && GENERIC_SHELL_TITLES.test(oneLine(step.title))) {
    return { verb: KIND_VERBS[kind ?? ''] ?? 'ran', object: summary, subjectMono: false };
  }
  return { verb: KIND_VERBS[kind ?? ''] ?? 'ran', object: titleObject(step), subjectMono: false };
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

/** Exact right-column stat — never inferred from bounded/truncated excerpts. */
export function toolCallStat(
  step: TurnActivityAction,
  output: readonly string[],
  searchHits?: string,
): ToolRowStat | undefined {
  if (step.signal) {
    return { kind: 'signal', text: step.signal };
  }
  if (typeof step.exitCode === 'number' && step.exitCode !== 0) {
    return { kind: 'exit', text: `exit ${step.exitCode}` };
  }
  const files = step.files ?? [];
  if (
    files.length > 0 &&
    !step.outputTruncated &&
    files.every((f) => !f.diffTruncated) &&
    files.some((f) => typeof f.addedLines === 'number' || typeof f.removedLines === 'number')
  ) {
    const added = files.reduce((sum, f) => sum + (f.addedLines ?? 0), 0);
    const removed = files.reduce((sum, f) => sum + (f.removedLines ?? 0), 0);
    if (added > 0 || removed > 0) {
      return { kind: 'diff', added, removed };
    }
  }
  if (searchHits) {
    return { kind: 'text', text: searchHits };
  }
  const duration = formatToolCallDuration(step.durationMs);
  if (duration) {
    return { kind: 'text', text: duration };
  }
  if (step.toolKind === 'search' || step.toolKind === 'grep') {
    const hits = hitCount(output, step.outputTruncated);
    if (hits) return { kind: 'text', text: hits };
  }
  return undefined;
}

export function toolCallRowModel(
  step: TurnActivityAction,
  lookup?: ToolIdentityLookup,
): {
  verb: string;
  label: string;
  sheetTitle: string;
  subjectMono: boolean;
  replacedCommandBySummary: boolean;
  stat?: ToolRowStat;
  searchScope?: ToolSearchScope;
} {
  const output = toolCallOutput(step.output);
  const { verb, object, namedTool, subjectMono, replacedCommandBySummary, searchHits, searchScope } =
    verbAndObject(step, output, lookup);
  const generic = !namedTool && GENERIC_LEDGER_VERBS.has(verb);
  const rawLabel = generic ? object : `${verb} ${object}`;
  const label = tailClamp(oneLine(rawLabel) || 'tool call', TOOL_CALL_LABEL_SAFETY_MAX);
  const stat = toolCallStat(step, output, searchHits);
  const sheetTitle = buildSheetTitle(step, verb, object, namedTool);
  return {
    verb,
    label,
    sheetTitle,
    subjectMono: Boolean(subjectMono),
    replacedCommandBySummary: Boolean(replacedCommandBySummary),
    ...(stat ? { stat } : {}),
    ...(searchScope ? { searchScope } : {}),
  };
}

function buildSheetTitle(
  step: TurnActivityAction,
  verb: string,
  object: string,
  namedTool?: boolean,
): string {
  const summary = specificSummary(step);
  if (summary && step.command) return summary;
  if (step.files?.some((f) => f.diff)) {
    const file = displayFileLocation(step.files[0]!);
    return `Edited ${file}`;
  }
  if (!namedTool && GENERIC_LEDGER_VERBS.has(verb)) {
    if (verb === 'ran' || verb === 'git') {
      return oneLine(object) || 'Command';
    }
    const lead = verb.charAt(0).toUpperCase() + verb.slice(1);
    return `${lead} ${oneLine(object)}`.trim();
  }
  return oneLine(`${verb} ${object}`) || 'Output';
}

/** The action word shown beside a tool's machine text. */
export function toolCallVerb(step: TurnActivityAction, lookup?: ToolIdentityLookup): string {
  return verbAndObject(step, toolCallOutput(step.output), lookup).verb;
}

/** The 2-line-wrappable ledger subject (no 40-char middle-truncation soup). */
export function toolCallLabel(step: TurnActivityAction, lookup?: ToolIdentityLookup): string {
  return toolCallRowModel(step, lookup).label;
}

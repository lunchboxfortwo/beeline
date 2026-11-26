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

const FILE_PATH_KEYS = [
  'path',
  'file_path',
  'filePath',
  'filename',
  'file',
  'target_file',
  'Path',
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

function extractInputSummary(call: ToolCallEntry, command: string | undefined): string | undefined {
  const args = unwrapRawInput(call.rawInput);
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
  // Don't repeat a single path-only or empty summary if it duplicates a command identically.
  const serialized = JSON.stringify(picked);
  if (command && serialized === JSON.stringify({ command })) return undefined;
  if (serialized.length <= MAX_STEP_INPUT_LENGTH) return serialized;
  // Drop less-essential keys from the back until within budget.
  const entries = Object.entries(picked);
  const trimmed: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const candidate = JSON.stringify({ ...trimmed, [key]: value });
    if (candidate.length > MAX_STEP_INPUT_LENGTH) {
      if (key === 'text' && typeof value === 'string') {
        const overhead = JSON.stringify({ ...trimmed, text: '' }).length;
        const room = MAX_STEP_INPUT_LENGTH - overhead - 4;
        if (room > 24) {
          trimmed.text = `${value.slice(0, room - 1)}…`;
        }
      }
      break;
    }
    trimmed[key] = value;
  }
  return Object.keys(trimmed).length ? JSON.stringify(trimmed) : undefined;
}

function normalizeFilePath(value: string): string | undefined {
  const clean = oneLine(redactToolDetail(value.replace(/^file:\/\//i, '')));
  if (!clean) return undefined;
  return clean.slice(0, MAX_STEP_FILE_PATH_LENGTH);
}

function buildUnifiedDiff(oldText: string, newText: string): string | undefined {
  const oldClean = redactToolDetail(oldText.replace(/\r\n?/g, '\n'));
  const newClean = redactToolDetail(newText.replace(/\r\n?/g, '\n'));
  if (oldClean === newClean) return undefined;
  const oldLines = oldClean ? oldClean.split('\n') : [];
  const newLines = newClean ? newClean.split('\n') : [];
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const ctxBefore = Math.min(2, prefix);
  const ctxAfter = Math.min(2, suffix);
  const oldStartIdx = prefix - ctxBefore;
  const oldEndIdx = oldLines.length - suffix + ctxAfter;
  const newStartIdx = prefix - ctxBefore;
  const newEndIdx = newLines.length - suffix + ctxAfter;
  const oldCount = oldEndIdx - oldStartIdx;
  const newCount = newEndIdx - newStartIdx;
  const out: string[] = [
    `@@ -${oldStartIdx + 1},${oldCount} +${newStartIdx + 1},${newCount} @@`,
  ];
  for (let i = oldStartIdx; i < prefix; i += 1) out.push(` ${oldLines[i]}`);
  for (let i = prefix; i < oldLines.length - suffix; i += 1) out.push(`-${oldLines[i]}`);
  for (let i = prefix; i < newLines.length - suffix; i += 1) out.push(`+${newLines[i]}`);
  for (let i = oldLines.length - suffix; i < oldEndIdx; i += 1) out.push(` ${oldLines[i]}`);
  return boundStepOutputHeadTail(out.join('\n'), MAX_STEP_OUTPUT_BYTES);
}

function redactPatchText(patchText: string): string {
  // Collapse multiline PEM private keys even when each line carries a diff prefix,
  // then redact each patch line body while keeping its leading `+`, `-`, or ` ` marker.
  const withoutPem = patchText
    .replace(/\r\n?/g, '\n')
    .replace(
      /([+\- ]?)-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
      '$1[REDACTED]',
    );
  return withoutPem
    .split('\n')
    .map((line) => {
      if (
        (line.startsWith('+') && !line.startsWith('+++')) ||
        (line.startsWith('-') && !line.startsWith('---')) ||
        line.startsWith(' ')
      ) {
        return line[0] + redactToolDetail(line.slice(1));
      }
      return redactToolDetail(line);
    })
    .join('\n');
}

function parseApplyPatchFiles(
  patchText: string,
): Array<{ path: string; status: string; diff?: string }> {
  const lines = redactPatchText(patchText).split('\n');
  const results: Array<{ path: string; status: string; diffLines: string[] }> = [];
  let current: { path: string; status: string; diffLines: string[] } | undefined;
  for (const line of lines) {
    const header = line.match(/^\*\*\*\s+(Update|Add|Delete)\s+File:\s+(.+)$/);
    if (header?.[1] && header[2]) {
      const status = header[1] === 'Add' ? 'A' : header[1] === 'Delete' ? 'D' : 'M';
      current = { path: header[2].trim(), status, diffLines: [] };
      results.push(current);
      continue;
    }
    if (/^\*\*\*\s+(?:Begin|End)\s+Patch/.test(line)) continue;
    if (/^\*\*\*\s+Move to:\s+/.test(line)) {
      if (current) current.diffLines.push(line);
      continue;
    }
    if (current) current.diffLines.push(line);
  }
  return results.map((entry) => {
    const diffBody = entry.diffLines.join('\n').trim();
    return {
      path: entry.path,
      status: entry.status,
      ...(diffBody ? { diff: boundStepOutputHeadTail(diffBody, MAX_STEP_OUTPUT_BYTES) } : {}),
    };
  });
}

function collectAcpDiffBlocks(
  value: unknown,
  into: Array<{ path: string; status: string; diff?: string }>,
  depth = 0,
): void {
  if (depth > 4 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectAcpDiffBlocks(item, into, depth + 1);
    return;
  }
  const rec = value as Record<string, unknown>;
  if (rec.type === 'diff' && typeof rec.path === 'string' && rec.path.trim()) {
    const oldText = typeof rec.oldText === 'string' ? rec.oldText : '';
    const newText = typeof rec.newText === 'string' ? rec.newText : '';
    const status = oldText ? (newText ? 'M' : 'D') : 'A';
    const diff = buildUnifiedDiff(oldText, newText);
    into.push({ path: rec.path, status, ...(diff ? { diff } : {}) });
    return;
  }
  if (rec.content) collectAcpDiffBlocks(rec.content, into, depth + 1);
}

function extractFiles(
  call: ToolCallEntry,
): Array<{ path: string; status?: string; diff?: string }> | undefined {
  const byPath = new Map<string, { path: string; status?: string; diff?: string }>();
  const upsert = (rawPath: unknown, rawStatus?: unknown, rawDiff?: string): void => {
    if (typeof rawPath !== 'string') return;
    const path = normalizeFilePath(rawPath);
    if (!path) return;
    const existing = byPath.get(path);
    if (!existing && byPath.size >= MAX_STEP_FILES) return;
    const status =
      typeof rawStatus === 'string' && rawStatus.trim() ? rawStatus.trim().slice(0, 32) : undefined;
    const next = {
      path,
      ...(existing?.status ?? status ? { status: existing?.status ?? status } : {}),
      ...(rawDiff ?? existing?.diff ? { diff: rawDiff ?? existing?.diff } : {}),
    };
    byPath.set(path, next);
  };
  if (Array.isArray(call.locations)) {
    for (const location of call.locations) {
      if (typeof location === 'string') upsert(location);
      else {
        const record = asRecord(location);
        upsert(record?.path ?? record?.uri, record?.status);
      }
    }
  }
  const acpDiffs: Array<{ path: string; status: string; diff?: string }> = [];
  collectAcpDiffBlocks(call.content, acpDiffs);
  collectAcpDiffBlocks(call.rawOutput, acpDiffs);
  for (const entry of acpDiffs) upsert(entry.path, entry.status, entry.diff);

  const args = unwrapRawInput(call.rawInput);
  if (args) {
    let primaryPath: string | undefined;
    for (const key of FILE_PATH_KEYS) {
      if (typeof args[key] === 'string' && !primaryPath) primaryPath = args[key] as string;
      upsert(args[key]);
    }
    if (Array.isArray(args.paths)) {
      for (const entry of args.paths) upsert(entry);
    }
    if (typeof args.patch === 'string' && args.patch.includes('*** ')) {
      for (const entry of parseApplyPatchFiles(args.patch)) {
        upsert(entry.path, entry.status, entry.diff);
      }
    }
    if (
      primaryPath &&
      typeof args.old_string === 'string' &&
      typeof args.new_string === 'string'
    ) {
      const diff = buildUnifiedDiff(args.old_string, args.new_string);
      if (diff) upsert(primaryPath, 'M', diff);
    }
    if (primaryPath && Array.isArray(args.edits)) {
      const hunks = args.edits
        .map((entry) => {
          const rec = asRecord(entry);
          if (typeof rec?.old_string !== 'string' || typeof rec?.new_string !== 'string') {
            return undefined;
          }
          return buildUnifiedDiff(rec.old_string, rec.new_string);
        })
        .filter((hunk): hunk is string => Boolean(hunk));
      if (hunks.length) {
        upsert(primaryPath, 'M', boundStepOutputHeadTail(hunks.join('\n'), MAX_STEP_OUTPUT_BYTES));
      }
    }
    if (primaryPath && typeof args.Target === 'string' && typeof args.Replacement === 'string') {
      const diff = buildUnifiedDiff(args.Target, args.Replacement);
      if (diff) upsert(primaryPath, 'M', diff);
    }
  } else if (typeof call.rawInput === 'string' && call.rawInput.includes('*** ')) {
    for (const entry of parseApplyPatchFiles(call.rawInput)) {
      upsert(entry.path, entry.status, entry.diff);
    }
  }
  const files = [...byPath.values()];
  return files.length ? files : undefined;
}

function extractPlan(
  call: ToolCallEntry,
): DaemonActivity['plan'] | undefined {
  const args = unwrapRawInput(call.rawInput);
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
    if (record.type === 'diff') return;
    if (record.type === 'image' || record.type === 'audio') {
      const label = record.type === 'image' ? 'Image' : 'Audio';
      const mime = typeof record.mimeType === 'string' && record.mimeType.trim() ? record.mimeType.trim() : undefined;
      parts.push(mime ? `[${label} · ${mime}]` : `[${label}]`);
      return;
    }
    if (record.type === 'resource') {
      const res = asRecord(record.resource) ?? record;
      const uri = typeof res.uri === 'string' && res.uri.trim() ? res.uri.trim() : undefined;
      parts.push(uri ? `[Resource · ${uri}]` : '[Resource]');
      if (typeof res.text === 'string' && res.text.trim()) {
        parts.push(res.text);
      }
      return;
    }
    for (const [key, nested] of Object.entries(record)) {
      if (OUTPUT_TEXT_KEYS.has(key.toLowerCase())) {
        walk(nested, depth + 1);
      }
    }
  };
  walk(value, 0);
  if (!parts.length && value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.type !== 'terminal' && record.type !== 'diff' && Object.keys(record).length > 0) {
      try {
        return JSON.stringify(record);
      } catch {
        return '';
      }
    }
  }
  return parts.join('\n');
}

function clampJsonStrings(node: unknown, maxStrLen: number, depth = 0): unknown {
  if (depth > 8) return '[…]';
  if (typeof node === 'string') {
    return node.length > maxStrLen ? `${node.slice(0, Math.max(1, maxStrLen - 1))}…` : node;
  }
  if (Array.isArray(node)) {
    return node.map((item) => clampJsonStrings(item, maxStrLen, depth + 1));
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = clampJsonStrings(v, maxStrLen, depth + 1);
    }
    return out;
  }
  return node;
}

function sliceArrayHeadTail<T>(items: readonly T[], keep: number): { kept: T[]; omitted: number } {
  if (items.length <= keep) return { kept: [...items], omitted: 0 };
  if (keep <= 1) return { kept: items.slice(0, 1), omitted: items.length - 1 };
  const headCount = Math.ceil(keep * 0.7);
  const tailCount = keep - headCount;
  return {
    kept: [...items.slice(0, headCount), ...(tailCount > 0 ? items.slice(items.length - tailCount) : [])],
    omitted: items.length - keep,
  };
}

function boundJsonValue(parsed: unknown, maxBytes: number): string | undefined {
  const fits = (candidate: unknown): string | undefined => {
    try {
      const json = JSON.stringify(candidate);
      return Buffer.byteLength(json, 'utf8') <= maxBytes ? json : undefined;
    } catch {
      return undefined;
    }
  };

  for (const strLimit of [400, 200, 100, 48]) {
    const clamped = clampJsonStrings(parsed, strLimit);
    const direct = fits(clamped);
    if (direct) return direct;

    if (Array.isArray(clamped)) {
      for (let keep = Math.min(clamped.length - 1, 20); keep >= 1; keep -= 1) {
        const { kept, omitted } = sliceArrayHeadTail(clamped, keep);
        const attempt = fits([...kept, { _omittedCount: omitted }]);
        if (attempt) return attempt;
      }
      continue;
    }

    if (clamped && typeof clamped === 'object') {
      const obj = clamped as Record<string, unknown>;
      const arrayKeys = Object.keys(obj).filter((k) => Array.isArray(obj[k]) && (obj[k] as unknown[]).length > 1);
      if (arrayKeys.length > 0) {
        const maxLen = Math.max(...arrayKeys.map((k) => (obj[k] as unknown[]).length));
        for (let keep = Math.min(maxLen - 1, 20); keep >= 1; keep -= 1) {
          const next: Record<string, unknown> = { ...obj };
          let omittedTotal = 0;
          for (const key of arrayKeys) {
            const arr = obj[key] as unknown[];
            const { kept, omitted } = sliceArrayHeadTail(arr, keep);
            next[key] = kept;
            omittedTotal += omitted;
          }
          if (omittedTotal > 0) next._omittedCount = omittedTotal;
          const attempt = fits(next);
          if (attempt) return attempt;
        }
      }
      // Trim top-level keys progressively if still over budget.
      const keys = Object.keys(obj);
      const partial: Record<string, unknown> = {};
      let keptKeys = 0;
      for (const key of keys) {
        const value = Array.isArray(obj[key])
          ? (obj[key] as unknown[]).slice(0, 1)
          : obj[key];
        const omittedKeys = keys.length - (keptKeys + 1);
        const candidate = {
          ...partial,
          [key]: value,
          ...(omittedKeys > 0 ? { _omittedCount: omittedKeys } : {}),
        };
        if (!fits(candidate)) break;
        partial[key] = value;
        keptKeys += 1;
      }
      if (keptKeys > 0) {
        const omittedKeys = keys.length - keptKeys;
        const attempt = fits({
          ...partial,
          ...(omittedKeys > 0 ? { _omittedCount: omittedKeys } : {}),
        });
        if (attempt) return attempt;
      }
    }
  }
  return undefined;
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

/**
 * Bound output within `maxBytes`. Valid JSON objects/arrays use structure-aware
 * bounding (keeping valid JSON with `_omittedCount`) before falling back to
 * UTF-8-safe head + omission marker + tail slicing.
 */
export function boundStepOutputHeadTail(raw: string, maxBytes = MAX_STEP_OUTPUT_BYTES): string {
  const buffer = Buffer.from(raw, 'utf8');
  if (buffer.length <= maxBytes) return raw;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object') {
        const boundedJson = boundJsonValue(parsed, maxBytes);
        if (boundedJson) return boundedJson;
      }
    } catch {
      // Fall through to UTF-8 head+tail slicing for non-JSON payloads.
    }
  }
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

function resolvedStepStatus(call: ToolCallEntry): string {
  const rawOut = asRecord(call.rawOutput);
  const terminalExit = asRecord(asRecord(rawOut?._meta)?.terminal_exit);
  const exitCode =
    typeof rawOut?.exit_code === 'number'
      ? rawOut.exit_code
      : typeof terminalExit?.exit_code === 'number'
        ? terminalExit.exit_code
        : undefined;
  const isErrorOutput =
    rawOut?.isError === true ||
    rawOut?.is_error === true ||
    (exitCode !== undefined && exitCode !== 0);
  if (call.status && call.status !== 'completed') return call.status;
  if (isErrorOutput) return 'failed';
  return call.status ?? 'completed';
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
    const plan = secret ? undefined : extractPlan(call);
    const raw = secret
      ? ''
      : redactToolDetail(extractToolOutputText(call.content) || extractToolOutputText(call.rawOutput));
    const output = secret ? 'Output hidden: contains a secret.' : boundStepOutputHeadTail(raw);
    rows.push({
      kind: 'tool',
      title: title.slice(0, 240),
      operation: operation.slice(0, 80),
      status: resolvedStepStatus(call),
      ...(command ? { command } : {}),
      ...(input ? { input } : {}),
      ...(files ? { files } : {}),
      ...(plan ? { plan } : {}),
      ...(output ? { output } : {}),
      ...(requestedBy ? { requestedBy } : {}),
    });
  });
  return rows;
}

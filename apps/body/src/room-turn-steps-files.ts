import type { ActivityFile } from '@beeline/api-contract/daemon';
import type { ToolCallEntry } from './acp.js';
import { redactToolDetail } from './turn-failure-reason.js';
import { boundStepOutputWithMeta, MAX_STEP_OUTPUT_BYTES } from './room-turn-steps-result.js';

const MAX_STEP_FILES = 8;
const MAX_STEP_FILE_PATH_LENGTH = 260;

const FILE_PATH_KEYS = [
  'path',
  'file_path',
  'filePath',
  'filename',
  'file',
  'target_file',
  'Path',
] as const;

/** Recognized internal Beeline sandbox/host path prefixes stripped from display labels only. */
const RECOGNIZED_DISPLAY_PREFIXES = [
  /(?:file:\/\/)?\/(?:home|Users)\/[^/\s"'`]+\/\.local\/state\/beeline\/agents\/[0-9a-f]+\/rooms\/[0-9a-f-]+\/agent-home\/(?:codex|claude|pi|user)\//gi,
  /(?:file:\/\/)?\/(?:home|Users)\/[^/\s"'`]+\/\.local\/state\/beeline\/corners\/[0-9a-f]+\//gi,
  /(?:file:\/\/)?\/(?:home|Users)\/[^/\s"'`]+\/\.local\/state\/beeline\/worktrees\/[^/\s"'`]+\//gi,
  /(?:file:\/\/)?(?:\/(?:home|Users)\/[^/\s"'`]+\/\.local\/state\/beeline\/[^/\s"'`]+\/)?agent-home\/(?:codex|claude|pi|user)\//gi,
] as const;

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Strip recognized sandbox/host prefixes from display labels without touching raw operands/hunks. */
export function stripRecognizedDisplayPrefix(value: string): string {
  let current = value;
  for (const pattern of RECOGNIZED_DISPLAY_PREFIXES) {
    current = current.replace(pattern, '');
  }
  return current;
}

export function normalizeFilePath(value: string): string | undefined {
  const stripped = stripRecognizedDisplayPrefix(value.replace(/^file:\/\//i, ''));
  const clean = oneLine(redactToolDetail(stripped));
  if (!clean) return undefined;
  return clean.slice(0, MAX_STEP_FILE_PATH_LENGTH);
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return undefined;
  return value;
}

function zeroBasedToOneBased(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value + 1;
}

function countDiffLineStats(diff: string): { addedLines: number; removedLines: number } {
  let addedLines = 0;
  let removedLines = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) addedLines += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removedLines += 1;
  }
  return { addedLines, removedLines };
}

export type BoundedDiff = {
  diff: string;
  truncated: boolean;
  addedLines?: number;
  removedLines?: number;
};

export function boundDiffBody(rawDiff: string, maxBytes = MAX_STEP_OUTPUT_BYTES): BoundedDiff | undefined {
  const trimmed = rawDiff.trim();
  if (!trimmed) return undefined;
  const bounded = boundStepOutputWithMeta(trimmed, maxBytes);
  if (bounded.truncated) {
    return { diff: bounded.text, truncated: true };
  }
  const { addedLines, removedLines } = countDiffLineStats(bounded.text);
  return {
    diff: bounded.text,
    truncated: false,
    ...(addedLines > 0 || removedLines > 0 ? { addedLines, removedLines } : {}),
  };
}

export function buildUnifiedDiff(oldText: string, newText: string): BoundedDiff | undefined {
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
  return boundDiffBody(out.join('\n'), MAX_STEP_OUTPUT_BYTES);
}

function redactPatchText(patchText: string): string {
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

type ExtractedFileDiff = {
  path: string;
  status: string;
  diff?: string;
  diffTruncated?: boolean;
  addedLines?: number;
  removedLines?: number;
};

function parseApplyPatchFiles(patchText: string): ExtractedFileDiff[] {
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
    const bounded = boundDiffBody(entry.diffLines.join('\n'), MAX_STEP_OUTPUT_BYTES);
    return {
      path: entry.path,
      status: entry.status,
      ...(bounded
        ? {
            diff: bounded.diff,
            ...(bounded.truncated ? { diffTruncated: true } : {}),
            ...(bounded.addedLines !== undefined ? { addedLines: bounded.addedLines } : {}),
            ...(bounded.removedLines !== undefined ? { removedLines: bounded.removedLines } : {}),
          }
        : {}),
    };
  });
}

function collectAcpDiffBlocks(value: unknown, into: ExtractedFileDiff[], depth = 0): void {
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
    const bounded = buildUnifiedDiff(oldText, newText);
    into.push({
      path: rec.path,
      status,
      ...(bounded
        ? {
            diff: bounded.diff,
            ...(bounded.truncated ? { diffTruncated: true } : {}),
            ...(bounded.addedLines !== undefined ? { addedLines: bounded.addedLines } : {}),
            ...(bounded.removedLines !== undefined ? { removedLines: bounded.removedLines } : {}),
          }
        : {}),
    });
    return;
  }
  if (rec.content) collectAcpDiffBlocks(rec.content, into, depth + 1);
}

function extractLocationLines(record: Record<string, unknown>): { line?: number; endLine?: number } {
  const directLine =
    positiveInt(record.line) ??
    positiveInt(record.startLine) ??
    positiveInt(record.start_line) ??
    positiveInt(record.StartLine);
  const directEnd =
    positiveInt(record.endLine) ??
    positiveInt(record.end_line) ??
    positiveInt(record.EndLine);
  if (directLine !== undefined) {
    return {
      line: directLine,
      ...(directEnd !== undefined && directEnd >= directLine ? { endLine: directEnd } : {}),
    };
  }
  const range = asRecord(record.range);
  const start = asRecord(range?.start);
  const end = asRecord(range?.end);
  const rangeLine = zeroBasedToOneBased(start?.line);
  const rangeEnd = zeroBasedToOneBased(end?.line);
  if (rangeLine !== undefined) {
    return {
      line: rangeLine,
      ...(rangeEnd !== undefined && rangeEnd >= rangeLine ? { endLine: rangeEnd } : {}),
    };
  }
  return {};
}

export function extractStepFiles(
  call: ToolCallEntry,
  args: Record<string, unknown> | undefined,
): ActivityFile[] | undefined {
  const entries = new Map<string, ActivityFile>();
  const pathIndex = new Map<string, string[]>();

  const upsert = (
    rawPath: unknown,
    opts?: {
      status?: unknown;
      diff?: string;
      diffTruncated?: boolean;
      addedLines?: number;
      removedLines?: number;
      line?: number;
      endLine?: number;
    },
  ): void => {
    if (typeof rawPath !== 'string') return;
    const path = normalizeFilePath(rawPath);
    if (!path) return;
    const line = opts?.line;
    const endLine =
      line !== undefined && opts?.endLine !== undefined && opts.endLine >= line
        ? opts.endLine
        : undefined;
    const status =
      typeof opts?.status === 'string' && opts.status.trim()
        ? opts.status.trim().slice(0, 32)
        : undefined;

    const exactKey = `${path}\0${line ?? ''}\0${endLine ?? ''}`;
    let targetKey = exactKey;

    if (!entries.has(exactKey)) {
      const samePathKeys = pathIndex.get(path) ?? [];
      if (line === undefined && samePathKeys.length > 0) {
        const pathOnlyKey = `${path}\0\0`;
        if (entries.has(pathOnlyKey)) {
          targetKey = pathOnlyKey;
        } else if (!opts?.diff && !status) {
          return;
        }
      } else if (line !== undefined) {
        const pathOnlyKey = `${path}\0\0`;
        const bare = entries.get(pathOnlyKey);
        if (bare && !bare.diff && !bare.status && samePathKeys.length === 1) {
          entries.delete(pathOnlyKey);
          pathIndex.set(path, []);
        }
      }
    }

    const existing = entries.get(targetKey);
    if (!existing && entries.size >= MAX_STEP_FILES) return;

    const diff = opts?.diff ?? existing?.diff;
    const diffTruncated = opts?.diff !== undefined ? opts.diffTruncated : existing?.diffTruncated;
    const addedLines = diffTruncated
      ? undefined
      : opts?.diff !== undefined
        ? opts.addedLines
        : existing?.addedLines;
    const removedLines = diffTruncated
      ? undefined
      : opts?.diff !== undefined
        ? opts.removedLines
        : existing?.removedLines;

    const next: ActivityFile = {
      path,
      ...(existing?.status ?? status ? { status: existing?.status ?? status } : {}),
      ...(diff ? { diff } : {}),
      ...(diffTruncated ? { diffTruncated: true } : {}),
      ...(addedLines !== undefined ? { addedLines } : {}),
      ...(removedLines !== undefined ? { removedLines } : {}),
      ...(existing?.line ?? line ? { line: existing?.line ?? line } : {}),
      ...(existing?.endLine ?? endLine ? { endLine: existing?.endLine ?? endLine } : {}),
    };
    entries.set(targetKey, next);
    const list = pathIndex.get(path) ?? [];
    if (!list.includes(targetKey)) {
      list.push(targetKey);
      pathIndex.set(path, list);
    }
  };

  if (Array.isArray(call.locations)) {
    for (const location of call.locations) {
      if (typeof location === 'string') {
        upsert(location);
      } else {
        const record = asRecord(location);
        if (!record) continue;
        upsert(record.path ?? record.uri, {
          status: record.status,
          ...extractLocationLines(record),
        });
      }
    }
  }

  const acpDiffs: ExtractedFileDiff[] = [];
  collectAcpDiffBlocks(call.content, acpDiffs);
  collectAcpDiffBlocks(call.rawOutput, acpDiffs);
  for (const entry of acpDiffs) upsert(entry.path, entry);

  if (args) {
    let primaryPath: string | undefined;
    const argLine =
      positiveInt(args.StartLine) ??
      positiveInt(args.start_line) ??
      positiveInt(args.startLine) ??
      positiveInt(args.line) ??
      positiveInt(args.offset);
    const argEndLine =
      positiveInt(args.EndLine) ?? positiveInt(args.end_line) ?? positiveInt(args.endLine);
    for (const key of FILE_PATH_KEYS) {
      if (typeof args[key] === 'string' && !primaryPath) {
        primaryPath = args[key] as string;
        upsert(primaryPath, {
          ...(argLine !== undefined ? { line: argLine } : {}),
          ...(argLine !== undefined && argEndLine !== undefined && argEndLine >= argLine
            ? { endLine: argEndLine }
            : {}),
        });
      } else {
        upsert(args[key]);
      }
    }
    if (Array.isArray(args.paths)) {
      for (const entry of args.paths) upsert(entry);
    }
    if (typeof args.patch === 'string' && args.patch.includes('*** ')) {
      for (const entry of parseApplyPatchFiles(args.patch)) upsert(entry.path, entry);
    }
    if (
      primaryPath &&
      typeof args.old_string === 'string' &&
      typeof args.new_string === 'string'
    ) {
      const bounded = buildUnifiedDiff(args.old_string, args.new_string);
      if (bounded) {
        upsert(primaryPath, {
          status: 'M',
          diff: bounded.diff,
          diffTruncated: bounded.truncated,
          addedLines: bounded.addedLines,
          removedLines: bounded.removedLines,
        });
      }
    }
    if (primaryPath && Array.isArray(args.edits)) {
      const hunks = args.edits
        .map((entry) => {
          const rec = asRecord(entry);
          if (typeof rec?.old_string !== 'string' || typeof rec?.new_string !== 'string') {
            return undefined;
          }
          return buildUnifiedDiff(rec.old_string, rec.new_string)?.diff;
        })
        .filter((hunk): hunk is string => Boolean(hunk));
      if (hunks.length) {
        const bounded = boundDiffBody(hunks.join('\n'), MAX_STEP_OUTPUT_BYTES);
        if (bounded) {
          upsert(primaryPath, {
            status: 'M',
            diff: bounded.diff,
            diffTruncated: bounded.truncated,
            addedLines: bounded.addedLines,
            removedLines: bounded.removedLines,
          });
        }
      }
    }
    if (primaryPath && typeof args.Target === 'string' && typeof args.Replacement === 'string') {
      const bounded = buildUnifiedDiff(args.Target, args.Replacement);
      if (bounded) {
        upsert(primaryPath, {
          status: 'M',
          diff: bounded.diff,
          diffTruncated: bounded.truncated,
          addedLines: bounded.addedLines,
          removedLines: bounded.removedLines,
        });
      }
    }
  } else if (typeof call.rawInput === 'string' && call.rawInput.includes('*** ')) {
    for (const entry of parseApplyPatchFiles(call.rawInput)) upsert(entry.path, entry);
  }

  const files = [...entries.values()];
  return files.length ? files : undefined;
}

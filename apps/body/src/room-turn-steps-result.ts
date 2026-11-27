import type { ActivityResultBlock, DaemonOperationMap } from '@beeline/api-contract/daemon';
import type { ToolCallEntry } from './acp.js';
import { redactToolDetail } from './turn-failure-reason.js';
import {
  buildUnifiedDiff,
  normalizeFilePath,
  stripRecognizedDisplayPrefix,
} from './room-turn-steps-files.js';

type DaemonActivity = DaemonOperationMap['postAgentActivity']['input']['activity'][number];

export const MAX_STEP_OUTPUT_BYTES = 4_096;
/** Per-step aggregate serialized UTF-8 byte cap across all fields. */
export const MAX_STEP_AGGREGATE_BYTES = 16_384;
export const MAX_STEP_BLOCKS = 12;
const MAX_JSON_DEPTH = 6;
const OUTPUT_OMISSION_MARKER = '\n[… omitted …]\n';

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

const EXECUTION_META_KEYS = new Set([
  'exit_code',
  'exitCode',
  'signal',
  '_meta',
  'metadata',
  'terminal_exit',
  'isError',
  'is_error',
  'structuredContent',
  'content',
]);

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function estimateBase64Bytes(base64: string): number {
  const clean = base64.replace(/\s+/g, '');
  if (!clean) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function clampJsonStrings(
  node: unknown,
  maxStrLen: number,
  depth = 0,
  state?: { truncated: boolean },
): unknown {
  if (depth > MAX_JSON_DEPTH) {
    if (state) state.truncated = true;
    return '[…]';
  }
  if (typeof node === 'string') {
    if (node.length > maxStrLen) {
      if (state) state.truncated = true;
      return `${node.slice(0, Math.max(1, maxStrLen - 1))}…`;
    }
    return node;
  }
  if (Array.isArray(node)) {
    const limit = 100;
    const sliced = node.length > limit ? node.slice(0, limit) : node;
    if (node.length > limit && state) state.truncated = true;
    return sliced.map((item) => clampJsonStrings(item, maxStrLen, depth + 1, state));
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(node as Record<string, unknown>);
    const limit = 60;
    if (entries.length > limit && state) state.truncated = true;
    for (const [k, v] of entries.slice(0, limit)) {
      out[k] = clampJsonStrings(v, maxStrLen, depth + 1, state);
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

type BoundedJsonResult = {
  text: string;
  truncated: boolean;
  omittedCount?: number;
};

function boundJsonValue(parsed: unknown, maxBytes: number): BoundedJsonResult | undefined {
  const fits = (candidate: unknown): string | undefined => {
    try {
      const json = JSON.stringify(candidate);
      return Buffer.byteLength(json, 'utf8') <= maxBytes ? json : undefined;
    } catch {
      return undefined;
    }
  };

  for (const strLimit of [400, 200, 100, 48]) {
    const state = { truncated: false };
    const clamped = clampJsonStrings(parsed, strLimit, 0, state);
    const direct = fits(clamped);
    if (direct) return { text: direct, truncated: state.truncated };

    if (Array.isArray(clamped)) {
      for (let keep = Math.min(clamped.length - 1, 20); keep >= 1; keep -= 1) {
        const { kept, omitted } = sliceArrayHeadTail(clamped, keep);
        const attempt = fits([...kept, { _omittedCount: omitted }]);
        if (attempt) return { text: attempt, truncated: true, omittedCount: omitted };
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
          if (attempt) {
            return {
              text: attempt,
              truncated: true,
              ...(omittedTotal > 0 ? { omittedCount: omittedTotal } : {}),
            };
          }
        }
      }
      const keys = Object.keys(obj);
      const partial: Record<string, unknown> = {};
      let keptKeys = 0;
      for (const key of keys) {
        const value = Array.isArray(obj[key]) ? (obj[key] as unknown[]).slice(0, 1) : obj[key];
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
        if (attempt) {
          return {
            text: attempt,
            truncated: true,
            ...(omittedKeys > 0 ? { omittedCount: omittedKeys } : {}),
          };
        }
      }
    }
  }
  return undefined;
}

function sliceUtf8Head(buffer: Buffer, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let end = Math.min(maxBytes, buffer.length);
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
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

export function boundStepOutputWithMeta(
  raw: string,
  maxBytes = MAX_STEP_OUTPUT_BYTES,
): { text: string; truncated: boolean; omittedCount?: number } {
  const buffer = Buffer.from(raw, 'utf8');
  const trimmed = raw.trim();
  if (buffer.length <= maxBytes) {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === 'object') {
          const state = { truncated: false };
          const clamped = clampJsonStrings(parsed, 10_000, 0, state);
          if (state.truncated) {
            const serialized = JSON.stringify(clamped);
            if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) {
              return { text: serialized, truncated: true };
            }
          }
        }
      } catch {
        // Plain text
      }
    }
    return { text: raw, truncated: false };
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object') {
        const boundedJson = boundJsonValue(parsed, maxBytes);
        if (boundedJson) return boundedJson;
      }
    } catch {
      // Non-JSON payload uses head+tail slicing below.
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
  return { text: `${head}${OUTPUT_OMISSION_MARKER}${tail}`, truncated: true };
}

export function boundStepOutputHeadTail(raw: string, maxBytes = MAX_STEP_OUTPUT_BYTES): string {
  return boundStepOutputWithMeta(raw, maxBytes).text;
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
    if (record.type === 'resource_link') {
      const uri = typeof record.uri === 'string' && record.uri.trim() ? record.uri.trim() : undefined;
      parts.push(uri ? `[Resource · ${uri}]` : '[Resource]');
      return;
    }
    if (record.type === 'resource') {
      const res = asRecord(record.resource) ?? record;
      const uri = typeof res.uri === 'string' && res.uri.trim() ? res.uri.trim() : undefined;
      parts.push(uri ? `[Resource · ${uri}]` : '[Resource]');
      if (typeof res.text === 'string' && res.text.trim()) parts.push(res.text);
      return;
    }
    for (const [key, nested] of Object.entries(record)) {
      if (OUTPUT_TEXT_KEYS.has(key.toLowerCase())) walk(nested, depth + 1);
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

export type ExecutionOutcome = {
  exitCode?: number;
  signal?: string;
  isError: boolean;
};

function canonicalJsonSignature(value: unknown): string | undefined {
  const sortKeys = (node: unknown, depth: number): unknown => {
    if (depth > 8 || node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((entry) => sortKeys(entry, depth + 1));
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(node as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((node as Record<string, unknown>)[key], depth + 1);
    }
    return sorted;
  };
  try {
    return JSON.stringify(sortKeys(value, 0));
  } catch {
    return undefined;
  }
}

function redactAndTrack(value: string, tracker: { sanitized: boolean }): string {
  const redacted = redactToolDetail(value);
  if (redacted !== value) tracker.sanitized = true;
  return redacted;
}

export type ExtractedResult = {
  blocks: ActivityResultBlock[];
  output?: string;
  outputTruncated: boolean;
  omittedCount?: number;
  terminalOnly: boolean;
  sanitized: boolean;
};

export function extractToolResult(call: ToolCallEntry, outcome: ExecutionOutcome): ExtractedResult {
  const blocks: ActivityResultBlock[] = [];
  const textSignatures = new Set<string>();
  const jsonSignatures = new Map<string, number>();
  const diffSignatures = new Set<string>();
  const tracker = { sanitized: false };
  let sawTerminalHandle = false;
  let outputTruncated = false;
  let omittedCount: number | undefined;

  const pushBlock = (block: ActivityResultBlock): void => {
    if (blocks.length >= MAX_STEP_BLOCKS) {
      outputTruncated = true;
      omittedCount = (omittedCount ?? 0) + 1;
      return;
    }
    blocks.push(block);
  };

  const addTextOrJson = (rawText: string, preferJson = false): void => {
    const redacted = redactAndTrack(rawText, tracker);
    const trimmed = redacted.trim();
    if (!trimmed) return;

    if (preferJson || trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === 'object') {
          const sig = canonicalJsonSignature(parsed);
          if (sig && jsonSignatures.has(sig)) return;
          const bounded = boundStepOutputWithMeta(trimmed, MAX_STEP_OUTPUT_BYTES);
          if (bounded.truncated) outputTruncated = true;
          if (bounded.omittedCount) omittedCount = (omittedCount ?? 0) + bounded.omittedCount;
          const idx = blocks.length;
          pushBlock({
            kind: 'json',
            text: bounded.text,
            ...(bounded.truncated ? { truncated: true } : {}),
            ...(bounded.omittedCount ? { omittedCount: bounded.omittedCount } : {}),
          });
          if (sig) jsonSignatures.set(sig, idx);
          textSignatures.add(trimmed);
          return;
        }
      } catch {
        // Plain text
      }
    }

    if (textSignatures.has(trimmed)) return;
    textSignatures.add(trimmed);
    const bounded = boundStepOutputWithMeta(redacted, MAX_STEP_OUTPUT_BYTES);
    if (bounded.truncated) outputTruncated = true;
    pushBlock({
      kind: 'text',
      text: bounded.text,
      ...(bounded.truncated ? { truncated: true } : {}),
    });
  };

  const addStructuredJson = (value: unknown): void => {
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return;
    }
    const redacted = redactAndTrack(serialized, tracker);
    let parsed: unknown = value;
    try {
      parsed = JSON.parse(redacted);
    } catch {
      // Keep redacted text directly if redaction changed syntax.
    }
    const sig = canonicalJsonSignature(parsed);
    const bounded = boundStepOutputWithMeta(redacted, MAX_STEP_OUTPUT_BYTES);
    if (bounded.truncated) outputTruncated = true;
    if (bounded.omittedCount) omittedCount = (omittedCount ?? 0) + bounded.omittedCount;

    const jsonBlock: ActivityResultBlock = {
      kind: 'json',
      text: bounded.text,
      ...(bounded.truncated ? { truncated: true } : {}),
      ...(bounded.omittedCount ? { omittedCount: bounded.omittedCount } : {}),
    };

    if (sig && jsonSignatures.has(sig)) {
      const existingIndex = jsonSignatures.get(sig)!;
      if (blocks[existingIndex]) blocks[existingIndex] = jsonBlock;
      return;
    }
    const idx = blocks.length;
    pushBlock(jsonBlock);
    if (sig) jsonSignatures.set(sig, idx);
  };

  const collectContentNode = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || node === undefined) return;
    if (typeof node === 'string') {
      addTextOrJson(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) collectContentNode(entry, depth + 1);
      return;
    }
    const record = asRecord(node);
    if (!record) return;

    const blockType = typeof record.type === 'string' ? record.type : undefined;
    if (blockType === 'content' && 'content' in record) {
      collectContentNode(record.content, depth + 1);
      return;
    }
    if (blockType === 'terminal') {
      sawTerminalHandle = true;
      for (const key of ['text', 'output', 'content']) {
        if (key in record && record[key] !== undefined) collectContentNode(record[key], depth + 1);
      }
      return;
    }
    if (blockType === 'text' && typeof record.text === 'string') {
      addTextOrJson(record.text);
      return;
    }
    if (blockType === 'diff' && typeof record.path === 'string' && record.path.trim()) {
      const oldText = typeof record.oldText === 'string' ? record.oldText : '';
      const newText = typeof record.newText === 'string' ? record.newText : '';
      const status = oldText ? (newText ? 'M' : 'D') : 'A';
      const bounded = buildUnifiedDiff(oldText, newText);
      const displayPath = normalizeFilePath(record.path) ?? record.path.trim();
      if (bounded) {
        const diffSig = `${displayPath}\0${bounded.diff}`;
        if (!diffSignatures.has(diffSig)) {
          diffSignatures.add(diffSig);
          if (bounded.truncated) outputTruncated = true;
          pushBlock({
            kind: 'diff',
            path: displayPath,
            status,
            diff: bounded.diff,
            ...(bounded.truncated ? { truncated: true } : {}),
          });
        }
      }
      return;
    }
    if (blockType === 'image' || blockType === 'audio') {
      const mimeType =
        typeof record.mimeType === 'string' && record.mimeType.trim()
          ? record.mimeType.trim().slice(0, 80)
          : undefined;
      const rawLabel =
        typeof record.alt === 'string'
          ? record.alt
          : typeof record.name === 'string'
            ? record.name
            : typeof record.title === 'string'
              ? record.title
              : undefined;
      const label = rawLabel
        ? oneLine(stripRecognizedDisplayPrefix(redactAndTrack(rawLabel, tracker))).slice(0, 120)
        : undefined;
      const sizeBytes =
        typeof record.sizeBytes === 'number' && Number.isSafeInteger(record.sizeBytes) && record.sizeBytes >= 0
          ? record.sizeBytes
          : typeof record.size === 'number' && Number.isSafeInteger(record.size) && record.size >= 0
            ? record.size
            : typeof record.data === 'string'
              ? estimateBase64Bytes(record.data)
              : undefined;
      pushBlock({
        kind: 'media',
        mediaKind: blockType,
        ...(mimeType ? { mimeType } : {}),
        ...(label ? { label } : {}),
        ...(sizeBytes !== undefined && sizeBytes > 0 ? { sizeBytes } : {}),
        available: false,
      });
      return;
    }
    if (blockType === 'resource_link') {
      const uri =
        typeof record.uri === 'string' && record.uri.trim()
          ? redactAndTrack(record.uri.trim(), tracker).slice(0, 300)
          : undefined;
      const rawName =
        typeof record.name === 'string'
          ? record.name
          : typeof record.title === 'string'
            ? record.title
            : undefined;
      const name = rawName
        ? oneLine(stripRecognizedDisplayPrefix(redactAndTrack(rawName, tracker))).slice(0, 120)
        : undefined;
      const mimeType =
        typeof record.mimeType === 'string' && record.mimeType.trim()
          ? record.mimeType.trim().slice(0, 80)
          : undefined;
      const sizeBytes =
        typeof record.size === 'number' && Number.isSafeInteger(record.size) && record.size >= 0
          ? record.size
          : undefined;
      pushBlock({
        kind: 'resource',
        mode: 'link',
        ...(uri ? { uri } : {}),
        ...(name ? { name } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      });
      return;
    }
    if (blockType === 'resource') {
      const res = asRecord(record.resource) ?? record;
      const uri =
        typeof res.uri === 'string' && res.uri.trim()
          ? redactAndTrack(res.uri.trim(), tracker).slice(0, 300)
          : undefined;
      const rawName =
        typeof res.name === 'string'
          ? res.name
          : typeof res.title === 'string'
            ? res.title
            : typeof record.name === 'string'
              ? record.name
              : undefined;
      const name = rawName
        ? oneLine(stripRecognizedDisplayPrefix(redactAndTrack(rawName, tracker))).slice(0, 120)
        : undefined;
      const mimeType =
        typeof res.mimeType === 'string' && res.mimeType.trim()
          ? res.mimeType.trim().slice(0, 80)
          : undefined;
      if (typeof res.text === 'string' && res.text.trim()) {
        const redactedText = redactAndTrack(res.text, tracker);
        const bounded = boundStepOutputWithMeta(redactedText, MAX_STEP_OUTPUT_BYTES);
        if (bounded.truncated) outputTruncated = true;
        pushBlock({
          kind: 'resource',
          mode: 'text',
          ...(uri ? { uri } : {}),
          ...(name ? { name } : {}),
          ...(mimeType ? { mimeType } : {}),
          text: bounded.text,
          ...(bounded.truncated ? { truncated: true } : {}),
        });
      } else if (typeof res.blob === 'string' && res.blob.length > 0) {
        pushBlock({
          kind: 'resource',
          mode: 'blob',
          ...(uri ? { uri } : {}),
          ...(name ? { name } : {}),
          ...(mimeType ? { mimeType } : {}),
          sizeBytes: estimateBase64Bytes(res.blob),
        });
      } else {
        pushBlock({
          kind: 'resource',
          mode: 'link',
          ...(uri ? { uri } : {}),
          ...(name ? { name } : {}),
          ...(mimeType ? { mimeType } : {}),
        });
      }
      return;
    }
    if (blockType) {
      const unknownText =
        typeof record.text === 'string'
          ? record.text
          : typeof record.summary === 'string'
            ? record.summary
            : typeof record.message === 'string'
              ? record.message
              : undefined;
      const safeText = unknownText
        ? boundStepOutputWithMeta(redactAndTrack(unknownText, tracker), 512).text
        : undefined;
      pushBlock({
        kind: 'unknown',
        rawType: blockType.slice(0, 64),
        ...(safeText ? { text: safeText } : {}),
      });
      return;
    }

    let foundTextKey = false;
    for (const [key, nested] of Object.entries(record)) {
      if (OUTPUT_TEXT_KEYS.has(key.toLowerCase())) {
        foundTextKey = true;
        collectContentNode(nested, depth + 1);
      }
    }
    if (!foundTextKey && Object.keys(record).length > 0) addStructuredJson(record);
  };

  if (call.content !== undefined) collectContentNode(call.content, 0);

  if (call.rawOutput !== undefined && call.rawOutput !== null) {
    const rawRec = asRecord(call.rawOutput);
    if (rawRec) {
      if (rawRec.content !== undefined) collectContentNode(rawRec.content, 0);
      if (rawRec.structuredContent !== undefined && rawRec.structuredContent !== null) {
        if (typeof rawRec.structuredContent === 'object') addStructuredJson(rawRec.structuredContent);
        else addTextOrJson(String(rawRec.structuredContent));
      }
      let sawOutputKey = false;
      for (const [key, nested] of Object.entries(rawRec)) {
        if (key === 'content' || key === 'structuredContent') continue;
        if (OUTPUT_TEXT_KEYS.has(key.toLowerCase()) && nested !== undefined && nested !== null) {
          sawOutputKey = true;
          collectContentNode(nested, 0);
        }
      }
      if (
        !sawOutputKey &&
        rawRec.content === undefined &&
        rawRec.structuredContent === undefined &&
        rawRec.type !== 'terminal' &&
        rawRec.type !== 'diff'
      ) {
        const meaningfulKeys = Object.keys(rawRec).filter((key) => !EXECUTION_META_KEYS.has(key));
        if (meaningfulKeys.length > 0) addStructuredJson(rawRec);
      }
    } else if (typeof call.rawOutput === 'string') {
      addTextOrJson(call.rawOutput);
    } else if (Array.isArray(call.rawOutput)) {
      collectContentNode(call.rawOutput, 0);
    }
  }

  const coalesced: ActivityResultBlock[] = [];
  for (const block of blocks) {
    const prev = coalesced.at(-1);
    if (block.kind === 'text' && prev?.kind === 'text') {
      const merged = boundStepOutputWithMeta(`${prev.text}\n${block.text}`, MAX_STEP_OUTPUT_BYTES);
      if (merged.truncated) outputTruncated = true;
      coalesced[coalesced.length - 1] = {
        kind: 'text',
        text: merged.text,
        ...(prev.truncated || block.truncated || merged.truncated ? { truncated: true } : {}),
      };
    } else {
      coalesced.push(block);
    }
  }

  const summaryParts: string[] = [];
  for (const block of coalesced) {
    if (block.kind === 'text' || block.kind === 'json') {
      summaryParts.push(block.text);
    } else if (block.kind === 'media') {
      const label = block.mediaKind === 'image' ? 'Image' : 'Audio';
      summaryParts.push(block.mimeType ? `[${label} · ${block.mimeType}]` : `[${label}]`);
    } else if (block.kind === 'resource') {
      summaryParts.push(block.uri ? `[Resource · ${block.uri}]` : '[Resource]');
      if (block.mode === 'text' && block.text) summaryParts.push(block.text);
    } else if (block.kind === 'unknown') {
      summaryParts.push(
        block.text ? `[${block.rawType ?? 'Unknown'}: ${block.text}]` : `[${block.rawType ?? 'Unknown'}]`,
      );
    }
  }
  const summaryJoined = summaryParts.join('\n').trim();
  const boundedSummary = summaryJoined
    ? boundStepOutputWithMeta(summaryJoined, MAX_STEP_OUTPUT_BYTES)
    : undefined;
  if (boundedSummary?.truncated) outputTruncated = true;

  const terminalOnly =
    sawTerminalHandle &&
    coalesced.length === 0 &&
    outcome.exitCode === undefined &&
    outcome.signal === undefined;

  return {
    blocks: coalesced,
    ...(boundedSummary?.text ? { output: boundedSummary.text } : {}),
    outputTruncated,
    ...(omittedCount ? { omittedCount } : {}),
    terminalOnly,
    sanitized: tracker.sanitized,
  };
}

/** Enforce aggregate UTF-8 byte budget on a single tool step across all fields. */
export function enforceStepByteBudget(row: DaemonActivity): DaemonActivity {
  const byteSize = (candidate: DaemonActivity): number =>
    Buffer.byteLength(JSON.stringify(candidate), 'utf8');

  if (byteSize(row) <= MAX_STEP_AGGREGATE_BYTES) return row;

  let current: DaemonActivity = { ...row };
  if (current.blocks?.length && current.output && byteSize(current) > MAX_STEP_AGGREGATE_BYTES) {
    const trimmedSummary = boundStepOutputWithMeta(current.output, 1024);
    current = { ...current, output: trimmedSummary.text, outputTruncated: true };
  }
  for (const limit of [2048, 1024, 512, 256]) {
    if (byteSize(current) <= MAX_STEP_AGGREGATE_BYTES) return current;
    if (current.blocks?.length) {
      current = {
        ...current,
        outputTruncated: true,
        blocks: current.blocks.map((block): ActivityResultBlock => {
          if (block.kind === 'text') {
            const b = boundStepOutputWithMeta(block.text, limit);
            return { ...block, text: b.text, ...(b.truncated ? { truncated: true } : {}) };
          }
          if (block.kind === 'json') {
            const b = boundStepOutputWithMeta(block.text, limit);
            return {
              ...block,
              text: b.text,
              ...(b.truncated ? { truncated: true } : {}),
              ...(b.omittedCount ? { omittedCount: b.omittedCount } : {}),
            };
          }
          if (block.kind === 'diff') {
            const b = boundStepOutputWithMeta(block.diff, limit);
            return { ...block, diff: b.text, ...(b.truncated ? { truncated: true } : {}) };
          }
          if (block.kind === 'resource' && block.mode === 'text' && block.text) {
            const b = boundStepOutputWithMeta(block.text, limit);
            return { ...block, text: b.text, ...(b.truncated ? { truncated: true } : {}) };
          }
          return block;
        }),
      };
    }
    if (current.files?.length && byteSize(current) > MAX_STEP_AGGREGATE_BYTES) {
      current = {
        ...current,
        outputTruncated: true,
        files: current.files.map((file) => {
          if (!file.diff) return file;
          const b = boundStepOutputWithMeta(file.diff, limit);
          return {
            path: file.path,
            ...(file.status ? { status: file.status } : {}),
            diff: b.text,
            ...(b.truncated ? { diffTruncated: true } : {}),
            ...(!b.truncated && file.addedLines !== undefined ? { addedLines: file.addedLines } : {}),
            ...(!b.truncated && file.removedLines !== undefined ? { removedLines: file.removedLines } : {}),
            ...(file.line !== undefined ? { line: file.line } : {}),
            ...(file.endLine !== undefined ? { endLine: file.endLine } : {}),
          };
        }),
      };
    }
    if (current.output && byteSize(current) > MAX_STEP_AGGREGATE_BYTES) {
      const b = boundStepOutputWithMeta(current.output, limit);
      current = { ...current, output: b.text, outputTruncated: true };
    }
  }
  while (current.blocks && current.blocks.length > 1 && byteSize(current) > MAX_STEP_AGGREGATE_BYTES) {
    current = {
      ...current,
      outputTruncated: true,
      omittedCount: (current.omittedCount ?? 0) + 1,
      blocks: current.blocks.slice(0, -1),
    };
  }
  return current;
}

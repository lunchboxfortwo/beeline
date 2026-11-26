import {
  formatMessageTarget,
  humanizeAppName,
  parseAgentAddress,
  sanitizeIdsInText,
  type ToolIdentityLookup,
} from './tool-identity-lookup';

const OSC_ESCAPE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OUTER_FENCE_COMPLETE = /^\s*```[a-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/i;
const OUTER_FENCE_OPEN_ONLY = /^\s*```(?:console|json|txt|text|sh|bash|zsh|diff|patch|log)?[ \t]*\r?\n([\s\S]+)$/i;

/**
 * Strip OSC terminal hyperlinks, CSI ANSI escapes, `\r` progress overwrites,
 * and outer markdown code fences (` ```console `, ` ```json `) before JSON or
 * text rendering.
 */
export function cleanToolOutputText(raw: string): string {
  const withoutEscapes = raw.replace(OSC_ESCAPE, '').replace(CSI_ESCAPE, '');
  const collapsedCr = withoutEscapes
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const cleaned = line.replace(/\r$/, '');
      if (!cleaned.includes('\r')) return cleaned;
      const segments = cleaned.split('\r');
      for (let i = segments.length - 1; i >= 0; i -= 1) {
        if (segments[i]!.length > 0) return segments[i]!;
      }
      return '';
    })
    .join('\n');
  const completeFence = collapsedCr.match(OUTER_FENCE_COMPLETE);
  if (completeFence?.[1] !== undefined) return completeFence[1];
  const openFence = collapsedCr.match(OUTER_FENCE_OPEN_ONLY);
  if (openFence?.[1] !== undefined) return openFence[1];
  return collapsedCr;
}

export type ParsedJsonResult = {
  value: unknown;
  truncated: boolean;
  bounded: boolean;
  omittedCount?: number;
};

function scanJsonValueEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length && /\s/.test(text[i]!)) i += 1;
  if (i >= text.length) return -1;
  const ch = text[i]!;
  if (ch === '"') {
    i += 1;
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2;
        continue;
      }
      if (text[i] === '"') return i + 1;
      i += 1;
    }
    return -1;
  }
  if (ch === '{' || ch === '[') {
    const stack: string[] = [ch];
    let inString = false;
    i += 1;
    while (i < text.length && stack.length > 0) {
      const c = text[i]!;
      if (inString) {
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '"') inString = false;
        i += 1;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' && stack.at(-1) === '{') stack.pop();
      else if (c === ']' && stack.at(-1) === '[') stack.pop();
      i += 1;
    }
    return stack.length === 0 ? i : -1;
  }
  // Primitive (number, true, false, null)
  const rest = text.slice(i);
  const prim = rest.match(/^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=[\s,}\]]|$)/);
  return prim ? i + prim[0].length : -1;
}

function recoverPartialJsonObject(text: string): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  let i = text.indexOf('{');
  if (i < 0) return undefined;
  i += 1;
  let recovered = 0;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i]!)) i += 1;
    if (i >= text.length || text[i] === '}') break;
    if (text[i] !== '"') break;
    const keyEnd = scanJsonValueEnd(text, i);
    if (keyEnd < 0) break;
    let key: string;
    try {
      key = JSON.parse(text.slice(i, keyEnd)) as string;
    } catch {
      break;
    }
    i = keyEnd;
    while (i < text.length && /\s/.test(text[i]!)) i += 1;
    if (text[i] !== ':') break;
    i += 1;
    const valEnd = scanJsonValueEnd(text, i);
    if (valEnd < 0) break;
    try {
      result[key] = JSON.parse(text.slice(i, valEnd)) as unknown;
      recovered += 1;
    } catch {
      break;
    }
    i = valEnd;
  }
  return recovered > 0 ? result : undefined;
}

function recoverPartialJsonArray(text: string): unknown[] | undefined {
  const result: unknown[] = [];
  let i = text.indexOf('[');
  if (i < 0) return undefined;
  i += 1;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i]!)) i += 1;
    if (i >= text.length || text[i] === ']') break;
    const valEnd = scanJsonValueEnd(text, i);
    if (valEnd < 0) break;
    try {
      result.push(JSON.parse(text.slice(i, valEnd)) as unknown);
    } catch {
      break;
    }
    i = valEnd;
  }
  return result.length > 0 ? result : undefined;
}

function extractOmittedCount(value: unknown): number | undefined {
  if (Array.isArray(value)) {
    const last = value.at(-1);
    if (
      last &&
      typeof last === 'object' &&
      !Array.isArray(last) &&
      typeof (last as Record<string, unknown>)._omittedCount === 'number'
    ) {
      return (last as Record<string, unknown>)._omittedCount as number;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const count = (value as Record<string, unknown>)._omittedCount;
    if (typeof count === 'number' && count > 0) return count;
  }
  return undefined;
}

/**
 * Parse JSON cleanly, or recover complete top-level keys/items from a truncated
 * `>4 KiB` / `head -c` JSON snippet.
 */
export function parseTolerantJson(raw: string): ParsedJsonResult | undefined {
  const cleaned = cleanToolOutputText(raw).trim();
  if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) return undefined;
  try {
    const value = JSON.parse(cleaned) as unknown;
    if (value && typeof value === 'object') {
      const omittedCount = extractOmittedCount(value);
      return {
        value,
        truncated: false,
        bounded: Boolean(omittedCount),
        ...(omittedCount ? { omittedCount } : {}),
      };
    }
    return undefined;
  } catch {
    const beforeCut = cleaned.split('\n[… omitted …]\n')[0] ?? cleaned;
    const recovered = beforeCut.startsWith('{')
      ? recoverPartialJsonObject(beforeCut)
      : recoverPartialJsonArray(beforeCut);
    if (!recovered) return undefined;
    return { value: recovered, truncated: true, bounded: false };
  }
}

export function humanizeFieldKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!spaced) return key;
  const words = spaced.split(/\s+/).map((word, index) => {
    const upper = word.toUpperCase();
    if (['ID', 'URL', 'URLS', 'PR', 'CI', 'API', 'MCP', 'UTC', 'JSON', 'SHA'].includes(upper)) {
      return upper === 'URLS' ? 'URLs' : upper;
    }
    return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase();
  });
  return words.join(' ');
}

function formatScalarValue(value: unknown, lookup?: ToolIdentityLookup): {
  text: string;
  mono?: boolean;
  muted?: boolean;
} {
  if (value === null || value === undefined || value === '') {
    return { text: 'None', muted: true };
  }
  if (typeof value === 'boolean') return { text: value ? 'Yes' : 'No' };
  if (typeof value === 'number') return { text: String(value), mono: true };
  if (typeof value === 'string') {
    const clean = sanitizeIdsInText(value.trim(), lookup);
    if (!clean) return { text: 'None', muted: true };
    const isIsoDate = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?/.test(clean);
    const isPathOrUrl = /^(?:https?:\/\/|\/|\.{1,2}\/)/.test(clean);
    return { text: clean, mono: isIsoDate || isPathOrUrl };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { text: 'None', muted: true };
    if (value.every((item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')) {
      return { text: value.map((item) => sanitizeIdsInText(String(item), lookup)).join(', ') };
    }
    return { text: `${value.length} ${value.length === 1 ? 'item' : 'items'}` };
  }
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const entries = Object.entries(rec).filter(([, v]) => v !== undefined && v !== null && v !== '');
    if (entries.length === 0) return { text: 'None', muted: true };
    if (typeof rec.start === 'string' && typeof rec.end === 'string' && entries.length <= 3) {
      return { text: `${rec.start} – ${rec.end}`, mono: true };
    }
    if (typeof rec.name === 'string') {
      const handle = typeof rec.handle === 'string' ? ` (@${rec.handle.replace(/^@/, '')})` : '';
      return { text: `${rec.name}${handle}` };
    }
    if (typeof rec.handle === 'string') {
      return { text: `@${rec.handle.replace(/^@/, '')}` };
    }
    const parts: string[] = [];
    for (const [k, v] of entries.slice(0, 4)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        parts.push(`${v} ${k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}`);
      }
    }
    if (parts.length) return { text: parts.join(' · ') };
    return { text: `${entries.length} fields` };
  }
  return { text: String(value) };
}

export type SheetKvRow = {
  key: string;
  value: string;
  mono?: boolean;
  muted?: boolean;
  stacked?: boolean;
};

export type SheetItemCard = {
  lead: string;
  badge?: string;
  meta?: string;
};

export type SheetDiffLine = {
  kind: 'hunk' | 'add' | 'del' | 'context';
  text: string;
};

export type SheetDiffFile = {
  path: string;
  status?: string;
  lines: SheetDiffLine[];
};

export type SheetChecklistItem = {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
};

export type ToolSheetBody =
  | { kind: 'secret'; notice: string }
  | {
      kind: 'sent-message';
      fromTo?: string;
      tag?: string;
      text: string;
    }
  | {
      kind: 'diff';
      files: SheetDiffFile[];
    }
  | {
      kind: 'checklist';
      objective?: string;
      items: SheetChecklistItem[];
    }
  | {
      kind: 'empty';
      heading: string;
      detail?: string;
      chips?: string[];
    }
  | {
      kind: 'array-cards';
      receipt?: string;
      itemNoun: string;
      cards: SheetItemCard[];
      omittedCount?: number;
    }
  | {
      kind: 'kv-card';
      receipt?: string;
      rows: SheetKvRow[];
    }
  | {
      kind: 'mono';
      receipt?: string;
      text: string;
    };

export type ToolSheetPresentation = {
  title: string;
  subtitle?: string;
  badge?: 'Bounded' | 'Truncated';
  body: ToolSheetBody;
  rawLabel: string;
  rawText?: string;
  canCopy: boolean;
};

function parseDiffLines(diff: string): SheetDiffLine[] {
  return diff
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line): SheetDiffLine => {
      if (line.startsWith('@@')) return { kind: 'hunk', text: line };
      if (line.startsWith('+') && !line.startsWith('+++')) return { kind: 'add', text: line };
      if (line.startsWith('-') && !line.startsWith('---')) return { kind: 'del', text: line };
      return { kind: 'context', text: line };
    });
}

function summarizeCardItem(item: unknown, lookup?: ToolIdentityLookup): SheetItemCard {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { lead: sanitizeIdsInText(String(item), lookup) };
  }
  const rec = item as Record<string, unknown>;
  const leadKey = ['title', 'name', 'summary', 'subject', 'path', 'workflowName', 'text', 'id', 'scheduleId'].find(
    (k) => typeof rec[k] === 'string' && (rec[k] as string).trim(),
  );
  const lead = leadKey
    ? sanitizeIdsInText(String(rec[leadKey]).replace(/\s+/g, ' ').trim().slice(0, 120), lookup)
    : 'Item';
  let badge: string | undefined;
  if (typeof rec.status === 'string' && rec.status.trim()) {
    badge = rec.status.charAt(0).toUpperCase() + rec.status.slice(1);
  } else if (typeof rec.paused === 'boolean') {
    badge = rec.paused ? 'Paused' : 'Active';
  } else if (typeof rec.active === 'boolean') {
    badge = rec.active ? 'Active' : 'Inactive';
  }
  const hasHumanLead = Boolean(leadKey && leadKey !== 'id' && leadKey !== 'scheduleId');
  const metaParts: string[] = [];
  for (const [k, v] of Object.entries(rec)) {
    if (
      k === leadKey ||
      k === 'status' ||
      k === 'paused' ||
      k === 'active' ||
      k === '_omittedCount' ||
      (hasHumanLead && /(?:^id$|Id$)/.test(k)) ||
      v === undefined ||
      v === null ||
      v === ''
    ) {
      continue;
    }
    if (k === 'roomName' && typeof v === 'string') {
      metaParts.push(v.startsWith('#') ? v : `#${v}`);
      continue;
    }
    if (k === 'repliesTo' && v && typeof v === 'object') {
      const formatted = formatScalarValue(v, lookup).text;
      if (formatted && formatted !== 'None') metaParts.push(`replies to ${formatted}`);
      continue;
    }
    if (k === 'cadence' && v && typeof v === 'object') {
      const cad = v as Record<string, unknown>;
      if (typeof cad.expression === 'string') metaParts.push(cad.expression);
      else if (typeof cad.everyMinutes === 'number') metaParts.push(`every ${cad.everyMinutes}m`);
      continue;
    }
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      const text = sanitizeIdsInText(String(v).replace(/\s+/g, ' ').trim(), lookup);
      if (text && text.length <= 64) {
        metaParts.push(k === 'author' || k === 'handle' ? text : `${humanizeFieldKey(k).toLowerCase()} ${text}`);
      }
    }
    if (metaParts.length >= 4) break;
  }
  return {
    lead,
    ...(badge ? { badge } : {}),
    ...(metaParts.length ? { meta: metaParts.join(' · ') } : {}),
  };
}

function parseInputObject(input: string | null | undefined): Record<string, unknown> | undefined {
  if (!input?.trim()) return undefined;
  try {
    const parsed = JSON.parse(input.trim()) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function queryChips(inputObj: Record<string, unknown> | undefined): string[] | undefined {
  const rawQuery = typeof inputObj?.query === 'string' ? inputObj.query.trim() : undefined;
  if (!rawQuery) return undefined;
  const parts = rawQuery.split(/\s+/).filter(Boolean).slice(0, 8);
  return parts.length ? parts : undefined;
}

export function buildToolSheetPresentation(params: {
  title: string;
  subtitle?: string;
  command?: string | null;
  input?: string | null;
  receipt?: string | null;
  detail?: string | null;
  rawOutput?: string | null;
  files?: readonly { path: string; status?: string; diff?: string }[];
  plan?: { objective?: string; items: readonly { step: string; status: 'pending' | 'in_progress' | 'completed' }[] };
  outcome?: 'running' | 'success' | 'failure';
  terminalOnly?: boolean;
  outputHidden?: boolean;
  requester?: string;
  lookup?: ToolIdentityLookup;
}): ToolSheetPresentation {
  const inputObj = parseInputObject(params.input);
  const rawSource = params.rawOutput ?? params.detail ?? '';
  const cleanedSource = rawSource ? cleanToolOutputText(rawSource) : '';
  const shownReceipt =
    !params.outputHidden && params.receipt?.trim()
      ? sanitizeIdsInText(params.receipt.trim(), params.lookup)
      : undefined;

  // Build title + subtitle
  let title = params.title;
  let subtitle = params.subtitle;
  const appName = humanizeAppName(typeof inputObj?.app === 'string' ? inputObj.app : undefined);
  const appRaw = typeof inputObj?.app === 'string' ? inputObj.app : undefined;
  const subTool = typeof inputObj?.tool === 'string' ? inputObj.tool : undefined;
  if (appName && !subTool && /tools$/i.test(title)) {
    title = typeof inputObj?.query === 'string' ? `Searched ${appName} tools` : `Listed ${appName} tools`;
    if (!subtitle) {
      subtitle = [appRaw, params.outcome === 'failure' ? 'Failed' : 'Succeeded']
        .filter(Boolean)
        .join(' · ');
    }
  }
  const description = typeof inputObj?.description === 'string' ? inputObj.description.trim() : undefined;
  if (description && !subtitle) {
    subtitle = description;
  }

  // 1. Secret hidden
  if (params.outputHidden) {
    return {
      title,
      subtitle,
      body: { kind: 'secret', notice: params.detail || 'Output hidden: contains a secret.' },
      rawLabel: 'Raw output',
      canCopy: false,
    };
  }

  // Raw payload assembly for collapsible footer & Copy raw
  const rawSections: string[] = [];
  if (params.command?.trim()) rawSections.push(params.command.trim());
  if (params.input?.trim()) {
    try {
      rawSections.push(JSON.stringify(JSON.parse(params.input.trim()), null, 2));
    } catch {
      rawSections.push(params.input.trim());
    }
  }
  if (cleanedSource.trim()) rawSections.push(cleanedSource.trim());
  const rawText = rawSections.join('\n\n') || undefined;

  // 2. Sent message card (`beeline-agent.message` / `reply` with `text`)
  if (
    typeof inputObj?.text === 'string' &&
    inputObj.text.trim() &&
    (typeof inputObj.address === 'string' ||
      typeof inputObj.recipient === 'string' ||
      typeof inputObj.type === 'string' ||
      /^sent\b|^replied\b|^message\b/i.test(title))
  ) {
    const rawTarget =
      (typeof inputObj.address === 'string' ? inputObj.address : undefined) ??
      (typeof inputObj.recipient === 'string' ? inputObj.recipient : undefined);
    const room =
      (typeof inputObj.roomId === 'string' ? inputObj.roomId : undefined) ??
      (typeof inputObj.room === 'string' ? inputObj.room : undefined);
    const formatted = formatMessageTarget(rawTarget, room, params.lookup);
    const parsedAddr = parseAgentAddress(rawTarget, params.lookup);
    const receiverName = parsedAddr.agentDisplay ?? formatted.agent?.replace(/^@/, '');
    const fromTo =
      params.lookup?.speakerName && receiverName
        ? `${params.lookup.speakerName} → ${receiverName}`
        : receiverName
          ? `To ${formatted.agent ?? receiverName}`
          : undefined;
    const msgType = typeof inputObj.type === 'string' ? inputObj.type.toLowerCase() : '';
    const tag =
      msgType === 'reply'
        ? 'Reply'
        : msgType === 'blocked'
          ? 'Blocker'
          : formatted.place
            ? 'Thread task'
            : 'Message';
    const messageTitle = formatted.agent
      ? `Sent message to ${formatted.agent}`
      : 'Sent message';
    const statusTail =
      shownReceipt ||
      (params.outcome === 'failure'
        ? params.subtitle ?? 'Failed'
        : formatted.agent
          ? `Queued & woke ${formatted.agent}`
          : 'Sent');
    const messageSub = [formatted.place, statusTail].filter(Boolean).join(' · ');
    return {
      title: messageTitle,
      subtitle: subtitle ?? messageSub,
      body: {
        kind: 'sent-message',
        fromTo,
        tag,
        text: inputObj.text.trim(),
      },
      rawLabel: 'Raw JSON',
      rawText,
      canCopy: Boolean(rawText),
    };
  }

  // 3. File diffs
  const diffFiles: SheetDiffFile[] = (params.files ?? [])
    .filter((file): file is { path: string; status?: string; diff: string } =>
      Boolean(file.diff?.trim()),
    )
    .map((file) => ({
      path: file.path,
      ...(file.status ? { status: file.status } : {}),
      lines: parseDiffLines(file.diff),
    }));
  if (diffFiles.length > 0) {
    const rawDiff = diffFiles.map((f) => `${f.path}\n${f.lines.map((l) => l.text).join('\n')}`).join('\n\n');
    const firstFile = diffFiles[0]!;
    return {
      title,
      subtitle:
        subtitle ??
        [firstFile.path, params.outcome === 'failure' ? 'Failed' : 'Succeeded']
          .filter(Boolean)
          .join(' · '),
      body: { kind: 'diff', files: diffFiles },
      rawLabel: 'Raw patch',
      rawText: rawText || rawDiff,
      canCopy: Boolean(rawText || rawDiff),
    };
  }
  if (/^(?:@@\s+-\d+|---\s+\S+\n\+\+\+\s+\S+|\*\*\*\s+Begin Patch)/m.test(cleanedSource)) {
    return {
      title,
      subtitle,
      body: {
        kind: 'diff',
        files: [{ path: params.files?.[0]?.path ?? 'Patch', lines: parseDiffLines(cleanedSource) }],
      },
      rawLabel: 'Raw patch',
      rawText,
      canCopy: Boolean(rawText),
    };
  }

  // 4. Checklist (`TodoWrite` / ACP `plan`)
  if (params.plan?.items.length) {
    return {
      title,
      subtitle,
      body: {
        kind: 'checklist',
        ...(params.plan.objective ? { objective: params.plan.objective } : {}),
        items: params.plan.items.map((item) => ({ ...item })),
      },
      rawLabel: 'Raw JSON',
      rawText,
      canCopy: Boolean(rawText),
    };
  }

  // 5. Structured JSON payloads (complete or partial-recovered)
  const json = parseTolerantJson(cleanedSource);
  if (json) {
    const badge = json.bounded ? 'Bounded' : json.truncated ? 'Truncated' : undefined;
    const rawLabel = params.command?.trim() ? 'Raw command & JSON' : 'Raw JSON';

    if (Array.isArray(json.value)) {
      const items = json.value.filter(
        (entry) =>
          !(
            entry &&
            typeof entry === 'object' &&
            !Array.isArray(entry) &&
            Object.keys(entry as Record<string, unknown>).length === 1 &&
            '_omittedCount' in (entry as Record<string, unknown>)
          ),
      );
      if (items.length === 0) {
        return {
          title,
          subtitle,
          badge,
          body: { kind: 'empty', heading: 'No items returned', chips: queryChips(inputObj) },
          rawLabel,
          rawText,
          canCopy: Boolean(rawText),
        };
      }
      return {
        title,
        subtitle,
        badge,
        body: {
          kind: 'array-cards',
          receipt: shownReceipt,
          itemNoun: 'items',
          cards: items.map((item) => summarizeCardItem(item, params.lookup)),
          omittedCount: json.omittedCount,
        },
        rawLabel,
        rawText,
        canCopy: Boolean(rawText),
      };
    }

    if (json.value && typeof json.value === 'object') {
      const obj = json.value as Record<string, unknown>;
      const visibleEntries = Object.entries(obj).filter(
        ([k]) => k !== '_omittedCount' && k !== 'receipt',
      );
      // Empty object `{}`
      if (visibleEntries.length === 0) {
        return {
          title,
          subtitle,
          badge,
          body: {
            kind: 'empty',
            heading: shownReceipt ?? 'No data returned',
            chips: queryChips(inputObj),
          },
          rawLabel,
          rawText,
          canCopy: Boolean(rawText),
        };
      }
      // Single empty array key e.g. `{"tools": []}`
      if (
        visibleEntries.length === 1 &&
        Array.isArray(visibleEntries[0]![1]) &&
        (visibleEntries[0]![1] as unknown[]).length === 0
      ) {
        const key = visibleEntries[0]![0];
        const noun = humanizeFieldKey(key).toLowerCase();
        const chips = queryChips(inputObj);
        return {
          title,
          subtitle,
          badge,
          body: {
            kind: 'empty',
            heading: key === 'tools' ? 'No matching tools returned' : `No ${noun} returned`,
            ...(chips ? { detail: 'Looked up:', chips } : {}),
          },
          rawLabel,
          rawText,
          canCopy: Boolean(rawText),
        };
      }
      // Single dominant non-empty array of objects (e.g. `{ schedules: [...] }`, `{ messages: [...] }`, `{ runs: [...] }`)
      const arrayEntries = visibleEntries.filter(
        ([, v]) => Array.isArray(v) && v.length > 0 && v.some((item) => item && typeof item === 'object'),
      );
      if (arrayEntries.length === 1 && visibleEntries.length <= 4) {
        const [arrKey, arrVal] = arrayEntries[0]!;
        const list = arrVal as unknown[];
        return {
          title,
          subtitle,
          badge,
          body: {
            kind: 'array-cards',
            receipt: shownReceipt,
            itemNoun: humanizeFieldKey(arrKey).toLowerCase(),
            cards: list.map((item) => summarizeCardItem(item, params.lookup)),
            omittedCount: json.omittedCount,
          },
          rawLabel,
          rawText,
          canCopy: Boolean(rawText),
        };
      }
      // Flat or 1-level nested object -> kv-card
      const rows: SheetKvRow[] = visibleEntries.map(([key, value]) => {
        const formatted = formatScalarValue(value, params.lookup);
        return {
          key: humanizeFieldKey(key),
          value: formatted.text,
          ...(formatted.mono ? { mono: true } : {}),
          ...(formatted.muted ? { muted: true } : {}),
          ...(formatted.text.length > 42 ? { stacked: true } : {}),
        };
      });
      return {
        title,
        subtitle,
        badge,
        body: {
          kind: 'kv-card',
          receipt: shownReceipt,
          rows,
        },
        rawLabel,
        rawText,
        canCopy: Boolean(rawText),
      };
    }
  }

  // 6. Empty / terminal-only / failed-empty states
  if (!cleanedSource.trim()) {
    const heading =
      params.outcome === 'failure'
        ? 'Failed with no output'
        : params.terminalOnly && params.command?.trim()
          ? 'Ran in terminal (no text output)'
          : 'No output saved';
    return {
      title,
      subtitle,
      body: { kind: 'empty', heading },
      rawLabel: params.command?.trim() ? 'Raw command' : 'Raw arguments',
      rawText,
      canCopy: Boolean(rawText),
    };
  }

  // 7. Plain CLI logs / mono text
  return {
    title,
    subtitle,
    body: {
      kind: 'mono',
      receipt: shownReceipt,
      text: cleanedSource,
    },
    rawLabel: params.command?.trim() ? 'Raw command & output' : 'Raw output',
    rawText,
    canCopy: Boolean(rawText),
  };
}

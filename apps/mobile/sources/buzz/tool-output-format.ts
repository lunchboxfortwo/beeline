import type { ActivityResultBlock } from '@beeline/api-contract/phone';
import {
  formatMessageTarget,
  humanizeAppName,
  parseAgentAddress,
  sanitizeIdsInText,
  type ToolIdentityLookup,
} from './tool-identity-lookup';
import { stripRecognizedDisplayPrefix } from './tool-display-paths';
import {
  cleanToolOutputText,
  formatBytesCompact,
  formatScalarValue,
  humanizeFieldKey,
  parseStrictSearchMatches,
  parseTolerantJson,
  type ParsedJsonResult,
  type SheetMatchGroup,
} from './tool-output-parsers';

export {
  cleanToolOutputText,
  formatBytesCompact,
  humanizeFieldKey,
  parseStrictSearchMatches,
  parseTolerantJson,
  type ParsedJsonResult,
  type SheetMatchGroup,
};

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
  truncated?: boolean;
  lines: SheetDiffLine[];
};

export type SheetChecklistItem = {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
};

export type SheetBadge = {
  label: string;
  tone?: 'danger' | 'accent' | 'muted';
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
      truncated?: boolean;
    }
  | {
      kind: 'checklist';
      objective?: string;
      items: SheetChecklistItem[];
    }
  | {
      kind: 'matches';
      groups: SheetMatchGroup[];
      truncated?: boolean;
    }
  | {
      kind: 'media';
      mediaKind: 'image' | 'audio';
      mimeType?: string;
      label?: string;
      sizeBytes?: number;
      available: boolean;
    }
  | {
      kind: 'resource';
      mode: 'link' | 'text' | 'blob';
      uri?: string;
      name?: string;
      mimeType?: string;
      text?: string;
      sizeBytes?: number;
      truncated?: boolean;
    }
  | {
      kind: 'unknown';
      rawType?: string;
      text?: string;
    }
  | {
      kind: 'caption';
      text: string;
      truncated?: boolean;
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
      truncated?: boolean;
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
      truncated?: boolean;
    };

export type ToolSheetPresentation = {
  title: string;
  subtitle?: string;
  statusLine?: string;
  statusTone?: 'danger' | 'muted';
  badge?: 'Bounded' | 'Truncated';
  badges: SheetBadge[];
  /** Primary Zone 1 block (alias of `blocks[0]`) for single-block consumers/tests. */
  body: ToolSheetBody;
  /** Ordered Zone 1 universal ACP result blocks. */
  blocks: ToolSheetBody[];
  /** Auto-expand Zone 2 invocation block (e.g. silent observed exit-0 commands). */
  autoExpandZone2?: boolean;
  /** True when Zone 1 already shows raw mono text verbatim, so Zone 2 must not duplicate it. */
  zone1ShowsMonoVerbatim?: boolean;
  rawLabel: string;
  copyLabel: string;
  rawText?: string;
  canCopy: boolean;
};

function parseDiffLines(diff: string): SheetDiffLine[] {
  return diff
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line): SheetDiffLine => {
      if (line.startsWith('@@') || line.trim() === '[… omitted …]') return { kind: 'hunk', text: line };
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

function jsonToSheetBlock(
  json: ParsedJsonResult,
  opts: {
    shownReceipt?: string;
    inputObj?: Record<string, unknown>;
    lookup?: ToolIdentityLookup;
    explicitTruncated?: boolean;
    explicitOmitted?: number;
  },
): ToolSheetBody {
  const omittedCount = opts.explicitOmitted ?? json.omittedCount;
  const truncated = Boolean(opts.explicitTruncated || json.truncated || json.bounded || omittedCount);

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
      return { kind: 'empty', heading: 'No items returned', chips: queryChips(opts.inputObj) };
    }
    return {
      kind: 'array-cards',
      receipt: opts.shownReceipt,
      itemNoun: 'items',
      cards: items.map((item) => summarizeCardItem(item, opts.lookup)),
      ...(omittedCount ? { omittedCount } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  }

  if (json.value && typeof json.value === 'object') {
    const obj = json.value as Record<string, unknown>;
    const visibleEntries = Object.entries(obj).filter(
      ([k]) => k !== '_omittedCount' && k !== 'receipt',
    );
    if (visibleEntries.length === 0) {
      return {
        kind: 'empty',
        heading: opts.shownReceipt ?? 'No data returned',
        chips: queryChips(opts.inputObj),
      };
    }
    if (
      visibleEntries.length === 1 &&
      Array.isArray(visibleEntries[0]![1]) &&
      (visibleEntries[0]![1] as unknown[]).length === 0
    ) {
      const key = visibleEntries[0]![0];
      const noun = humanizeFieldKey(key).toLowerCase();
      const chips = queryChips(opts.inputObj);
      return {
        kind: 'empty',
        heading: key === 'tools' ? 'No matching tools returned' : `No ${noun} returned`,
        ...(chips ? { detail: 'Looked up:', chips } : {}),
      };
    }
    const arrayEntries = visibleEntries.filter(
      ([, v]) => Array.isArray(v) && v.length > 0 && v.some((item) => item && typeof item === 'object'),
    );
    if (arrayEntries.length === 1 && visibleEntries.length <= 4) {
      const [arrKey, arrVal] = arrayEntries[0]!;
      const list = arrVal as unknown[];
      return {
        kind: 'array-cards',
        receipt: opts.shownReceipt,
        itemNoun: humanizeFieldKey(arrKey).toLowerCase(),
        cards: list.map((item) => summarizeCardItem(item, opts.lookup)),
        ...(omittedCount ? { omittedCount } : {}),
        ...(truncated ? { truncated: true } : {}),
      };
    }
    const rows: SheetKvRow[] = visibleEntries.map(([key, value]) => {
      const formatted = formatScalarValue(value, opts.lookup);
      return {
        key: humanizeFieldKey(key),
        value: formatted.text,
        ...(formatted.mono ? { mono: true } : {}),
        ...(formatted.muted ? { muted: true } : {}),
        ...(formatted.text.length > 42 ? { stacked: true } : {}),
      };
    });
    return {
      kind: 'kv-card',
      receipt: opts.shownReceipt,
      rows,
    };
  }

  return { kind: 'mono', text: String(json.value) };
}

function buildCopyLabel(opts: {
  boundedOrTruncated: boolean;
  sanitized?: boolean;
  silentCommandOnly?: boolean;
  isJson?: boolean;
}): string {
  if (opts.silentCommandOnly) return 'Copy command';
  if (opts.sanitized && opts.boundedOrTruncated) return 'Copy sanitized excerpt';
  if (opts.sanitized) return 'Copy sanitized';
  if (opts.boundedOrTruncated) return 'Copy excerpt';
  if (opts.isJson) return 'Copy JSON';
  return 'Copy raw';
}

export function buildToolSheetPresentation(params: {
  title: string;
  subtitle?: string;
  command?: string | null;
  input?: string | null;
  receipt?: string | null;
  detail?: string | null;
  rawOutput?: string | null;
  blocks?: readonly ActivityResultBlock[];
  files?: readonly {
    path: string;
    status?: string;
    diff?: string;
    diffTruncated?: boolean;
    line?: number;
    endLine?: number;
  }[];
  plan?: { objective?: string; items: readonly { step: string; status: 'pending' | 'in_progress' | 'completed' }[] };
  outcome?: 'running' | 'success' | 'failure';
  exitCode?: number;
  signal?: string;
  outputTruncated?: boolean;
  omittedCount?: number;
  sanitized?: boolean;
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
  if (description && !subtitle && description !== title) {
    subtitle = description;
  }

  const badges: SheetBadge[] = [];
  let statusLine: string | undefined;
  let statusTone: 'danger' | 'muted' = 'muted';

  if (params.signal) {
    statusTone = 'danger';
    badges.push({ label: `Signalled · ${params.signal}`, tone: 'danger' });
  } else if (typeof params.exitCode === 'number' && params.exitCode !== 0) {
    statusTone = 'danger';
    badges.push({ label: `Exit (${params.exitCode})`, tone: 'danger' });
  } else if (params.outcome === 'failure') {
    statusLine = 'Failed';
    statusTone = 'danger';
  } else if (params.outcome === 'running') {
    statusLine = 'Running';
  } else if (params.exitCode === 0 && !cleanedSource.trim() && !params.blocks?.length) {
    statusLine = 'Exited (0) · no output';
  } else if (params.terminalOnly) {
    statusLine = 'Completed · terminal handle only';
  } else {
    statusLine = 'Completed';
  }

  if (params.outputHidden) {
    const secretBlock: ToolSheetBody = {
      kind: 'secret',
      notice: params.detail || 'Output hidden: contains a secret.',
    };
    return {
      title,
      subtitle,
      statusLine,
      statusTone,
      badges,
      body: secretBlock,
      blocks: [secretBlock],
      rawLabel: 'Raw output',
      copyLabel: 'Copy raw',
      canCopy: false,
    };
  }

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

  const finalize = (opts: {
    blocks: ToolSheetBody[];
    badge?: 'Bounded' | 'Truncated';
    rawLabel: string;
    rawTextOverride?: string;
    autoExpandZone2?: boolean;
    zone1ShowsMonoVerbatim?: boolean;
    silentCommandOnly?: boolean;
    isJson?: boolean;
    isDiffBounded?: boolean;
    titleOverride?: string;
    subtitleOverride?: string;
  }): ToolSheetPresentation => {
    const finalBadges = [...badges];
    const isBoundedOrTruncated = Boolean(
      opts.badge || params.outputTruncated || opts.isDiffBounded || params.omittedCount,
    );
    const derivedBadge: 'Bounded' | 'Truncated' | undefined =
      opts.badge ?? (params.outputTruncated || opts.isDiffBounded ? 'Bounded' : undefined);
    if (opts.isDiffBounded) {
      finalBadges.push({ label: 'Bounded diff', tone: 'accent' });
    } else if (derivedBadge) {
      finalBadges.push({ label: derivedBadge, tone: 'accent' });
    }
    if (params.sanitized) {
      finalBadges.push({ label: 'Sanitized', tone: 'muted' });
    }
    const finalRaw = opts.rawTextOverride ?? rawText;
    return {
      title: opts.titleOverride ?? title,
      subtitle: opts.subtitleOverride ?? subtitle,
      statusLine,
      statusTone,
      ...(derivedBadge ? { badge: derivedBadge } : {}),
      badges: finalBadges,
      body: opts.blocks[0]!,
      blocks: opts.blocks,
      ...(opts.autoExpandZone2 ? { autoExpandZone2: true } : {}),
      ...(opts.zone1ShowsMonoVerbatim ? { zone1ShowsMonoVerbatim: true } : {}),
      rawLabel: opts.rawLabel,
      copyLabel: buildCopyLabel({
        boundedOrTruncated: isBoundedOrTruncated,
        sanitized: params.sanitized,
        silentCommandOnly: opts.silentCommandOnly,
        isJson: opts.isJson,
      }),
      rawText: finalRaw,
      canCopy: Boolean(finalRaw),
    };
  };

  // Sent message card
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
    const messageTitle = formatted.agent ? `Sent message to ${formatted.agent}` : 'Sent message';
    const statusTail =
      shownReceipt ||
      (params.outcome === 'failure'
        ? params.subtitle ?? 'Failed'
        : formatted.agent
          ? `Queued & woke ${formatted.agent}`
          : 'Sent');
    const messageSub = [formatted.place, statusTail].filter(Boolean).join(' · ');
    return finalize({
      titleOverride: messageTitle,
      subtitleOverride: subtitle ?? messageSub,
      blocks: [{ kind: 'sent-message', fromTo, tag, text: inputObj.text.trim() }],
      rawLabel: 'Raw JSON',
      isJson: true,
    });
  }

  // Universal ordered ACP blocks[]
  if (params.blocks && params.blocks.length > 0) {
    const rendered: ToolSheetBody[] = [];
    let anyJson = false;
    let anyTruncated = Boolean(params.outputTruncated);
    let anyBounded = Boolean(params.omittedCount);
    let anyDiffTruncated = false;

    for (const block of params.blocks) {
      if (block.kind === 'text') {
        if (block.truncated) anyTruncated = true;
        const cleaned = cleanToolOutputText(block.text).trim();
        if (!cleaned) continue;
        const isMixed = params.blocks.length > 1;
        if (isMixed && !cleaned.includes('\n') && cleaned.length <= 220) {
          rendered.push({ kind: 'caption', text: cleaned, ...(block.truncated ? { truncated: true } : {}) });
        } else {
          const matches = parseStrictSearchMatches(cleaned);
          if (matches) {
            rendered.push({ kind: 'matches', groups: matches, ...(block.truncated ? { truncated: true } : {}) });
          } else {
            rendered.push({ kind: 'mono', text: cleaned, ...(block.truncated ? { truncated: true } : {}) });
          }
        }
      } else if (block.kind === 'json') {
        anyJson = true;
        if (block.truncated) anyTruncated = true;
        if (block.omittedCount) anyBounded = true;
        const parsed = parseTolerantJson(block.text);
        if (parsed) {
          if (parsed.bounded) anyBounded = true;
          if (parsed.truncated) anyTruncated = true;
          rendered.push(
            jsonToSheetBlock(parsed, {
              shownReceipt: rendered.length === 0 ? shownReceipt : undefined,
              inputObj,
              lookup: params.lookup,
              explicitTruncated: block.truncated,
              explicitOmitted: block.omittedCount,
            }),
          );
        } else {
          rendered.push({ kind: 'mono', text: block.text, ...(block.truncated ? { truncated: true } : {}) });
        }
      } else if (block.kind === 'diff') {
        if (block.truncated) anyDiffTruncated = true;
        rendered.push({
          kind: 'diff',
          files: [
            {
              path: stripRecognizedDisplayPrefix(block.path),
              ...(block.status ? { status: block.status } : {}),
              ...(block.truncated ? { truncated: true } : {}),
              lines: parseDiffLines(block.diff),
            },
          ],
          ...(block.truncated ? { truncated: true } : {}),
        });
      } else if (block.kind === 'media') {
        rendered.push({
          kind: 'media',
          mediaKind: block.mediaKind,
          ...(block.mimeType ? { mimeType: block.mimeType } : {}),
          ...(block.label ? { label: block.label } : {}),
          ...(block.sizeBytes !== undefined ? { sizeBytes: block.sizeBytes } : {}),
          available: block.available === true,
        });
      } else if (block.kind === 'resource') {
        if (block.truncated) anyTruncated = true;
        rendered.push({
          kind: 'resource',
          mode: block.mode,
          ...(block.uri ? { uri: block.uri } : {}),
          ...(block.name ? { name: block.name } : {}),
          ...(block.mimeType ? { mimeType: block.mimeType } : {}),
          ...(block.text ? { text: block.text } : {}),
          ...(block.sizeBytes !== undefined ? { sizeBytes: block.sizeBytes } : {}),
          ...(block.truncated ? { truncated: true } : {}),
        });
      } else if (block.kind === 'unknown') {
        rendered.push({
          kind: 'unknown',
          ...(block.rawType ? { rawType: block.rawType } : {}),
          ...(block.text ? { text: block.text } : {}),
        });
      }
    }

    if (rendered.length > 0) {
      const onlyMono = rendered.length === 1 && rendered[0]!.kind === 'mono';
      const badge = anyBounded ? 'Bounded' : anyTruncated ? 'Truncated' : undefined;
      return finalize({
        blocks: rendered,
        badge,
        isDiffBounded: anyDiffTruncated,
        isJson: anyJson && !params.command,
        zone1ShowsMonoVerbatim: onlyMono,
        rawLabel: anyJson
          ? params.command?.trim()
            ? 'Parameters & Raw JSON'
            : 'Raw JSON'
          : params.command?.trim()
            ? 'Invocation'
            : 'Raw output',
      });
    }
  }

  // File diffs
  const diffFiles: SheetDiffFile[] = (params.files ?? [])
    .filter((file): file is { path: string; status?: string; diff: string; diffTruncated?: boolean } =>
      Boolean(file.diff?.trim()),
    )
    .map((file) => {
      const truncated = Boolean(file.diffTruncated || file.diff.includes('[… omitted …]'));
      return {
        path: stripRecognizedDisplayPrefix(file.path),
        ...(file.status ? { status: file.status } : {}),
        ...(truncated ? { truncated: true } : {}),
        lines: parseDiffLines(file.diff),
      };
    });
  if (diffFiles.length > 0) {
    const rawDiff = diffFiles.map((f) => `${f.path}\n${f.lines.map((l) => l.text).join('\n')}`).join('\n\n');
    const firstFile = diffFiles[0]!;
    const anyDiffTruncated = diffFiles.some((f) => f.truncated);
    return finalize({
      subtitleOverride: subtitle ?? firstFile.path,
      blocks: [{ kind: 'diff', files: diffFiles, ...(anyDiffTruncated ? { truncated: true } : {}) }],
      isDiffBounded: anyDiffTruncated,
      rawLabel: 'Raw patch',
      rawTextOverride: rawText || rawDiff,
    });
  }
  if (/^(?:@@\s+-\d+|---\s+\S+\n\+\+\+\s+\S+|\*\*\*\s+Begin Patch)/m.test(cleanedSource)) {
    const diffTruncated = Boolean(params.outputTruncated || cleanedSource.includes('[… omitted …]'));
    return finalize({
      blocks: [
        {
          kind: 'diff',
          files: [
            {
              path: stripRecognizedDisplayPrefix(params.files?.[0]?.path ?? 'Patch'),
              ...(diffTruncated ? { truncated: true } : {}),
              lines: parseDiffLines(cleanedSource),
            },
          ],
          ...(diffTruncated ? { truncated: true } : {}),
        },
      ],
      isDiffBounded: diffTruncated,
      rawLabel: 'Raw patch',
    });
  }

  // Checklist
  if (params.plan?.items.length) {
    return finalize({
      blocks: [
        {
          kind: 'checklist',
          ...(params.plan.objective ? { objective: params.plan.objective } : {}),
          items: params.plan.items.map((item) => ({ ...item })),
        },
      ],
      rawLabel: 'Raw JSON',
      isJson: true,
    });
  }

  // Structured JSON
  const json = parseTolerantJson(cleanedSource);
  if (json) {
    const badge = json.bounded || params.omittedCount
      ? 'Bounded'
      : json.truncated || params.outputTruncated
        ? 'Truncated'
        : undefined;
    const rawLabel = params.command?.trim() ? 'Raw command & JSON' : 'Raw JSON';
    const block = jsonToSheetBlock(json, {
      shownReceipt,
      inputObj,
      lookup: params.lookup,
      explicitTruncated: params.outputTruncated,
      explicitOmitted: params.omittedCount,
    });
    return finalize({
      blocks: [block],
      badge,
      rawLabel,
      isJson: true,
    });
  }

  // Empty / observed exit 0 / terminal-only / failed-empty
  if (!cleanedSource.trim()) {
    if (params.exitCode === 0 && params.command?.trim()) {
      return finalize({
        blocks: [
          {
            kind: 'empty',
            heading: 'Exited (0) · no output',
            detail: 'Observed exit 0, empty stdout/stderr',
          },
        ],
        autoExpandZone2: true,
        silentCommandOnly: true,
        rawLabel: 'Command',
      });
    }
    const heading = params.signal
      ? `Signalled · ${params.signal}`
      : params.outcome === 'failure'
        ? 'Failed with no output'
        : 'Completed';
    const detail = params.terminalOnly
      ? 'Adapter reported completion without an exit code or captured text.'
      : params.outcome === 'failure'
        ? undefined
        : 'No output captured for this step.';
    return finalize({
      blocks: [{ kind: 'empty', heading, ...(detail ? { detail } : {}) }],
      autoExpandZone2: Boolean(params.command?.trim()),
      silentCommandOnly: Boolean(params.command?.trim() && !params.input?.trim()),
      rawLabel: params.command?.trim() ? 'Command' : 'Raw arguments',
    });
  }

  // Strict grouped matches
  const strictMatches = parseStrictSearchMatches(cleanedSource);
  if (strictMatches) {
    return finalize({
      blocks: [
        {
          kind: 'matches',
          groups: strictMatches,
          ...(params.outputTruncated ? { truncated: true } : {}),
        },
      ],
      rawLabel: params.command?.trim() ? 'Invocation & raw matches' : 'Raw matches',
    });
  }

  // Plain CLI logs / mono text
  const isTruncatedMono = Boolean(params.outputTruncated || cleanedSource.includes('[… omitted …]'));
  return finalize({
    blocks: [
      {
        kind: 'mono',
        receipt: shownReceipt,
        text: cleanedSource,
        ...(isTruncatedMono ? { truncated: true } : {}),
      },
    ],
    badge: isTruncatedMono ? 'Bounded' : undefined,
    zone1ShowsMonoVerbatim: true,
    rawLabel: params.command?.trim() ? 'Invocation' : 'Arguments',
  });
}

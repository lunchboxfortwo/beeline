import type { ActionWeight, TurnActivityAction, TurnActivityFile } from '@/buzz/activity-timeline';
import { displayFilePath, extractMcpReceipt } from './tool-call-classify';
import type { ToolIdentityLookup } from './tool-identity-lookup';
import {
  isTerminalOnlyOutput,
  TOOL_CALL_DURATION_FLOOR_MS,
  toolCallOutput,
  toolCallRowModel,
  type ToolRowStat,
  type ToolSearchScope,
} from './tool-call-row';

/**
 * The flat one-item-per-row universal ACP tool ledger.
 *
 * Every settled step is one flat row inside the turn's single step-count
 * disclosure. A chevron `>` appears ONLY when opening the row reveals an
 * additional stored fact not already shown on the row.
 */

const GLYPH_SHELL = '>_';
const GLYPH_FILE = '≡';
const GLYPH_THOUGHT = '⋯';
const GLYPH_NOTE = '✎';
const GLYPH_TOOL = '·';

const FILE_VERBS = new Set([
  'read',
  'write',
  'edit',
  'patch',
  'list',
  'search',
  'move',
  'delete',
  'glob',
  'grep',
]);

export function toolGlyph(
  step: Pick<TurnActivityAction, 'kind' | 'toolKind' | 'startupWarning'>,
): string {
  if (step.kind === 'thought') return GLYPH_THOUGHT;
  if (step.kind === 'note') return step.startupWarning ? GLYPH_TOOL : GLYPH_NOTE;
  const verb = step.toolKind?.toLowerCase() ?? '';
  if (verb === 'execute') return GLYPH_SHELL;
  if (FILE_VERBS.has(verb)) return GLYPH_FILE;
  return GLYPH_TOOL;
}

export type ToolLedgerLine = {
  toolGroup?: import('@beeline/api-contract/phone').RoomViewActivity['toolGroup'];
  toolOutput?: import('@beeline/api-contract/phone').RoomViewActivity['toolOutput'];
  hasDetail?: boolean;
  id: string;
  kind: 'tool' | 'thought' | 'note';
  /** True when a non-fatal harness startup warning was demoted to a quiet note. */
  startupWarning?: true;
  weight?: ActionWeight;
  glyph: string;
  label: string;
  /** True when the subject renders in monospace (file paths / commands). */
  subjectMono?: boolean;
  /** Quiet right-column stat (duration, exact +N -M, SIGKILL, exit 1, N hits). */
  stat?: ToolRowStat;
  /** Semantic search scope when the call is a search or tool lookup. */
  searchScope?: ToolSearchScope;
  /** Full un-truncated action heading for ToolOutputSheet. */
  sheetTitle?: string;
  verb?: string;
  outcome: 'running' | 'success' | 'failure';
  /** Distilled failure reason; undefined on success. */
  reason?: string;
  /** From existing receipts only; undefined means the gutter is omitted. */
  durationMs?: number;
  summary?: string;
  exitCode?: number;
  signal?: string;
  outputTruncated?: boolean;
  omittedCount?: number;
  sanitized?: boolean;
  origin?: TurnActivityAction['origin'];
  /** Redacted shell command or tool invocation arguments for ToolOutputSheet. */
  command?: string;
  input?: string;
  /** Structured post-condition receipt surfaced from a completed beeline-agent result. */
  receipt?: string;
  /** The sheet body: full raw output or reason. Never fabricated from path-only files. */
  detail?: string;
  /** Raw output text preserved for structured sheet rendering. */
  rawOutput?: string;
  /** Ordered universal ACP result blocks for mixed or structured output. */
  blocks?: TurnActivityAction['blocks'];
  outputHidden?: boolean;
  terminalOnly?: boolean;
  requester?: string;
  files?: readonly TurnActivityFile[];
  plan?: TurnActivityAction['plan'];
  /** True ONLY when tapping opens at least one stored fact not already visible on the row. */
  inspectable: boolean;
};

function hasSentMessageBody(input: string | undefined): boolean {
  if (!input?.trim()) return false;
  try {
    const parsed = JSON.parse(input.trim()) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return (
      typeof parsed.text === 'string' &&
      parsed.text.trim().length > 0 &&
      (typeof parsed.address === 'string' ||
        typeof parsed.recipient === 'string' ||
        typeof parsed.type === 'string')
    );
  } catch {
    return false;
  }
}

function normalizeOneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * One ledger line per step, in turn order. The turn's final step on a live
 * turn reads as running so the row the agent is inside right now carries the
 * spinner.
 */
export function toolLedgerLines(
  steps: readonly TurnActivityAction[],
  live = false,
  lookup?: ToolIdentityLookup,
): ToolLedgerLine[] {
  return steps.map((step, index) => {
    const isCurrent = live && index === steps.length - 1;
    const outcome: ToolLedgerLine['outcome'] =
      isCurrent && !step.startupWarning ? 'running' : step.outcome;
    const durationMs =
      step.durationMs && step.durationMs >= TOOL_CALL_DURATION_FLOOR_MS
        ? step.durationMs
        : undefined;
    const receipt = step.kind === 'tool' ? extractMcpReceipt(step.output, lookup) : undefined;
    const terminalOnly = Boolean(step.terminalOnly || isTerminalOnlyOutput(step.output));
    const rowModel = step.kind === 'tool' ? toolCallRowModel(step, lookup) : undefined;
    const label = rowModel ? rowModel.label : step.label;
    const detailProps = detailOf(step, outcome);

    const outputHidden = Boolean(
      step.outputHidden || ('outputHidden' in detailProps && detailProps.outputHidden),
    );
    const hasDiff = Boolean(step.files?.some((file) => Boolean(file.diff?.trim())));
    const hasBlocks = Boolean(step.blocks && step.blocks.length > 0);
    const hasPlan = Boolean(step.plan?.items.length);
    const hasRequester = Boolean('requester' in detailProps && detailProps.requester);
    const hasMessageBody = hasSentMessageBody(step.input);

    const cleanedOutput = toolCallOutput(step.output).join('\n').trim();
    // Output earns a chevron unless it is purely redundant with the single-line failure reason already on the row.
    const outputAddsFact =
      Boolean(cleanedOutput) &&
      !(
        outcome === 'failure' &&
        step.reason &&
        !cleanedOutput.includes('\n') &&
        normalizeOneLine(cleanedOutput) === normalizeOneLine(step.reason)
      );

    // A command earns a chevron when opening reveals something NOT already shown on the row:
    // replaced inline script, multiline/clipped command, observed exit 0, terminal-only note, or signal.
    const commandAddsFact = Boolean(
      step.command &&
        (rowModel?.replacedCommandBySummary ||
          step.command.includes('\n') ||
          step.command.trim().length > 72 ||
          step.exitCode === 0 ||
          Boolean(step.signal) ||
          terminalOnly),
    );

    // Server-side withheld body: new server sets `hasDetail: true` and omits `toolOutput` when false;
    // old server sends unconditional `toolOutput` with `hasDetail === undefined` (must allow fetch).
    const remoteBodyAvailable = Boolean(
      step.toolOutput && step.hasDetail !== false && step.toolOutput.hasDetail !== false,
    );

    // Long subject clipped at 2 lines on row (~84 chars) -> sheet wraps full subject.
    const clippedSubject = step.kind === 'tool' && label.length > 84;

    const hasUnseenFact = Boolean(
      remoteBodyAvailable ||
        hasBlocks ||
        outputAddsFact ||
        hasDiff ||
        hasPlan ||
        outputHidden ||
        hasRequester ||
        hasMessageBody ||
        commandAddsFact ||
        Boolean(step.signal) ||
        clippedSubject ||
        (step.kind === 'note' && step.startupWarning && Boolean(cleanedOutput || remoteBodyAvailable)),
    );

    const inspectable =
      !step.rollupOnly &&
      (step.kind === 'note' ? Boolean(step.startupWarning && hasUnseenFact) : hasUnseenFact);

    return {
      id: step.id,
      ...(step.toolGroup ? { toolGroup: step.toolGroup } : {}),
      ...(step.toolOutput ? { toolOutput: step.toolOutput } : {}),
      ...(step.hasDetail !== undefined ? { hasDetail: step.hasDetail } : {}),
      kind: step.kind,
      ...(step.startupWarning ? { startupWarning: true as const } : {}),
      weight: step.weight,
      glyph: toolGlyph(step),
      label,
      ...(rowModel?.subjectMono ? { subjectMono: true } : {}),
      ...(rowModel?.stat ? { stat: rowModel.stat } : {}),
      ...(rowModel?.searchScope ? { searchScope: rowModel.searchScope } : {}),
      ...(rowModel ? { sheetTitle: rowModel.sheetTitle } : {}),
      verb: rowModel?.verb,
      outcome,
      ...(outcome === 'failure' && step.reason ? { reason: step.reason } : {}),
      ...(durationMs ? { durationMs } : {}),
      ...(step.summary ? { summary: step.summary } : {}),
      ...(step.exitCode !== undefined ? { exitCode: step.exitCode } : {}),
      ...(step.signal ? { signal: step.signal } : {}),
      ...(step.outputTruncated ? { outputTruncated: true } : {}),
      ...(step.omittedCount ? { omittedCount: step.omittedCount } : {}),
      ...(step.sanitized ? { sanitized: true } : {}),
      ...(step.origin ? { origin: step.origin } : {}),
      ...(step.command ? { command: step.command } : {}),
      ...(step.input ? { input: step.input } : {}),
      ...(receipt ? { receipt } : {}),
      ...(step.output && !terminalOnly ? { rawOutput: step.output } : {}),
      ...(step.blocks?.length ? { blocks: step.blocks } : {}),
      ...(terminalOnly ? { terminalOnly: true } : {}),
      ...(step.files?.length ? { files: step.files } : {}),
      ...(step.plan ? { plan: step.plan } : {}),
      ...detailProps,
      ...(outputHidden ? { outputHidden: true } : {}),
      inspectable,
    };
  });
}

function detailOf(
  step: TurnActivityAction,
  outcome: ToolLedgerLine['outcome'],
): Pick<ToolLedgerLine, 'detail' | 'requester' | 'outputHidden'> | {} {
  const output = toolCallOutput(step.output).join('\n');
  const outputHidden = step.outputHidden === true || output === 'Output hidden: contains a secret.';
  const parts: string[] = [];
  if (outcome === 'failure' && step.reason && !output.includes(step.reason)) {
    parts.push(step.reason);
  }
  // Never fabricate fake body lines from path-only `files[]` entries.
  if (output) parts.push(output);
  return {
    ...(outputHidden
      ? { detail: output || 'Output hidden: contains a secret.', outputHidden: true }
      : parts.length
        ? { detail: parts.join('\n') }
        : {}),
    ...(step.requestedBy
      ? {
          requester: step.requestedBy.name
            ? `at ${step.requestedBy.name}'s request`
            : "at a grant's request",
        }
      : {}),
  };
}

export type ToolLedgerRun = {
  kind: 'group';
  id: string;
  /** Tool and thought steps; notes and demoted startup warnings are counted apart. */
  count: number;
  failed: number;
  notes: number;
  durationMs?: number;
  lines: ToolLedgerLine[];
};

/**
 * Group a machine run under one quiet step-count trigger, expanding to one
 * flat single-item-per-row list with zero nested sub-folders.
 */
export function groupToolLedgerRuns(lines: readonly ToolLedgerLine[]): ToolLedgerRun[] {
  if (!lines.length) return [];
  const failed = lines.filter((line) => line.outcome === 'failure' && !line.startupWarning).length;
  const notes = lines.filter((line) => line.kind === 'note' && !line.startupWarning).length;
  const durations = lines
    .map((line) => line.durationMs)
    .filter((ms): ms is number => typeof ms === 'number');
  const durationMs = durations.length ? durations.reduce((sum, ms) => sum + ms, 0) : undefined;
  const count = lines.reduce(
    (sum, line) => sum + (line.kind === 'note' ? 0 : (line.toolGroup?.count ?? 1)),
    0,
  );
  return [
    {
      kind: 'group',
      id: lines[0]!.id,
      count,
      failed,
      notes,
      ...(durationMs ? { durationMs } : {}),
      lines: [...lines],
    },
  ];
}

export type ToolGroupSummaryPart = {
  text: string;
  emphasis?: 'strong';
};

export type ToolLedgerDisplayItem =
  | { kind: 'line'; line: ToolLedgerLine }
  | {
      kind: 'read-fold';
      id: string;
      count: number;
      lead: string;
      detail?: string;
      lines: ToolLedgerLine[];
    };

function capitalizeLead(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function stripLineLocation(label: string): string {
  return label.replace(/:\d+(?:[–-]\d+)?(?:,\s*:\d+(?:[–-]\d+)?)*$/, '').replace(/\s*\(\+\d+\)$/, '');
}

function lineFileTarget(line: ToolLedgerLine): string | undefined {
  if (line.files?.[0]?.path) return displayFilePath(line.files[0].path);
  const clean = stripLineLocation(line.label).trim();
  if (clean && /[\w.-]+\.[A-Za-z0-9]{1,8}$/.test(clean)) return clean;
  return undefined;
}

function classifyCommandOutcome(line: ToolLedgerLine): string | undefined {
  if (line.weight === 'observation') return undefined;
  const source = `${line.command ?? ''} ${line.label} ${line.summary ?? ''}`;
  if (
    /\b(?:vitest|jest|mocha|playwright|pytest|cargo\s+test|go\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|tests?)\b/i.test(
      source,
    )
  ) {
    return 'ran tests';
  }
  if (/\b(?:typecheck|tsc)\b/i.test(source)) return 'ran typecheck';
  if (/\b(?:eslint|lint|check-mobile|check-architecture|fast-gate)\b/i.test(source)) {
    return 'ran checks';
  }
  if (/\bbuild\b/i.test(source)) return 'ran build';
  if (/\bgit\s+commit\b/i.test(source) || (line.verb === 'git' && /^commit\b/i.test(line.label))) {
    return 'committed changes';
  }
  if (/\bgit\s+push\b/i.test(source) || (line.verb === 'git' && /^push\b/i.test(line.label))) {
    return 'pushed changes';
  }
  return undefined;
}

function classifyWorkflowAction(line: ToolLedgerLine): string | undefined {
  const verb = line.verb;
  if (!verb) return undefined;
  const labelLower = line.label.toLowerCase();
  if (verb === 'sent') {
    const recipient = line.label.match(/@[A-Za-z0-9._-]+/)?.[0];
    return recipient ? `sent to ${recipient}` : 'sent message';
  }
  if (verb === 'replied') return 'replied';
  if (verb === 'opened') return labelLower.includes('thread') ? 'opened thread' : 'opened item';
  if (verb === 'closed') return labelLower.includes('ask') ? 'closed ask' : 'closed thread';
  if (verb === 'claimed') return 'claimed thread';
  if (verb === 'approved') return 'approved merge';
  if (verb === 'posted') return 'posted artifact';
  if (verb === 'connected') return 'connected service';
  if (verb === 'dispatched') return 'dispatched release';
  if (verb === 'requested') return 'requested grant';
  if (verb === 'stopped') return 'stopped agent';
  if (verb === 'saved') return labelLower.includes('procedure') ? 'saved procedure' : 'saved memory';
  if (verb === 'created' || verb === 'updated' || verb === 'paused' || verb === 'resumed' || verb === 'set' || verb === 'released') {
    if (labelLower.includes('schedule')) return `${verb} schedule`;
    if (labelLower.includes('plan')) return 'updated plan';
    if (labelLower.includes('task')) return `${verb} task`;
    if (labelLower.includes('thread')) return `${verb} thread`;
    if (labelLower.includes('hold')) return verb === 'released' ? 'released hold' : 'set merge hold';
    if (labelLower.includes('memory') || labelLower.includes('procedure')) return `${verb} memory`;
    return `${verb} item`;
  }
  return undefined;
}

/**
 * Derive outcome-focused collapsed summary parts from real ledger lines.
 * Never emits raw step counts (`N steps`) or read/query counts (`read N files`,
 * `searched N queries`). Failures are marked `emphasis: 'strong'` so the UI
 * emphasizes them by typography weight rather than color.
 */
export function toolRunSummaryParts(
  lines: readonly ToolLedgerLine[],
  options?: { remoteUnloaded?: boolean; failed?: number },
): ToolGroupSummaryPart[] {
  const failed =
    options?.failed ??
    lines.filter((line) => line.outcome === 'failure' && !line.startupWarning).length;
  const nonNotes = lines.filter((line) => line.kind !== 'note');
  const notes = lines.filter((line) => line.kind === 'note' && !line.startupWarning).length;
  const hasStartupWarning = lines.some((line) => line.startupWarning);
  const remoteUnloaded =
    options?.remoteUnloaded ??
    (nonNotes.length > 0 && nonNotes.every((line) => Boolean(line.toolGroup)));

  const withFailure = (phrases: string[]): ToolGroupSummaryPart[] => {
    const parts: ToolGroupSummaryPart[] = phrases.map((phrase, index) => ({
      text: index === 0 ? capitalizeLead(phrase) : phrase,
    }));
    if (failed > 0) {
      parts.push({ text: `${failed} failed`, emphasis: 'strong' });
    }
    return parts;
  };

  if (remoteUnloaded) {
    return withFailure(['steps']);
  }
  if (nonNotes.length === 0) {
    if (notes > 0) return withFailure([notes === 1 ? 'note' : 'notes']);
    if (hasStartupWarning) return withFailure(['startup note']);
    return withFailure(['steps']);
  }

  const editedFiles: string[] = [];
  const editedSet = new Set<string>();
  const mutationVerbs = new Set<string>();
  let sawMutation = false;

  const actionPhrases: string[] = [];
  const actionSet = new Set<string>();
  const specificCommands: string[] = [];
  const commandSet = new Set<string>();
  let sawGenericCommand = false;
  let sawWebSearch = false;
  let sawWebFetch = false;

  for (const line of nonNotes) {
    const verb = line.verb;
    const isFileMutation =
      verb === 'edited' ||
      verb === 'wrote' ||
      verb === 'deleted' ||
      verb === 'moved' ||
      Boolean(
        line.files?.some(
          (file) => file.diff || file.status === 'M' || file.status === 'A' || file.status === 'D',
        ),
      );

    if (isFileMutation) {
      sawMutation = true;
      if (verb) mutationVerbs.add(verb);
      const target = lineFileTarget(line);
      if (target && !editedSet.has(target)) {
        editedSet.add(target);
        editedFiles.push(target);
      }
      continue;
    }

    const action = classifyWorkflowAction(line);
    if (action) {
      if (!actionSet.has(action)) {
        actionSet.add(action);
        actionPhrases.push(action);
      }
      continue;
    }

    if (verb === 'ran' || verb === 'git' || line.command) {
      const specific = classifyCommandOutcome(line);
      if (specific) {
        if (!commandSet.has(specific)) {
          commandSet.add(specific);
          specificCommands.push(specific);
        }
      } else if (line.weight !== 'observation') {
        sawGenericCommand = true;
      }
      continue;
    }

    if (line.searchScope === 'web') {
      sawWebSearch = true;
      continue;
    }
    if (verb === 'fetched') {
      sawWebFetch = true;
    }
  }

  const outcomes: string[] = [];

  if (sawMutation) {
    const onlyWrote = mutationVerbs.size === 1 && mutationVerbs.has('wrote');
    const onlyDeleted = mutationVerbs.size === 1 && mutationVerbs.has('deleted');
    const leadVerb = onlyWrote ? 'wrote' : onlyDeleted ? 'deleted' : 'edited';
    if (editedFiles.length === 1) {
      outcomes.push(`${leadVerb} ${editedFiles[0]}`);
    } else if (editedFiles.length === 2 && `${editedFiles[0]}, ${editedFiles[1]}`.length <= 32) {
      outcomes.push(`${leadVerb} ${editedFiles[0]}, ${editedFiles[1]}`);
    } else if (editedFiles.length >= 2) {
      outcomes.push(`${leadVerb} ${editedFiles[0]} +${editedFiles.length - 1}`);
    } else {
      outcomes.push(`${leadVerb} files`);
    }
  }

  for (const phrase of actionPhrases) {
    if (outcomes.length >= 2) break;
    outcomes.push(phrase);
  }
  for (const phrase of specificCommands) {
    if (outcomes.length >= 2) break;
    outcomes.push(phrase);
  }
  if (outcomes.length < 2 && sawWebSearch) {
    outcomes.push('searched web');
  } else if (outcomes.length < 2 && sawWebFetch) {
    outcomes.push('fetched page');
  }
  if (outcomes.length === 0 && sawGenericCommand) {
    outcomes.push('ran command');
  }

  if (outcomes.length === 0) {
    const scopes = new Set(nonNotes.map((line) => line.searchScope).filter(Boolean));
    const verbs = new Set(nonNotes.map((line) => line.verb).filter(Boolean));
    const labelsLower = nonNotes.map((line) => line.label.toLowerCase());
    if (scopes.has('memory')) outcomes.push('searched memory');
    else if (scopes.has('history')) outcomes.push('searched history');
    else if (scopes.has('tools')) outcomes.push('checked tools');
    else if (verbs.has('searched')) outcomes.push('searched code');
    else if (labelsLower.some((label) => label.includes('schedule'))) outcomes.push('checked schedules');
    else if (labelsLower.some((label) => label.includes('message'))) outcomes.push('checked messages');
    else if (
      verbs.has('read') ||
      verbs.has('listed') ||
      verbs.has('checked') ||
      nonNotes.some((line) => line.weight === 'observation')
    ) {
      outcomes.push('checked files');
    } else {
      outcomes.push('steps');
    }
  }

  return withFailure(outcomes.slice(0, 2));
}

/** Flat accessible string for the outcome-focused summary trigger. */
export function toolGroupSummary(
  linesOrRun: readonly ToolLedgerLine[] | Pick<ToolLedgerRun, 'lines' | 'failed'>,
  options?: { remoteUnloaded?: boolean },
): string {
  const isRun = 'lines' in linesOrRun;
  const lines = isRun ? linesOrRun.lines : linesOrRun;
  const failed = isRun ? linesOrRun.failed : undefined;
  return toolRunSummaryParts(lines, { ...options, ...(failed !== undefined ? { failed } : {}) })
    .map((part) => part.text)
    .join(' · ');
}

function isFoldableReadLine(line: ToolLedgerLine): boolean {
  if (line.kind !== 'tool') return false;
  if (line.outcome !== 'success') return false;
  if (line.toolGroup) return false;
  if (line.weight !== 'observation') return false;
  if (line.searchScope === 'web' || line.verb === 'fetched') return false;
  return true;
}

/**
 * Fold runs of 2+ consecutive successful read-only checks into one quiet
 * expandable `Checked` row so edits, commands, web searches, and failures stand
 * out immediately. Single reads and non-consecutive reads stay flat.
 */
export function foldConsecutiveReadLines(
  lines: readonly ToolLedgerLine[],
): ToolLedgerDisplayItem[] {
  const result: ToolLedgerDisplayItem[] = [];
  let buffer: ToolLedgerLine[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    if (buffer.length === 1) {
      result.push({ kind: 'line', line: buffer[0]! });
      buffer = [];
      return;
    }
    const allFiles = buffer.every(
      (line) => line.verb === 'read' && (Boolean(line.files?.length) || Boolean(line.subjectMono)),
    );
    const allSearches = buffer.every((line) => line.verb === 'searched');
    const noun = allFiles ? 'files' : allSearches ? 'searches' : 'checks';
    const targets: string[] = [];
    const seen = new Set<string>();
    for (const line of buffer) {
      const target = lineFileTarget(line) ?? line.label;
      if (target && !seen.has(target)) {
        seen.add(target);
        targets.push(target);
      }
    }
    let detail: string | undefined;
    if (targets.length === 1) {
      detail = targets[0];
    } else if (targets.length === 2) {
      detail = `${targets[0]}, ${targets[1]}`;
    } else if (targets.length > 2) {
      detail = `${targets[0]}, ${targets[1]} +${targets.length - 2}`;
    }
    result.push({
      kind: 'read-fold',
      id: `read-fold-${buffer[0]!.id}`,
      count: buffer.length,
      lead: `${buffer.length} ${noun}`,
      ...(detail ? { detail } : {}),
      lines: [...buffer],
    });
    buffer = [];
  };

  for (const line of lines) {
    if (isFoldableReadLine(line)) {
      buffer.push(line);
    } else {
      flush();
      result.push({ kind: 'line', line });
    }
  }
  flush();
  return result;
}

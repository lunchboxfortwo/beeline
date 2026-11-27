import type { ActionWeight, TurnActivityAction, TurnActivityFile } from '@/buzz/activity-timeline';
import { extractMcpReceipt } from './tool-call-classify';
import type { ToolIdentityLookup } from './tool-identity-lookup';
import {
  formatToolCallDuration,
  isTerminalOnlyOutput,
  TOOL_CALL_DURATION_FLOOR_MS,
  toolCallOutput,
  toolCallRowModel,
  type ToolRowStat,
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
  /** Quiet right-column stat (duration, exact +N -M, SIGKILL, N hits). */
  stat?: ToolRowStat;
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

/** The quiet count trigger copy: `6 steps · 2 failed · 2 notes · 48.0s`. */
export function toolGroupSummary(
  count: number,
  failed: number,
  durationMs: number | undefined,
  notes = 0,
): string {
  const segments: string[] = [];
  if (count > 0 || notes === 0) segments.push(`${count} ${count === 1 ? 'step' : 'steps'}`);
  if (failed > 0) segments.push(`${failed} failed`);
  if (notes > 0) segments.push(`${notes} ${notes === 1 ? 'note' : 'notes'}`);
  const duration = formatToolCallDuration(durationMs);
  if (duration) segments.push(duration);
  return segments.join(' · ');
}

import type { ActionWeight, TurnActivityAction } from '@/buzz/activity-timeline';
import { extractMcpReceipt } from './tool-call-classify';
import type { ToolIdentityLookup } from './tool-identity-lookup';
import {
  formatToolCallDuration,
  isTerminalOnlyOutput,
  TOOL_CALL_DURATION_FLOOR_MS,
  toolCallLabel,
  toolCallOutput,
  toolCallSheetTitle,
  toolCallVerb,
} from './tool-call-row';

/**
 * The flat one-item-per-row tool ledger (v3 — Full ACP + Handoffs).
 *
 * Every settled machine step is one flat row inside the turn's single
 * step-count disclosure. No nested observation sub-folders, no repeated step
 * prose in the trigger header. A failed step carries brass `Failed` on line 1
 * and its distilled failure reason on line 2; rows with inspectable detail open
 * the result-first `ToolOutputSheet`, while rows with zero detail omit `›`.
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
  id: string;
  kind: 'tool' | 'thought' | 'note';
  /** True when a non-fatal harness startup warning was demoted to a quiet note. */
  startupWarning?: true;
  weight?: ActionWeight;
  glyph: string;
  label: string;
  /** Full un-truncated action heading for ToolOutputSheet. */
  sheetTitle?: string;
  verb?: string;
  outcome: 'running' | 'success' | 'failure';
  /** Distilled failure reason; undefined on success. */
  reason?: string;
  /** From existing receipts only; undefined means the gutter is omitted. */
  durationMs?: number;
  /** Redacted shell command or tool invocation arguments for ToolOutputSheet. */
  command?: string;
  input?: string;
  /** Structured post-condition receipt surfaced from a completed beeline-agent result. */
  receipt?: string;
  /** The sheet body: full raw output, files, reason. Undefined = no body saved. */
  detail?: string;
  /** Raw output text preserved for structured sheet rendering. */
  rawOutput?: string;
  outputHidden?: boolean;
  terminalOnly?: boolean;
  requester?: string;
  files?: readonly { path: string; status?: string; diff?: string }[];
  plan?: TurnActivityAction['plan'];
  /** True only when tapping opens meaningful detail in ToolOutputSheet. */
  inspectable: boolean;
};

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
    const terminalOnly = isTerminalOnlyOutput(step.output);
    const detailProps = detailOf(step);
    const hasDetail = Boolean(
      ('detail' in detailProps && detailProps.detail) ||
        step.command ||
        step.input ||
        receipt ||
        step.files?.length ||
        step.toolOutput ||
        step.plan?.items.length ||
        ('requester' in detailProps && detailProps.requester) ||
        outcome === 'failure',
    );
    const inspectable =
      !step.rollupOnly &&
      (step.kind === 'note' ? Boolean(step.startupWarning && hasDetail) : hasDetail);

    return {
      id: step.id,
      ...(step.toolGroup ? { toolGroup: step.toolGroup } : {}),
      ...(step.toolOutput ? { toolOutput: step.toolOutput } : {}),
      kind: step.kind,
      ...(step.startupWarning ? { startupWarning: true as const } : {}),
      weight: step.weight,
      glyph: toolGlyph(step),
      label: step.kind === 'tool' ? toolCallLabel(step, lookup) : step.label,
      ...(step.kind === 'tool' ? { sheetTitle: toolCallSheetTitle(step, lookup) } : {}),
      verb: step.kind === 'tool' ? toolCallVerb(step, lookup) : undefined,
      outcome,
      ...(outcome === 'failure' && step.reason ? { reason: step.reason } : {}),
      ...(durationMs ? { durationMs } : {}),
      ...(step.command ? { command: step.command } : {}),
      ...(step.input ? { input: step.input } : {}),
      ...(receipt ? { receipt } : {}),
      ...(step.output && !terminalOnly ? { rawOutput: step.output } : {}),
      ...(terminalOnly ? { terminalOnly: true } : {}),
      ...(step.files?.length ? { files: step.files } : {}),
      ...(step.plan ? { plan: step.plan } : {}),
      ...detailProps,
      inspectable,
    };
  });
}

function detailOf(
  step: TurnActivityAction,
): Pick<ToolLedgerLine, 'detail' | 'requester' | 'outputHidden'> | {} {
  const output = toolCallOutput(step.output).join('\n');
  const outputHidden = output === 'Output hidden: contains a secret.';
  const parts: string[] = [];
  if (step.reason && !output.includes(step.reason)) parts.push(step.reason);
  for (const file of step.files ?? []) {
    parts.push(file.status ? `${file.status} ${file.path}` : file.path);
  }
  if (output) parts.push(output);
  return {
    ...(outputHidden
      ? { detail: output, outputHidden: true }
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

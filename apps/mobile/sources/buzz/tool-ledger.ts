import type { ActionWeight, TurnActivityAction } from '@/buzz/activity-timeline';
import {
  displayFilePath,
  formatToolCallDuration,
  peelShellCommand,
  TOOL_CALL_DURATION_FLOOR_MS,
  toolCallLabel,
  toolCallVerb,
  toolCallOutput,
} from './tool-call-row';

/**
 * The one-line tool ledger (owner-approved design, 2026-08-24).
 *
 * Every settled machine step is ONE collapsed ledger line: a leading family
 * glyph, the verb-object label, a quiet verdict mark, and — only when the step
 * actually carries one — a right-gutter duration. No cards, no chips. A failed
 * step carries its distilled failure reason on its own wrapping line; a tap
 * opens the full raw output and invocation inputs in the Hull output sheet.
 * Every machine run folds into one group line with concise provenance copy,
 * step count, real failure count, and duration.
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

export function toolGlyph(step: Pick<TurnActivityAction, 'kind' | 'toolKind' | 'startupWarning'>): string {
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
  verb?: string;
  outcome: 'running' | 'success' | 'failure';
  /** Distilled failure reason; undefined on success. */
  reason?: string;
  /** From existing receipts only; undefined means the gutter is omitted. */
  durationMs?: number;
  /** Redacted shell command or tool invocation arguments for ToolOutputSheet. */
  command?: string;
  input?: string;
  /** The sheet body: full raw output, files, reason. Undefined = not pressable. */
  detail?: string;
  outputHidden?: boolean;
  requester?: string;
  files?: readonly { path: string; status?: string }[];
  /** Consecutive observational steps folded behind one expandable disclosure row. */
  folded?: ToolLedgerLine[];
};

/**
 * One ledger line per step, in turn order. The turn's final step on a live
 * turn reads as running — the same live override the previous renderer applied
 * — so the row the agent is inside right now carries the spinner.
 */
export function toolLedgerLines(
  steps: readonly TurnActivityAction[],
  live = false,
): ToolLedgerLine[] {
  return steps.map((step, index) => {
    const isCurrent = live && index === steps.length - 1;
    const outcome: ToolLedgerLine['outcome'] = isCurrent && !step.startupWarning ? 'running' : step.outcome;
    // A duration only earns a gutter above the floor (`tool-call-row.ts`); a
    // faster step omits it rather than faking one.
    const durationMs =
      step.durationMs && step.durationMs >= TOOL_CALL_DURATION_FLOOR_MS
        ? step.durationMs
        : undefined;
    return {
      id: step.id,
      ...(step.toolGroup ? { toolGroup: step.toolGroup } : {}),
      ...(step.toolOutput ? { toolOutput: step.toolOutput } : {}),
      kind: step.kind,
      ...(step.startupWarning ? { startupWarning: true as const } : {}),
      weight: step.weight,
      glyph: toolGlyph(step),
      // A thought's own label already says `thought` and a note's label is its
      // whole text; a tool's label is the call's object (tool-call-row.ts) —
      // the glyph carries the family.
      label: step.kind === 'tool' ? toolCallLabel(step) : step.label,
      verb: step.kind === 'tool' ? toolCallVerb(step) : undefined,
      outcome,
      ...(outcome === 'failure' && step.reason ? { reason: step.reason } : {}),
      ...(durationMs ? { durationMs } : {}),
      ...(step.command ? { command: step.command } : {}),
      ...(step.input ? { input: step.input } : {}),
      ...(step.files?.length ? { files: step.files } : {}),
      ...detailOf(step),
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

function isFoldableObservation(line: ToolLedgerLine): boolean {
  return (
    line.kind === 'tool' &&
    line.weight === 'observation' &&
    line.outcome === 'success' &&
    !line.toolGroup &&
    !line.folded
  );
}

function observationFileTarget(line: ToolLedgerLine): string | undefined {
  if (line.verb === 'read' && line.label && !/^\d+\s+calls$/i.test(line.label) && line.label !== 'chat messages' && line.label !== 'thread brief' && line.label !== 'session' && line.label !== 'session setup') {
    return line.label;
  }
  const cmd = peelShellCommand(line.command ?? line.label);
  const catMatch = cmd.match(/^(?:cat|head|tail|sed\s+-n|nl)\b.*?\s([^\s|;&'"`]+\.[a-z0-9]{1,8})$/i);
  if (catMatch?.[1]) {
    return displayFilePath(catMatch[1]);
  }
  return undefined;
}

function isCodeSearchLine(line: ToolLedgerLine): boolean {
  if (line.verb === 'found') return true;
  const cmd = peelShellCommand(line.command ?? line.label).toLowerCase();
  return /^(?:rg|grep|egrep|fgrep|ag|ack|find)\b/.test(cmd);
}

function isGitInspectLine(line: ToolLedgerLine): boolean {
  return line.verb === 'git';
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/** Summarize a run of consecutive read-only observations for one foldable row. */
export function formatObservationFoldLabel(lines: readonly ToolLedgerLine[]): string {
  const readFiles: string[] = [];
  const seenFiles = new Set<string>();
  const mcpPhrases: string[] = [];
  const seenMcp = new Set<string>();
  let searchCount = 0;
  let gitCount = 0;
  let listCount = 0;
  let fetchCount = 0;
  let otherCount = 0;

  for (const line of lines) {
    if (line.verb === 'listed' && line.label && !/^(?:files|\d+\s+calls)$/i.test(line.label)) {
      const phrase = `listed ${line.label}`;
      if (!seenMcp.has(phrase)) {
        seenMcp.add(phrase);
        mcpPhrases.push(phrase);
      }
      continue;
    }
    if (line.verb === 'checked' && line.label) {
      const phrase = `checked ${line.label}`;
      if (!seenMcp.has(phrase)) {
        seenMcp.add(phrase);
        mcpPhrases.push(phrase);
      }
      continue;
    }
    if (line.verb === 'read' && /^(?:chat messages|message|thread brief|pull request|attachment|procedure|session)/i.test(line.label)) {
      const phrase = `read ${line.label}`;
      if (!seenMcp.has(phrase)) {
        seenMcp.add(phrase);
        mcpPhrases.push(phrase);
      }
      continue;
    }
    if (isCodeSearchLine(line)) {
      searchCount += 1;
      continue;
    }
    if (isGitInspectLine(line)) {
      gitCount += 1;
      continue;
    }
    if (line.verb === 'fetched') {
      fetchCount += 1;
      continue;
    }
    const file = observationFileTarget(line);
    if (file) {
      if (!seenFiles.has(file)) {
        seenFiles.add(file);
        readFiles.push(file);
      }
      continue;
    }
    if (line.verb === 'listed' || /^(?:ls|tree|dir)\b/i.test(line.command ?? line.label)) {
      listCount += 1;
      continue;
    }
    otherCount += 1;
  }

  const clauses: string[] = [];
  if (mcpPhrases.length) {
    clauses.push(...mcpPhrases.slice(0, 2));
  }
  if (readFiles.length === 1) {
    clauses.push(`read ${readFiles[0]}`);
  } else if (readFiles.length > 1) {
    const rest = readFiles.length - 1;
    clauses.push(`read ${readFiles[0]} & ${rest} ${rest === 1 ? 'file' : 'files'}`);
  }
  if (searchCount > 0) clauses.push('searched code');
  if (gitCount > 0) clauses.push('checked git');
  if (listCount > 0) clauses.push('listed files');
  if (fetchCount > 0) clauses.push('fetched web');
  if (!clauses.length && otherCount > 0) clauses.push('inspected details');

  const body = capitalize(clauses.slice(0, 3).join(', ') || 'inspected details');
  return `${body} (${lines.length} ${lines.length === 1 ? 'call' : 'calls'})`;
}

function foldConsecutiveObservations(lines: readonly ToolLedgerLine[]): ToolLedgerLine[] {
  const result: ToolLedgerLine[] = [];
  let buffer: ToolLedgerLine[] = [];

  const flush = () => {
    if (!buffer.length) return;
    if (buffer.length === 1) {
      result.push(buffer[0]!);
    } else {
      const durations = buffer
        .map((line) => line.durationMs)
        .filter((ms): ms is number => typeof ms === 'number');
      const durationMs = durations.length ? durations.reduce((sum, ms) => sum + ms, 0) : undefined;
      result.push({
        id: `obs-${buffer[0]!.id}`,
        kind: 'tool',
        weight: 'observation',
        glyph: GLYPH_FILE,
        label: formatObservationFoldLabel(buffer),
        outcome: 'success',
        ...(durationMs ? { durationMs } : {}),
        folded: [...buffer],
      });
    }
    buffer = [];
  };

  for (const line of lines) {
    if (isFoldableObservation(line)) {
      buffer.push(line);
    } else {
      flush();
      result.push(line);
    }
  }
  flush();
  return result;
}

function inferCodeArea(lines: readonly ToolLedgerLine[]): string | undefined {
  const areas = new Set<string>();
  for (const line of lines) {
    const hay = `${line.command ?? ''} ${line.input ?? ''} ${line.label} ${(line.files ?? []).map((f) => f.path).join(' ')}`;
    if (/\bapps\/server\b|\bserver\//i.test(hay)) areas.add('server');
    if (/\bapps\/mobile\b|\bmobile\//i.test(hay)) areas.add('mobile');
    if (/\bapps\/body\b|\bbody\//i.test(hay)) areas.add('body');
  }
  if (areas.size === 1) return [...areas][0];
  return undefined;
}

/**
 * Concise provenance copy summarizing the highest-signal actions and inspections
 * in a run (e.g. `Listed schedules · inspected skill & server code`), without
 * repeating the agent's prose answer.
 */
export function toolRunProvenance(lines: readonly ToolLedgerLine[]): string | undefined {
  const flat: ToolLedgerLine[] = [];
  for (const line of lines) {
    if (line.kind !== 'tool' || line.toolGroup) continue;
    if (line.folded?.length) flat.push(...line.folded);
    else flat.push(line);
  }
  if (!flat.length) return undefined;

  const primaryActions: string[] = [];
  const seenPrimary = new Set<string>();
  const editedFiles = new Set<string>();
  const inspectedFiles: string[] = [];
  let sawSkill = false;
  let sawCodeInspect = false;

  const pushPrimary = (phrase: string) => {
    const key = phrase.toLowerCase();
    if (!seenPrimary.has(key)) {
      seenPrimary.add(key);
      primaryActions.push(phrase);
    }
  };

  for (const line of flat) {
    const verb = line.verb?.toLowerCase();
    if (verb === 'wrote' || verb === 'moved' || verb === 'deleted') {
      if (line.label) editedFiles.add(line.label);
      continue;
    }
    if (
      verb &&
      [
        'listed',
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
        'posted',
        'connected',
        'prepared',
        'requested',
        'stopped',
        'dispatched',
        'checked',
      ].includes(verb) &&
      line.label &&
      !/^(?:files|\d+\s+calls)$/i.test(line.label)
    ) {
      pushPrimary(`${verb} ${line.label}`);
      continue;
    }
    if (verb === 'read' && /^(?:chat messages|message|thread brief|pull request|attachment|procedure)/i.test(line.label)) {
      pushPrimary(`read ${line.label}`);
      continue;
    }
    if (line.weight === 'observation') {
      const target = observationFileTarget(line);
      if (target) {
        if (/skill\.md$/i.test(target)) sawSkill = true;
        else {
          inspectedFiles.push(target);
          sawCodeInspect = true;
        }
      } else if (isCodeSearchLine(line) || isGitInspectLine(line)) {
        sawCodeInspect = true;
      }
      continue;
    }
    // Non-observational commands: surface meaningful build/test/typecheck/lint commands.
    const cmd = (line.command ?? line.label).toLowerCase();
    if (/\b(?:vitest|jest|mocha|playwright|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test)\b/.test(cmd)) {
      pushPrimary('ran tests');
    } else if (/\b(?:typecheck|tsc)\b/.test(cmd)) {
      pushPrimary('ran typecheck');
    } else if (/\b(?:lint|eslint)\b/.test(cmd)) {
      pushPrimary('ran lint');
    } else if (/\bbuild\b/.test(cmd)) {
      pushPrimary('ran build');
    } else if (verb === 'git' && /\bcommit\b/.test(line.label.toLowerCase())) {
      pushPrimary('committed changes');
    }
  }

  const parts: string[] = [];
  if (editedFiles.size === 1) {
    parts.push(`edited ${[...editedFiles][0]}`);
  } else if (editedFiles.size > 1) {
    parts.push(`edited ${editedFiles.size} files`);
  }
  for (const action of primaryActions) {
    if (parts.length >= 2) break;
    parts.push(action);
  }
  if (parts.length < 2 && (sawSkill || sawCodeInspect)) {
    const area = inferCodeArea(flat);
    if (sawSkill && sawCodeInspect) {
      parts.push(area ? `inspected skill & ${area} code` : 'inspected skill & code');
    } else if (sawSkill) {
      parts.push('read skill');
    } else if (inspectedFiles.length === 1 && !flat.some(isCodeSearchLine)) {
      parts.push(`read ${inspectedFiles[0]}`);
    } else {
      parts.push(area ? `inspected ${area} code` : 'inspected code');
    }
  }
  if (!parts.length) return undefined;
  return parts.map((part, index) => (index === 0 ? capitalize(part) : part)).join(' · ');
}

export type ToolLedgerRun = {
  kind: 'group';
  id: string;
  /** Tool and thought steps; notes and demoted startup warnings are counted apart. */
  count: number;
  failed: number;
  notes: number;
  durationMs?: number;
  /** Concise provenance summary leading the collapsed disclosure. */
  provenance?: string;
  lines: ToolLedgerLine[];
};

/**
 * Fold a machine run into one group line, collapsed by default and expandable
 * in place. Consecutive read-only observations inside the run fold into a
 * single expandable summary line while mutations, external sends, and real
 * failures stay visible on their own lines.
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
  const foldedLines = foldConsecutiveObservations(lines);
  const provenance = toolRunProvenance(foldedLines);
  return [
    {
      kind: 'group',
      id: lines[0]!.id,
      count,
      failed,
      notes,
      ...(durationMs ? { durationMs } : {}),
      ...(provenance ? { provenance } : {}),
      lines: foldedLines,
    },
  ];
}

/** The group line's copy: `[provenance · ]6 steps · 2 failed · 2 notes · 48s` — segments the run earned. */
export function toolGroupSummary(
  count: number,
  failed: number,
  durationMs: number | undefined,
  notes = 0,
  provenance?: string,
): string {
  const segments: string[] = [];
  if (provenance) segments.push(provenance);
  if (count > 0 || notes === 0) segments.push(`${count} ${count === 1 ? 'step' : 'steps'}`);
  if (failed > 0) segments.push(`${failed} failed`);
  if (notes > 0) segments.push(`${notes} ${notes === 1 ? 'note' : 'notes'}`);
  const duration = formatToolCallDuration(durationMs);
  if (duration) segments.push(duration);
  return segments.join(' · ');
}

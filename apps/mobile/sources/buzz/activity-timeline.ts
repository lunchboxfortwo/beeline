import type { AgentActivityItem } from '@/sync/transport/rig-transport';
import {
  describeMcpCall,
  displayFilePath,
  isReadOnlyShellCommand,
  parseMcpTool,
  peelShellCommand,
  redactDisplayPaths,
} from './tool-call-classify';

/**
 * How a single tool call reaches the reader.
 *
 * The dividing line is "did this change or observe state," not "was it
 * expensive": a call that executes or mutates is the payload of the turn and
 * keeps its own line, while a read/search/list is a receipt and folds into the
 * turn's one counted note. A failure always keeps its line, whatever it was
 * doing — after the accent is spent on live state, persistence is the only
 * escalation the ledger has left.
 */
export type ActionWeight = 'mutation' | 'command' | 'failure' | 'observation';

export type TurnActivityFile = {
  path: string;
  status?: string;
  diff?: string;
};

export type TurnActivityAction = {
  toolGroup?: import('@beeline/api-contract/phone').RoomViewActivity['toolGroup'];
  toolOutput?: import('@beeline/api-contract/phone').RoomViewActivity['toolOutput'];
  id: string;
  /** `note` is an earlier text run of the turn, shown in full between tools. */
  kind: 'tool' | 'thought' | 'note';
  /** True when a non-fatal harness startup warning was demoted to a quiet note. */
  startupWarning?: true;
  weight: ActionWeight;
  title: string;
  /** The transcript's compact verb-object copy. Always <= 40 characters. */
  label: string;
  /** Settled state projected from the existing activity status. */
  outcome: 'running' | 'success' | 'failure';
  /** Existing receipts expose this for thoughts; tools omit it when unknown. */
  durationMs?: number;
  toolKind?: string;
  status?: string;
  /**
   * One plain-language line projected from the tool result saying WHY this
   * failed — `exit 1: vitest: not found`, never a bare generic status.
   * Set only for failures; rendered in the row, one line, dim.
   */
  reason?: string;
  path?: string;
  command?: string;
  input?: string;
  output?: string;
  /** Who asked for the turn this call belongs to; quiet text in the expanded row. */
  requestedBy?: { pubkey: string; name?: string };
  files?: TurnActivityFile[];
};

export type TurnActivity = {
  /**
   * The agent's own prose, lifted clear of the telemetry it was buried in.
   * This is what the reader is here for, so it renders at the ledger's
   * brightest tier, full width, and is never collapsed behind a disclosure.
   */
  narration: string[];
  /** Ordered machine ledger. It is the rendering authority for transcript rows. */
  steps: TurnActivityAction[];
  /** Calls that executed or mutated, plus every failure: one line each. */
  actions: TurnActivityAction[];
  /** Read-only calls, folded behind the counted note. */
  observations: TurnActivityAction[];
  /** The counted note's copy, e.g. `12 TOOL CALLS · read 8, searched 3`. */
  note?: string;
  /**
   * The same note in the present tense — `12 TOOL CALLS · reading 8,
   * searching 3` — shown while the turn is still running.
   *
   * grok Build writes its rollup twice: `Reading 2 files, Searching 4 patterns`
   * while the group is in flight, then `Read 2 files, Searched 4 patterns` when
   * it settles, roughly 100ms later and in place. The tense *is* the state
   * report, which is why the row can carry it without a badge, a spinner, or a
   * second line — and why a reader who glances once knows whether they are
   * watching work or reading a record of it.
   */
  liveNote?: string;
  /** How many calls that note stands for, including wire-only tallies. */
  noteCount: number;
  /**
   * Total reasoning time this turn, from body's receipt. Rendered as the quiet
   * half of grok's loud-then-quiet reasoning: the thinking itself never
   * reaches the client, but `THOUGHT FOR 5.8S` does.
   */
  thoughtMs?: number;
  plan?: NonNullable<AgentActivityItem['plan']>;
};

const MAX_ACTION_TITLE = 160;
export const MAX_LEDGER_LABEL = 40;

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clamp(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function cleanTitle(value: string): string {
  return oneLine(value)
    .replace(/^#+\s*/, '')
    .replace(/^\*\*|\*\*$/g, '');
}

/** Preserve disambiguating parent segments for generic basenames while hiding host prefixes. */
function redactPaths(value: string): string {
  return redactDisplayPaths(value);
}

function firstFileName(value: string): string | undefined {
  const match = redactPaths(value).match(
    /(?:[\w.-]+\/)?[\w.-]+\.(?:[cm]?[jt]sx?|json|md|ya?ml|css|html|py|go|rs|java)\b/i,
  );
  return match?.[0];
}

function searchTerms(value: string): string | undefined {
  const quoted = value.match(/["'`]([^"'`]+)["'`]/)?.[1];
  if (quoted) return redactPaths(quoted);
  const named = value.match(
    /(?:search(?:ed)?(?:\s+(?:for|code))?|grep|rg|find)\s+(?:-\S+\s+)*([^\s].*?)(?:\s+(?:in|at)\s+\S+)?$/i,
  )?.[1];
  return named ? clamp(redactPaths(named).replace(/\s+\S+\.[\w-]+$/i, ''), 44) : undefined;
}

function isFailure(item: AgentActivityItem): boolean {
  const status = item.status ?? '';
  if (/\b(?:failed|error|unavailable|denied)\b/i.test(status)) return true;
  // A settled status is the event's authority. Successful output frequently
  // contains phrases such as "0 errors" and must not be reclassified by copy.
  if (/\b(?:completed|complete|success|succeeded|passed|done)\b/i.test(status)) return false;
  return /\b(?:failed|error|unavailable|not available|cannot|can't)\b/i.test(item.text ?? '');
}

/** True when a failed row is non-fatal harness boot/startup telemetry rather than a tool failure. */
export function isHarnessStartupWarning(item: AgentActivityItem): boolean {
  if (!isFailure(item)) return false;
  const source = `${item.title ?? ''}\n${item.text ?? ''}\n${item.output ?? ''}`;
  return (
    /\[?(?:codex-acp|claude-(?:agent|code)-acp|pi-acp)\s+forwarded\s+startup\b/i.test(source) ||
    /\b(?:codex-acp|claude-(?:agent|code)-acp|pi-acp)\b[^\n]*\bstartup\s+(?:stderr|warning|error|notice|log)\b/i.test(
      source,
    ) ||
    /\bmcp\s+servers?\s+need\s+attention\b/i.test(source)
  );
}

/**
 * One plain-language line saying WHY an action failed, projected from the
 * tool's own result — never a bare "Action failed".
 *
 * Body ships the raw output on the same wire record as the status; this folds
 * the recurring shapes in the live failure corpus (2026-08-23) into one
 * readable clause each and falls back to the first error-looking line.
 */
export function failureReason(item: AgentActivityItem): string | undefined {
  const raw = item.output ?? item.text;
  const statusCode = Number(item.status?.match(/(?:exit|code)\s*(\d+)/i)?.[1]);
  if (!raw) return Number.isFinite(statusCode) ? `exit ${statusCode}` : undefined;
  // Body usually JSON-stringifies the tool result envelope.
  let text = raw;
  let exitCode: number | undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.formatted_output === 'string') text = parsed.formatted_output;
      if (typeof parsed.exit_code === 'number') exitCode = parsed.exit_code;
      if (typeof parsed.stderr === 'string' && parsed.stderr.trim()) text = parsed.stderr;
    }
  } catch {
    // Plain-text output stays as-is.
  }
  text = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\s*at\s+\S+\s*\(/.test(line))
    .filter((line) => !/^node:internal\//.test(line))
    .filter((line) => !/(?:ELIFECYCLE|ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL)/i.test(line))
    .filter((line) => !/^npm (?:ERR!|error) (?:code|command|lifecycle|path|cwd)\b/i.test(line))
    .filter((line) => !/^Command failed with exit code \d+\.?$/i.test(line));
  const all = lines.join(' \u2014 ');

  const notFound =
    text.match(/(?:sh:\s*)?\d*:?\s*([\w@./-]+):\s*not found/i) ??
    text.match(/(?:^|\n)\s*([\w@./-]+):\s*command not found\b/i);
  if (notFound) return `command not found: ${notFound[1]}`;
  if (/Read-only file system|EROFS/i.test(all)) {
    return 'blocked: that path is read-only outside this thread\u2019s work area';
  }
  const missingModule = text.match(/Cannot find (?:package|module) ['"]([^'"]+)['"]/);
  if (missingModule) return `missing dependency: ${missingModule[1]}`;
  const noSuchFile = text.match(/(?:ENOENT|No such file or directory).*?[\s'"](\/?[\w.@/-]+)['"]?/);
  if (noSuchFile && noSuchFile[1] !== 'sh') {
    return `file does not exist: ${clamp(redactPaths(noSuchFile[1]), 60)}`;
  }
  const lock = text.match(/Unable to create '([^']+index\.lock)'/);
  if (lock) return `git could not write its index (${redactPaths(lock[1])})`;
  const refused = text.match(/fatal:\s*(.+)/i);
  if (refused) return clamp(oneLine(refused[1]), 90);
  const errorLine = lines.find((line) =>
    /(?:^|\b)(?:error(?:\s+TS\d+)?|ERR!|Traceback|FATAL|exception|cannot|failed:)\b/i.test(line),
  );
  const detail = errorLine ?? lines.find((line) => !/^>\s/.test(line));
  const code = exitCode ?? (Number.isFinite(statusCode) ? statusCode : undefined);
  if (!detail) return code !== undefined ? `exit ${code}` : undefined;
  const clean = oneLine(detail).replace(/^(?:npm|pnpm)\s+(?:ERR!|error)\s*/i, '');
  return clamp(code !== undefined ? `exit ${code}: ${clean}` : clean, 110);
}

function activityOutcome(item: AgentActivityItem): TurnActivityAction['outcome'] {
  if (isFailure(item)) return 'failure';
  if (/(?:in[_ -]?progress|running|pending|started|working)/i.test(item.status ?? '')) {
    return 'running';
  }
  return 'success';
}

function commandLabel(command: string): string | undefined {
  const clean = peelShellCommand(command);
  if (/\b(?:typecheck|tsc\b)/i.test(clean)) return 'type checks';
  if (
    /\b(?:vitest|jest|mocha|playwright|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test)\b/i.test(
      clean,
    )
  )
    return 'tests';
  if (/\b(?:eslint|npm\s+(?:run\s+)?lint|pnpm\s+(?:run\s+)?lint)\b/i.test(clean)) return 'lint';
  if (/\b(?:gradle|npm|pnpm|yarn|bun)\b.*\bbuild\b/i.test(clean)) return 'build';
  if (/\bgit\s+(?:status|diff|log|show)\b/i.test(clean)) return 'review changes';
  if (/\bgit\s+commit\b/i.test(clean)) return 'commit changes';
  const executable = clean.match(/(?:^|&&\s*|;\s*)([\w@./-]+)(?:\s+([^;&|]+))?/);
  if (!executable) return undefined;
  const name = executable[1].split('/').at(-1) ?? executable[1];
  const firstArg = executable[2]?.trim().split(/\s+/)[0];
  return firstArg && !firstArg.startsWith('-') ? `${name} ${firstArg}` : name;
}

/** Concise historical-safe verb-object label derived only from existing fields. */
export function ledgerStepLabel(item: AgentActivityItem): string {
  const kind = item.toolKind?.toLowerCase();
  const source = `${item.title} ${item.command ?? ''} ${item.input ?? ''}`;
  const file = item.files?.[0]?.path ? displayFilePath(item.files[0].path) : firstFileName(source);
  const genericTitle = /^(?:tool|execute|command|shell|bash|result|output|action)$/i.test(
    cleanTitle(item.title),
  );
  const mcp = parseMcpTool(item.title, item.command, item.input);
  if (mcp) {
    const described = describeMcpCall(mcp, item.input, item.command, item.output);
    return clamp(redactPaths(`${described.verb} ${described.object}`), MAX_LEDGER_LABEL);
  }
  let label: string | undefined;
  if (kind === 'read' || /^(?:read|open|cat)\b/i.test(item.title)) {
    label = file ? `read ${file}` : 'read files';
  } else if (kind === 'search' || /\b(?:search|grep|\brg\b|find)\b/i.test(item.title)) {
    const terms = searchTerms(item.command ?? item.input ?? item.title);
    label = terms ? `search ${terms}` : 'search code';
  } else if (kind === 'fetch') {
    label = 'fetch web';
  } else if (['edit', 'write', 'move', 'delete'].includes(kind ?? '')) {
    const verb = kind === 'write' ? 'write' : kind;
    label = file ? `${verb} ${file}` : `${verb} files`;
  }
  const commandDerived = item.command ? commandLabel(item.command) : undefined;
  if (
    !label &&
    commandDerived &&
    /^(?:type checks|tests|lint|build|review changes|commit changes)$/.test(commandDerived)
  ) {
    label = commandDerived;
  }
  if (!label && !genericTitle) {
    label = cleanTitle(item.title)
      .replace(/^(?:ran|run|running|completed|reviewed|updated|prepared|committed)\s+/i, '')
      .replace(/[-_]+/g, ' ')
      .toLowerCase();
  }
  if (!label) label = commandDerived;
  return clamp(redactPaths(label || 'tool step'), MAX_LEDGER_LABEL);
}

function actionTitle(item: AgentActivityItem): string | undefined {
  const title = cleanTitle(item.title);
  const text = item.text ?? '';
  const normalized = title.toLowerCase();
  if (/^(?:result|action|output)$/i.test(title) && !text.trim() && !item.command && !item.files?.length) {
    return undefined;
  }
  if (normalized === 'output' || item.kind === 'output') return 'Agent update';
  if (title && !/^tool$/i.test(title)) {
    return clamp(redactPaths(title), MAX_ACTION_TITLE);
  }
  if (item.command) {
    return clamp(redactPaths(peelShellCommand(item.command)), MAX_ACTION_TITLE);
  }
  if (item.files?.[0]?.path) {
    return clamp(displayFilePath(item.files[0].path), MAX_ACTION_TITLE);
  }
  return title ? clamp(redactPaths(title), MAX_ACTION_TITLE) : undefined;
}

function mergeToolActivity(
  current: AgentActivityItem | undefined,
  next: AgentActivityItem,
): AgentActivityItem {
  if (!current) return { ...next, files: next.files ? [...next.files] : undefined };
  const files = new Map((current.files ?? []).map((file) => [file.path, file]));
  for (const file of next.files ?? []) {
    files.set(file.path, { ...files.get(file.path), ...file });
  }
  return {
    ...current,
    ...next,
    ...(files.size ? { files: [...files.values()] } : {}),
    ...(next.output || current.output ? { output: next.output ?? current.output } : {}),
    ...(next.text || current.text ? { text: next.text ?? current.text } : {}),
  };
}

/**
 * The verb an observational call is counted under in the turn's note.
 *
 * A bare total ("12 calls") answers *how much*; the verb breakdown answers
 * *what kind* in the same width, which is the difference between a number and
 * a shape of work.
 */
function observationVerb(item: AgentActivityItem, title: string): string {
  const kind = item.toolKind?.toLowerCase();
  if (kind === 'read') return 'read';
  if (kind === 'search') return 'searched';
  if (kind === 'fetch') return 'fetched';
  const source = `${title} ${item.title} ${item.command ?? ''}`.toLowerCase();
  if (/\b(search|grep|\brg\b|find)\b/.test(source)) return 'searched';
  if (/\b(list|ls|glob)\b/.test(source)) return 'listed';
  if (/\b(read|open|cat|review)\b/.test(source)) return 'read';
  return 'inspected';
}

/** Verb -> the label a folded call's synthesized review-sheet row leads with. */
const OBSERVED_VERB_LABEL: Readonly<Record<string, string>> = {
  read: 'Read',
  searched: 'Searched for',
  fetched: 'Fetched',
  listed: 'Listed',
  inspected: 'Inspected',
  reasoned: 'Reasoned about',
  ran: 'Ran',
};

/** `Read src/foo.ts`, `Searched for handleSubmit`, `Ran npm test` — body ships the
 *  bare verb/target; the readable phrase is built here, same as every other
 *  action title in this file. */
function observedCallTitle(verb: string, target?: string): string {
  const label = OBSERVED_VERB_LABEL[verb] ?? 'Ran';
  return target ? `${label} ${clamp(target, MAX_ACTION_TITLE)}` : label;
}

const GENERIC_EXECUTE_TITLE =
  /^(?:bash|sh|zsh|shell|terminal|execute|command|exec_command|run_command|tool)$/i;

/**
 * Did this call change state, or only look at it?
 *
 * Mutation and execution are the payload of a turn and keep their own line;
 * read-only inspections (including read-only shell commands after wrapper
 * peeling) fold into the observation disclosure. A failure is pulled out
 * unconditionally — a failed read still outranks a successful one.
 */
function actionWeight(item: AgentActivityItem): ActionWeight {
  if (isFailure(item)) return 'failure';
  const mcp = parseMcpTool(item.title, item.command, item.input);
  if (mcp) {
    return describeMcpCall(mcp, item.input, item.command, item.output).observational
      ? 'observation'
      : 'command';
  }
  const kind = item.toolKind?.toLowerCase();
  if (kind) {
    if (kind === 'edit' || kind === 'delete' || kind === 'move' || kind === 'write') {
      return 'mutation';
    }
    if (kind === 'read' || kind === 'search' || kind === 'fetch' || kind === 'think') {
      return 'observation';
    }
    if (kind === 'execute') {
      const shellCandidate =
        item.command ??
        (item.title && !GENERIC_EXECUTE_TITLE.test(cleanTitle(item.title))
          ? cleanTitle(item.title)
          : undefined);
      if (shellCandidate && isReadOnlyShellCommand(shellCandidate)) return 'observation';
      return 'command';
    }
  }
  if (item.command) {
    return isReadOnlyShellCommand(item.command) ? 'observation' : 'command';
  }
  if (item.files?.length) {
    if (item.files.some((file) => file.status && /^[MADRCU]/i.test(file.status))) return 'mutation';
    if (/\b(read|open|cat|view|inspect)\b/i.test(cleanTitle(item.title))) return 'observation';
    return 'mutation';
  }
  const cleaned = cleanTitle(item.title);
  if (isReadOnlyShellCommand(cleaned)) return 'observation';
  // No declared kind (an older body, or a harness that omits it): fall back to
  // what the label says it did. Inspection verbs stay observational; unknown
  // non-read actions stay visible as commands.
  if (/\b(edit|write|replace|patch|create|delete|remove|move|rename|close|open|order|send|reply|approve|update)\b/i.test(cleaned)) {
    return 'mutation';
  }
  if (/\b(read|open|cat|search|grep|\brg\b|find|list|ls|glob|fetch|think)\b/i.test(cleaned)) {
    return 'observation';
  }
  return 'command';
}

/**
 * `12 TOOL CALLS · read 8, searched 3, listed 1`.
 *
 * One note per turn, never one collapsed line per call and never a wall. The
 * bare total leads because it reads instantly; the verb breakdown follows
 * because it is what tells the reader whether the turn was research or work.
 */
function noteText(total: number, verbs: ReadonlyMap<string, number>): string {
  const head = `${total} TOOL ${total === 1 ? 'CALL' : 'CALLS'}`;
  const breakdown = [...verbs.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([verb, count]) => `${verb} ${count}`)
    .join(', ');
  return breakdown ? `${head} · ${breakdown}` : head;
}

/**
 * Past tense -> present participle, for the in-flight form of the note above.
 *
 * A closed map rather than a suffix rule: the vocabulary is small, fixed, and
 * produced in exactly two places (`observationVerb` here and
 * `observationalVerb` in `apps/body/src/activity.ts`), and a stemming rule that
 * turned an unforeseen verb into a non-word would be a worse failure than
 * simply leaving it in the past tense.
 */
const PRESENT_PARTICIPLE: Readonly<Record<string, string>> = {
  read: 'reading',
  searched: 'searching',
  listed: 'listing',
  fetched: 'fetching',
  inspected: 'inspecting',
  queried: 'querying',
  reasoned: 'reasoning',
  ran: 'running',
};

/** `12 TOOL CALLS · reading 8, searching 3` — the note while it is still true. */
function liveNoteText(total: number, verbs: ReadonlyMap<string, number>): string {
  const head = `${total} TOOL ${total === 1 ? 'CALL' : 'CALLS'}`;
  const breakdown = [...verbs.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([verb, count]) => `${PRESENT_PARTICIPLE[verb] ?? verb} ${count}`)
    .join(', ');
  return breakdown ? `${head} · ${breakdown}` : head;
}

/**
 * The corner's reading model: narration first, tools as footnotes.
 *
 * Three groups come out of one pass, and which group a thing lands in is the
 * whole design:
 *
 *   narration     the agent's own prose — primary tier, never collapsed
 *   actions       calls that executed, mutated, or failed — one line each
 *   observations  reads/searches/lists — folded behind one counted note
 *
 * The synthetic `activity_summary` receipt body publishes is deliberately *not*
 * narration: its text restates mechanism the note already states. Its `rollup`
 * is the only record of the observational calls body counts but never projects
 * as their own events, and its `observed` array — a compact target + short
 * result per folded call, capped independently of the tally — is the only
 * source for those calls' own review-sheet rows, since the calls themselves
 * never reach the wire.
 */
export function buildTurnActivity(
  items: readonly AgentActivityItem[],
  options?: { settled?: boolean },
): TurnActivity {
  type OrderedStep = { kind: 'tool'; id: string } | { kind: 'projected'; step: TurnActivityAction };

  const settled = options?.settled ?? true;
  const narration: string[] = [];
  const tools = new Map<string, AgentActivityItem>();
  const ordered: OrderedStep[] = [];
  const wireRollup = new Map<string, number>();
  let plan: AgentActivityItem['plan'];
  let thoughtMs = 0;
  let anonymousIndex = 0;
  let observedIndex = 0;
  let noteIndex = 0;

  for (const item of items) {
    if (item.plan) plan = item.plan;
    if (item.kind === 'output') {
      const prose = item.text?.trim();
      if (prose && narration.at(-1) !== prose) narration.push(prose);
      continue;
    }
    if (item.kind === 'note') {
      // An earlier text run keeps its place between the tool lines. It is
      // shown whole, so the label is the full text, never a clamp of it. A
      // run longer than one stored note arrives split; its pieces join here.
      const previous = ordered.at(-1);
      if (item.continues && previous?.kind === 'projected' && previous.step.kind === 'note') {
        const joined = `${previous.step.label}${item.text ?? ''}`;
        previous.step = { ...previous.step, title: joined, label: joined };
        continue;
      }
      // The body already trimmed the run; a piece's edges are real text.
      const text = item.text;
      if (text?.trim()) {
        ordered.push({
          kind: 'projected',
          step: {
            id: item.id ?? `note-${noteIndex++}`,
            kind: 'note',
            weight: 'observation',
            title: text,
            label: text,
            outcome: 'success',
          },
        });
      }
      continue;
    }
    if (item.kind === 'thinking') {
      // ACP thought receipts are transport state, not transcript content.
      // Authored live output has its own provisional draft lane below.
      continue;
    }
    if (item.kind === 'summary') {
      for (const [verb, count] of Object.entries(item.rollup ?? {})) {
        wireRollup.set(verb, (wireRollup.get(verb) ?? 0) + count);
      }
      if (item.thoughtMs && item.thoughtMs > 0) {
        thoughtMs += item.thoughtMs;
      }
      for (const call of item.observed ?? []) {
        const title = observedCallTitle(call.verb, call.target);
        ordered.push({
          kind: 'projected',
          step: {
            id: `observed-${observedIndex++}`,
            kind: 'tool',
            weight: 'observation',
            title,
            label: clamp(title.toLowerCase(), MAX_LEDGER_LABEL),
            outcome: 'success',
            toolKind: call.verb,
            ...(call.result ? { output: call.result } : {}),
          },
        });
      }
      // Older transcripts have only the rollup. Keep that historical work
      // visible without fabricating targets or raw output that never existed.
      if (!item.observed?.length) {
        for (const [verb, count] of Object.entries(item.rollup ?? {})) {
          const label = `${PRESENT_PARTICIPLE[verb] ?? verb} ${count}`;
          ordered.push({
            kind: 'projected',
            step: {
              id: `summary-${observedIndex++}`,
              kind: 'tool',
              weight: 'observation',
              title: label,
              label: clamp(label, MAX_LEDGER_LABEL),
              outcome: 'success',
              toolKind: verb,
            },
          });
        }
      }
      continue;
    }
    if (item.kind !== 'tool') continue;
    const id = item.id ?? `anonymous-${anonymousIndex++}`;
    if (!tools.has(id)) ordered.push({ kind: 'tool', id });
    tools.set(id, mergeToolActivity(tools.get(id), item));
  }

  const toolEntries = [...tools.entries()];
  const toolSteps = new Map<string, TurnActivityAction>();
  const actions: TurnActivityAction[] = [];
  const observations: TurnActivityAction[] = [];
  const localVerbs = new Map<string, number>();
  toolEntries.forEach(([id, tool], entryIndex) => {
    const recoveredAfter = toolEntries
      .slice(entryIndex + 1)
      .some(([, later]) => !isFailure(later));
    if ((settled || recoveredAfter) && isHarnessStartupWarning(tool)) {
      const summary = clamp(
        oneLine(failureReason(tool) ?? redactPaths(cleanTitle(tool.title))) ||
          'Harness startup warning',
        120,
      );
      const row: TurnActivityAction = {
        id,
        kind: 'note',
        startupWarning: true,
        weight: 'observation',
        title: summary,
        label: summary,
        outcome: 'success',
        ...(tool.toolOutput ? { toolOutput: tool.toolOutput } : {}),
        ...((tool.output ?? tool.text) ? { output: tool.output ?? tool.text } : {}),
        ...(tool.requestedBy ? { requestedBy: { ...tool.requestedBy } } : {}),
      };
      toolSteps.set(id, row);
      return;
    }
    const weight = actionWeight(tool);
    const title = actionTitle(tool) ?? cleanTitle(tool.title) ?? 'Tool';
    const reason = weight === 'failure' ? failureReason(tool) : undefined;
    const row: TurnActivityAction = {
      id,
      kind: 'tool',
      ...(tool.toolGroup ? { toolGroup: tool.toolGroup } : {}),
      ...(tool.toolOutput ? { toolOutput: tool.toolOutput } : {}),
      weight,
      title,
      label: ledgerStepLabel(tool),
      outcome: activityOutcome(tool),
      ...(reason ? { reason } : {}),
      ...(tool.toolKind ? { toolKind: tool.toolKind } : {}),
      ...(tool.status ? { status: tool.status } : {}),
      ...(tool.command ? { command: tool.command } : {}),
      ...(tool.input ? { input: tool.input } : {}),
      ...((tool.output ?? tool.text) ? { output: tool.output ?? tool.text } : {}),
      ...(tool.requestedBy ? { requestedBy: { ...tool.requestedBy } } : {}),
      ...(tool.files?.length ? { files: tool.files.map((file) => ({ ...file })) } : {}),
    };
    toolSteps.set(id, row);
    if (weight === 'observation') {
      observations.push(row);
      const verb = observationVerb(tool, title);
      localVerbs.set(verb, (localVerbs.get(verb) ?? 0) + 1);
    } else {
      actions.push(row);
    }
  });

  const steps = ordered.flatMap((entry) => {
    if (entry.kind === 'projected') return [entry.step];
    const step = toolSteps.get(entry.id);
    return step ? [step] : [];
  });
  for (const step of steps) {
    if (step.kind === 'tool' && step.weight === 'observation' && !toolSteps.has(step.id)) {
      observations.push(step);
    }
  }
  const verbs = new Map(localVerbs);
  for (const [verb, count] of wireRollup) verbs.set(verb, (verbs.get(verb) ?? 0) + count);
  const total = [...verbs.values()].reduce((sum, count) => sum + count, 0);

  return {
    narration,
    steps,
    actions,
    observations,
    ...(total ? { note: noteText(total, verbs), liveNote: liveNoteText(total, verbs) } : {}),
    noteCount: total,
    ...(thoughtMs > 0 ? { thoughtMs } : {}),
    ...(plan ? { plan } : {}),
  };
}

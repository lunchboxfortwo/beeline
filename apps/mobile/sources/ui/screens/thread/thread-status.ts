import type { CornerLifecycleView, CornerState } from '@beeline/api-contract/phone';

/**
 * The words a thread's server state reads as (header B). The server owns the
 * state; these only name it. A thread waiting on you or in review is brass,
 * a working one green, anything else the strong stroke.
 */
const STATE_WORD: Record<CornerState, string> = {
  working: 'Working',
  waiting: 'Waiting on you',
  review: 'In review',
  idle: 'Idle',
  archived: 'Archived',
};

export type ThreadDotTone = 'needsYou' | 'added' | 'strongStroke';

export function threadDotTone(state: CornerState): ThreadDotTone {
  if (state === 'waiting' || state === 'review') return 'needsYou';
  return state === 'working' ? 'added' : 'strongStroke';
}

/** "In review · 2 running"; the running count shows only when something runs. */
export function threadStatusText(state: CornerState, running: number): string {
  return `${STATE_WORD[state]}${running > 0 ? ` · ${running} running` : ''}`;
}

/** A thread line's second line in lists: "waiting on you", "review", "done". */
export function threadListWord(state: CornerState): string {
  if (state === 'waiting') return 'waiting on you';
  return state === 'archived' ? 'done' : state;
}

/**
 * The PR row under a thread's status: "#4181 · Open · All 14 checks passed".
 * Undefined until a pull request exists.
 */
export function threadPrLine(lifecycle: CornerLifecycleView | undefined, archived: boolean): string | undefined {
  const pr = lifecycle?.pr;
  if (!pr) return undefined;
  const head = `#${pr.number}`;
  if (pr.mergedAt || lifecycle.outcome === 'landed') return `${head} · Merged`;
  if (archived) return `${head} · Closed`;
  const state = pr.mergeability === 'draft' ? 'Draft' : 'Open';
  return `${head} · ${state} · ${checksText(lifecycle)}`;
}

function checksText(lifecycle: CornerLifecycleView): string {
  const pr = lifecycle.pr!;
  if (lifecycle.mergeQueue && lifecycle.mergeQueue.headSha === pr.headSha) return 'Queued · testing on latest main';
  if (pr.mergeability === 'dirty') return 'Merge conflict';
  const summary = lifecycle.checksSummary;
  const checks = summary?.checks ?? [];
  const total = summary?.total || checks.length;
  const status = summary?.status ?? lifecycle.checks;
  if (total === 0 && status !== 'pending') return 'No checks configured';
  switch (status) {
    case 'failing': {
      const failed = checks.filter((check) => check.status === 'failed');
      const count = failed.length || summary?.failing.length || 0;
      const name = failed[0]?.name ?? summary?.failing[0];
      const label = `${count || ''} ${plural(count, 'check')} failed`.trim();
      return name ? `${label} · ${name.trim()}` : label;
    }
    case 'passing':
      return `All ${total} ${plural(total, 'check')} passed`;
    case 'pending': {
      if (total === 0) return 'Checks running';
      const passed = checks.filter((check) => check.status === 'passed' || check.conclusion === 'skipped').length;
      return `${passed} of ${total} ${plural(total, 'check')} passed · running`;
    }
    default:
      return 'No checks configured';
  }
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

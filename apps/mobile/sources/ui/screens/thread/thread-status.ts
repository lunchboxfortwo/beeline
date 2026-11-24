import { threadActivityLabel, threadWorkState, type CornerBlocker, type CornerLifecycleView, type CornerState, type CornerStateReason } from '@beeline/api-contract/phone';

/** The facts a list line reads: the server's state and, while waiting, its blocker. */
export type ThreadWaitFacts = { readonly workingAgentName?: string; readonly state: CornerState; readonly blocker?: CornerBlocker; readonly reason?: CornerStateReason };

/**
 * A thread line's second line in lists, per viewer: "waiting on you" (`you`,
 * drawn semibold) for the person the thread waits on, "waiting on Claude"
 * for everyone else, then "review", "working", "backlog", "idle", "done"; one corner state drives both.
 */
export function threadListLabel(thread: ThreadWaitFacts, viewer: string | undefined): { word: string; you: boolean } {
  if (threadActivityLabel(thread)) return { word: threadActivityLabel(thread)!, you: false };
  const work = threadWorkState(thread, viewer);
  if (work === 'needs-you') return { word: 'waiting on you', you: true };
  if (work === 'backlog' || work === 'done') return { word: work, you: false };
  if (thread.state !== 'waiting') return { word: thread.state, you: false };
  const name = thread.blocker?.personName?.trim();
  if (name) return { word: `waiting on ${name}`, you: false };
  if (thread.blocker?.kind === 'ci') return { word: 'waiting on checks', you: false };
  return { word: thread.reason === 'approve' ? 'waiting on approval' : 'waiting on a reply', you: false };
}

/**
 * The PR row under a thread's status: "#4181 · Open · Checks passed".
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
  if (total === 0 && status !== 'pending') return status === 'passing' ? 'No checks set up' : 'No checks ran';
  switch (status) {
    case 'failing': {
      const failed = checks.filter((check) => check.status === 'failed');
      const count = failed.length || summary?.failing.length || 0;
      const label = `${count || ''} ${plural(count, 'check')} failed`.trim();
      return label;
    }
    case 'passing':
      return 'Checks passed';
    case 'pending': {
      if (total === 0) return 'Checks running';
      const passed = checks.filter((check) => check.status === 'passed' || check.conclusion === 'skipped').length;
      return `${passed} of ${total} ${plural(total, 'check')} passed · running`;
    }
    default:
      return 'No checks ran';
  }
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

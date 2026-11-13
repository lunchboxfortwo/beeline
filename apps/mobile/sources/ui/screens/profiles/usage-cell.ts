import { usageHarness, usageTime } from '@/buzz/agent-usage';
import {
  type AgentUsage,
  type UsageRefreshOutcome,
  usageDollars,
  usageNames,
  usageTokens,
  usageWhy,
  usageWindowLabel,
} from '@beeline/api-contract/phone';

/** Longer than the server's 20 s wait for the helper, so its answer always arrives first. */
export const USAGE_REFRESH_CLIENT_TIMEOUT_MS = 25_000;

type Tone = 'warning' | 'danger' | undefined;
/** One column of the Usage cell: a window, an allowance, or a spend figure. */
export type UsageColumn = {
  label: string;
  value: string;
  /** Fraction used; absent for a plain figure with no bar. */
  fill?: number;
  foot?: string;
  tone?: Tone;
};

/**
 * The Usage cell's columns and bottom lines for one snapshot (approved mock).
 * `outcome` is a refresh answer that is not fresh; with it, or with a stored
 * read that was not fresh, the numbers are `muted` and the stamp says why.
 */
export function usageCell(
  usage: AgentUsage,
  harness?: string,
  now = Date.now() / 1000,
  outcome?: UsageRefreshOutcome,
): { columns: UsageColumn[]; note: string; shared?: string; stamp?: string; refreshable?: boolean; muted: boolean } {
  const context = usage.context
    ? `Context ${usageTokens(usage.context.used)} of ${usageTokens(usage.context.size)}`
    : undefined;
  const why = outcome
    ? usageWhy(outcome, usage.machine, usageTime)
    : usage.read
      ? usageWhy(usage.read, usage.machine, usageTime)
      : undefined;
  const muted = Boolean(why);
  const stamp = `updated ${usageTime(usage.updatedAt)}${why ? ` · ${why}` : ''}`;
  const shared = usage.sharedWith?.length ? `Shared with ${usageNames(usage.sharedWith)}` : undefined;
  if (usage.free) {
    const f = usage.free;
    const fraction = f.used / f.limit;
    return {
      columns: [
        f.paused
          ? { label: 'Today', value: 'Paused', fill: 1, foot: `back ${usageTime(f.resetsAt)}`, tone: 'danger' }
          : {
              label: 'Today',
              value: `${usageTokens(f.used)} of ${usageTokens(f.limit)}`,
              fill: fraction,
              foot: `resets ${usageTime(f.resetsAt)}`,
              tone: fraction >= 0.8 ? 'warning' : undefined,
            },
      ],
      note: 'Shared by your free agents · counted by Beeline',
      muted: false,
    };
  }
  if (usage.spend) {
    const s = usage.spend;
    const columns: UsageColumn[] = [
      ...(s.today !== undefined ? [{ label: 'Today', value: usageDollars(s.today) }] : []),
      ...(s.week !== undefined ? [{ label: 'This week', value: usageDollars(s.week) }] : []),
    ];
    if (s.rejected) {
      columns.push({
        label: 'Key limit',
        value: 'Reached',
        fill: 1,
        ...(s.limit ? { foot: `of ${usageDollars(s.limit)}` } : {}),
        tone: 'danger',
      });
    } else if (s.limit) {
      const used = 1 - (s.remaining ?? 0) / s.limit;
      columns.push({
        label: 'Key limit',
        value: `${usageDollars(s.remaining ?? 0)} left`,
        fill: used,
        foot: `of ${usageDollars(s.limit)}`,
        tone: used >= 0.8 ? 'warning' : undefined,
      });
    }
    return {
      columns,
      note: [context, 'OpenRouter key, shared'].filter(Boolean).join(' · '),
      stamp, refreshable: true,
      muted,
    };
  }
  if (usage.windows.length || usage.credits) {
    const counts = new Map<number, number>();
    for (const w of usage.windows) {
      if (w.resetsAt) counts.set(w.resetsAt, (counts.get(w.resetsAt) ?? 0) + 1);
    }
    let sharedReset: number | undefined;
    let most = 1;
    for (const [time, count] of counts) {
      if (count > most) { sharedReset = time; most = count; }
    }
    const credits: UsageColumn[] = usage.credits
      ? [{ label: 'Credits', value: `${Math.floor(usage.credits.remaining).toLocaleString('en-US')} left` }]
      : [];
    const plan = usage.plan ? `${usage.plan} plan` : undefined;
    return {
      columns: [...usage.windows.map((w): UsageColumn => {
        const label = usageWindowLabel(w.rateLimitType, w.label);
        if (w.status === 'rejected')
          return {
            label,
            value: 'Limit',
            fill: 1,
            ...(w.resetsAt ? { foot: `back ${usageTime(w.resetsAt)}` } : {}),
            tone: 'danger',
          };
        const fraction = w.utilization ?? 0;
        return {
          label,
          value: `${Math.round(fraction * 100)}%`,
          fill: fraction,
          ...(w.resetsAt && w.resetsAt !== sharedReset ? { foot: `resets ${usageTime(w.resetsAt)}` } : {}),
          // Brass marks a number near its limit; an untrusted number is not marked.
          tone: fraction >= 0.8 && !muted ? 'warning' : undefined,
        };
      }), ...credits],
      note: [context, usageHarness(harness), plan].filter(Boolean).join(' · '),
      ...(shared ? { shared } : {}),
      stamp: [!muted && sharedReset ? `resets ${usageTime(sharedReset)}` : undefined, stamp].filter(Boolean).join(' · '),
      refreshable: true,
      muted,
    };
  }
  // A plan read that failed before any numbers arrived still says why and can be retried.
  if (why) {
    return {
      columns: [],
      note: [context, usageHarness(harness), usage.plan ? `${usage.plan} plan` : undefined].filter(Boolean).join(' · '),
      ...(shared ? { shared } : {}),
      stamp: why,
      refreshable: true,
      muted,
    };
  }
  return {
    columns: [],
    note: [`${usageHarness(harness)} doesn't report usage to Beeline`, context].filter(Boolean).join(' · '),
    muted: false,
  };
}

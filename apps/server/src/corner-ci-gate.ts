import type { GitHubCheckRollup } from '@beeline/auth/github';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';

/** Older cached verdicts do not say whether any checks were required. */
export type CornerCiGate = { headSha: string; checks: 'passing' | 'pending' | 'failing' | null; required?: true };

/**
 * The gate verdict for a rollup read with its base branch. A rollup without
 * the base branch's protection keeps the whole-rollup verdict.
 */
export function ciGateChecks(rollup: GitHubCheckRollup): GitHubCheckRollup['state'] {
  const required = rollup.required;
  if (!required) return rollup.state;
  const passed = rollup.passedContexts ??
    rollup.checks.filter((check) => check.status === 'passed').map((check) => ({ name: check.name, appId: null }));
  let pending = false;
  for (const check of required) {
    if (passed.some((item) => item.name === check.name && (check.appId === null || item.appId === check.appId)))
      continue;
    if (rollup.checks.some((item) => item.name === check.name && item.status === 'failed')) return 'failed';
    pending = true;
  }
  return pending ? 'pending' : 'passed';
}

/** The stored gate for a rollup read with its base branch; none otherwise. */
export function cornerCiGate(rollup: GitHubCheckRollup, headSha: string): CornerCiGate | undefined {
  if (!rollup.required) return undefined;
  if (!rollup.required.length) return { headSha, checks: null };
  const checks = ciGateChecks(rollup);
  return { headSha, required: true, checks: checks === 'passed' ? 'passing' : checks === 'failed' ? 'failing' : 'pending' };
}

export function storedCornerCiGate(
  lifecycle: CornerLifecycleView | undefined,
  headSha: string | undefined,
) {
  const gate = (lifecycle as { ciGate?: CornerCiGate } | undefined)?.ciGate;
  return gate?.headSha === headSha ? gate : undefined;
}

export function cornerGateChecks(
  lifecycle: CornerLifecycleView | undefined,
  headSha: string | undefined,
  purpose: 'merge' | 'review' = 'merge',
): CornerLifecycleView['checks'] | undefined {
  const gate = storedCornerCiGate(lifecycle, headSha);
  if (gate && purpose === 'merge') return gate.checks ?? 'passing';
  return (gate?.required ? gate.checks : undefined) ?? lifecycle?.checks ?? lifecycle?.checksSummary?.status;
}

/** Review follows the required gate or falls back to the displayed rollup. */
export function cornerReviewChecksSql(lifecycle: string): string {
  return `COALESCE(CASE WHEN ${lifecycle}->'ciGate'->>'headSha'=${lifecycle}->'pr'->>'headSha'
    AND ${lifecycle}->'ciGate'->>'required'='true'
    THEN ${lifecycle}->'ciGate'->>'checks' END,${lifecycle}->>'checks',${lifecycle}->'checksSummary'->>'status')`;
}

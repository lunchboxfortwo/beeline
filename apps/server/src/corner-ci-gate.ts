import type { GitHubCheckRollup } from '@beeline/auth/github';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';

/**
 * The CI gate of one head, stored beside the displayed checks. Only branch
 * protection on the base branch creates a gate, and the gate is exactly its
 * required checks. A base with no required checks has no gate, so its checks
 * count as passed. Workflow files and elapsed time never decide it.
 */
export type CornerCiGate = { headSha: string; checks: 'passing' | 'pending' | 'failing' };

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
  const checks = ciGateChecks(rollup);
  return { headSha, checks: checks === 'passed' ? 'passing' : checks === 'failed' ? 'failing' : 'pending' };
}

/** The checks verdict that gates review and landing for this head. */
export function cornerGateChecks(
  lifecycle: CornerLifecycleView | undefined,
  headSha: string | undefined,
): CornerLifecycleView['checks'] | undefined {
  const gate = (lifecycle as { ciGate?: CornerCiGate } | undefined)?.ciGate;
  if (gate && headSha && gate.headSha === headSha) return gate.checks;
  return lifecycle?.checks ?? lifecycle?.checksSummary?.status;
}

/** SQL for the gate verdict of a stored lifecycle expression, as `cornerGateChecks`. */
export function cornerGateChecksSql(lifecycle: string): string {
  return `CASE WHEN ${lifecycle}->'ciGate'->>'headSha'=${lifecycle}->'pr'->>'headSha'
    THEN ${lifecycle}->'ciGate'->>'checks' ELSE ${lifecycle}->>'checks' END`;
}

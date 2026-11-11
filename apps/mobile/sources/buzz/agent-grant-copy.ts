import type { AgentGrantView } from '@beeline/api-contract/phone';
import { connectionInstallName } from '@beeline/api-contract/agent-grants';

/**
 * The words on a grant card and on the profile's grant list. One verb per kind
 * (mirrors `AGENT_GRANT_VERBS` in the contract); the card prints
 * `<verb> <target>` and the settled line prints who allowed what, and when,
 * exactly the way the write-permission card settles into its outcome line.
 */
const VERBS: Readonly<Record<AgentGrantView['kind'], string>> = {
  path: 'read',
  host: 'reach',
  secret: 'use',
  device: 'use',
  budget: 'spend',
  command: 'run',
  mcp: 'use',
  repository: 'edit',
  shared_asset: 'isolate',
};

export function grantAskLine(grant: Pick<AgentGrantView, 'kind' | 'target' | 'appName'>): string {
  const app = connectionInstallName(grant);
  if (app) return `connect ${app}`;
  return `${VERBS[grant.kind]} ${grant.target}`;
}

function day(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * The provenance line on the human profile's grant ledger:
 * `approved by Charles, 24 Sep 2026 · standing` for a standing approval,
 * `· one-time` for a grant consumed by its first run, and `denied by` /
 * `revoked by` for the two settled refusals (a refusal has no duration to
 * state). `· auto-approved` marks automatic access, and an expiry is appended
 * when the vault recorded one. It states a date and the grant's standing, which is what a ledger row is read for.
 */
export function grantProvenanceLine(
  grant: Pick<
    AgentGrantView,
    'status' | 'decidedBy' | 'decidedAt' | 'createdAt' | 'expiresAt' | 'auto'
  >,
): string {
  const who = grant.auto && !grant.decidedBy ? 'Beeline' : (grant.decidedBy?.name ?? 'the owner');
  const settledAt = grant.decidedAt ?? grant.createdAt;
  const verb =
    grant.status === 'denied'
      ? 'denied by'
      : grant.status === 'revoked'
        ? 'revoked by'
        : 'approved by';
  const parts = [`${verb} ${who}, ${day(settledAt)}`];
  if (grant.status === 'approved') parts.push('standing');
  if (grant.status === 'once') parts.push('one-time');
  if (grant.auto) parts.push('auto-approved');
  if (grant.expiresAt !== undefined) parts.push(`expires ${day(grant.expiresAt)}`);
  return parts.join(' · ');
}

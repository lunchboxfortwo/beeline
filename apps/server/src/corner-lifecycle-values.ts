import type { PostCornerRemoteStateInput } from '@beeline/api-contract/daemon';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';
import type { AgentCommandInput,CommandRow } from './agent-command.js';



export const CORNER_LIFECYCLE_SLUG = 'corner';

export const OK: Applied = { ok: true };


/** Expand only: old lifecycle cards remain inert for the previous image. */
export const CORNER_MACHINE_SCHEMA = `
ALTER TABLE corner_facts ADD COLUMN IF NOT EXISTS machine jsonb;
`;


// Compare check results, not refresh timestamps, attempts or run URLs.
export const reviewChecksSql = `jsonb_build_object('status',lifecycle->>'checks','checks',
  (SELECT jsonb_agg(jsonb_build_object('name',item->>'name','status',item->>'status') ORDER BY item->>'name')
   FROM jsonb_array_elements(COALESCE(lifecycle->'checksSummary'->'checks','[]'::jsonb)) item))`;


export function greenReviewRequestSql(command: string): string {
  return `${command}.action='input' AND ${command}.reason IN ('corner_review_dispatch','agent_tag','order','message')
    AND ${command}.review_context->>'purpose' IS NULL
    AND ${command}.review_context->'checks'->>'status'='passing'`;
}

export type RevisionWake = { queued: boolean; agentId?: string; reason?: string };

export type CornerAdvance = {
  archived?: boolean;
  /** Claimed once for this PR head; the caller lands after commit. */
  land?: boolean;
  state: string | undefined;
  accepted: boolean;
  wake?: RevisionWake;
  command?: CommandRow;
};

export type Applied = { ok: true; wake?: RevisionWake };

export type CornerEvent =
  | {
      kind: 'open';
      command?: AgentCommandInput;
    }
  | { kind: 'push'; headSha: string; contents: Record<string, unknown> }
  /** A failing verdict cites its System line; a passing verdict has no line. */
  | { kind: 'checks'; result: 'passing' | 'failing'; sourceMessageId?: string }
  | {
      kind: 'brief-revised';
      revision: number;
      sourceMessageId: string;
      command: CommandRow;
    }
  /** Checks started again on the same head (a re-run); the verdict that follows is reported as `checks`. */
  | { kind: 'checks-pending' }
  | { kind: 'hold-released' }
  /** The configured reviewer's PASS on this head; the server lands after commit. */
  | { kind: 'approval'; headSha: string; by: 'reviewer' }
  | { kind: 'merge-refused'; headSha: string; reason: string; confirmedUnmerged?: boolean }
  | { kind: 'merged'; contents: Record<string, unknown> }
  | { kind: 'closed' }
  /** update_work moved the thread into (true) or out of (false) Backlog. */
  | { kind: 'backlog'; backlog: boolean }
  | { kind: 'merge-conflict'; sourceMessageId: string }
  | { kind: 'reconcile' };

/** Observations admitted by the lifecycle owner; adapters never receive a SQL writer. */
export type CornerGithubFact =
  | { kind: 'seeded'; lifecycleJson: string | null }
  | { kind: 'github-observed'; patch: Partial<Pick<CornerLifecycleView, 'pr' | 'checks' | 'checksSummary'>> }
  | { kind: 'pr-opened'; pr: NonNullable<CornerLifecycleView['pr']> }
  | { kind: 'helper-observed'; remote: Pick<PostCornerRemoteStateInput, 'state' | 'checks' | 'pullRequest'> }
  | { kind: 'checks-unavailable'; headSha: string; fetchStartedAt: number }
  | { kind: 'head-observed'; number: number; from: string; to: string }
  | { kind: 'pr-discovered'; branch: string; pr: NonNullable<CornerLifecycleView['pr']> }
  | { kind: 'pr-forgotten'; number: number }
  | { kind: 'merge-queued'; headSha: string; combinedSha?: string }
  | { kind: 'merge-queue-removed'; headSha: string }
  | { kind: 'merged'; locked: boolean; pr?: NonNullable<CornerLifecycleView['pr']>;
      mergedAt?: string; mergeCommitSha?: string; mergedBy?: string }
  | { kind: 'zero-checks-confirmed'; fetchStartedAt: number };

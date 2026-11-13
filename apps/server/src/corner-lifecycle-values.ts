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


export const REVIEWER_NOT_PARENT_MEMBER = 'not a current member of the parent Room';

export const REVIEWER_NOT_CORNER_MEMBER = 'not a current member of this corner';

export function greenReviewRequestSql(command: string): string {
  return `${command}.action='input' AND ${command}.reason IN ('corner_review_dispatch','agent_tag','order')
    AND ${command}.review_context->>'purpose' IS NULL
    AND ${command}.review_context->'checks'->>'status'='passing'`;
}

export type RevisionWake = { queued: boolean; agentId?: string; reason?: string };

export type CornerAdvance = {
  archived?: boolean;
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
  | { kind: 'checks'; result: 'passing' | 'failing'; sourceMessageId: string }
  | {
      kind: 'brief-revised';
      revision: number;
      sourceMessageId: string;
      command: CommandRow;
    }
  /** Checks started again on the same head (a re-run); the verdict that follows is reported as `checks`. */
  | { kind: 'checks-pending' }
  /** A yes on this head: a reviewer's PASS or a person's order, landed by the caller. */
  | { kind: 'approval'; headSha: string; by: 'reviewer' | 'person' }
  | { kind: 'merge-refused'; headSha: string; reason: string; confirmedUnmerged?: boolean }
  | { kind: 'merged'; contents: Record<string, unknown> }
  | { kind: 'pull-request-closed'; number: number }
  | { kind: 'closed' }
  | { kind: 'merge-conflict'; sourceMessageId: string }
  | { kind: 'reconcile' };

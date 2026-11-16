import { CommandRefusalError } from './command-refusal.js';
import type { SqlDatabase } from './database.js';

/**
 * The configured reviewer's head-bound PASS.
 * One row per corner; a new commit cancels it because the gate matches the
 * exact head. A brief edit does not.
 */
export async function recordCornerMergeApproval(
  database: SqlDatabase,
  input: {
    cornerId: string;
    approvedBy: string;
    pullRequestNumber: number;
    headSha: string;
  },
): Promise<boolean> {
  const approval = await database.query(
    `INSERT INTO corner_merge_approvals(corner_id,approved_by,pull_request_number,head_sha)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(corner_id) DO UPDATE SET
       approved_by=EXCLUDED.approved_by,
       pull_request_number=EXCLUDED.pull_request_number,head_sha=EXCLUDED.head_sha,
       approved_at=now()
      WHERE corner_merge_approvals.pull_request_number IS DISTINCT FROM EXCLUDED.pull_request_number
        OR corner_merge_approvals.head_sha IS DISTINCT FROM EXCLUDED.head_sha
        OR corner_merge_approvals.approved_by IS DISTINCT FROM EXCLUDED.approved_by
     RETURNING corner_id`,
    [input.cornerId, input.approvedBy, input.pullRequestNumber, input.headSha],
  );
  return Boolean(approval.rowCount);
}

/**
 * Why the server refused to record a reviewer's PASS. The code leads the
 * message, so the agent that called `approve_merge` reads which rule failed.
 */
export type CornerVerdictRejection =
  | 'NOT_CONFIGURED_REVIEWER'
  | 'NO_PULL_REQUEST'
  | 'STALE_HEAD';

export class CornerVerdictRejectedError extends CommandRefusalError {
  constructor(
    readonly code: CornerVerdictRejection,
    detail: string,
  ) {
    super(`${code}: ${detail}`, 409);
    this.name = 'CornerVerdictRejectedError';
  }
}

/** A changed corner reviewer never inherits an earlier agent's PASS. */
export async function withdrawAgentMergeApprovals(db: SqlDatabase, cornerId: string): Promise<void> {
  await db.query(`DELETE FROM corner_merge_approvals approval USING identities identity
    WHERE approval.corner_id=$1 AND identity.id=approval.approved_by AND identity.kind='agent'`, [cornerId]);
}

/** A closed pull request takes its yeses with it. */
export async function withdrawPullRequestMergeApprovals(db: SqlDatabase, cornerId: string, number: number): Promise<void> {
  await db.query(`DELETE FROM corner_merge_approvals WHERE corner_id=$1 AND pull_request_number=$2`, [cornerId, number]);
}

/** Account deletion: a deleted identity's yeses no longer stand. */
export async function withdrawMergeApprovalsBy(db: SqlDatabase, identityIds: string[]): Promise<void> {
  await db.query(`DELETE FROM corner_merge_approvals WHERE approved_by=ANY($1)`, [identityIds]);
}

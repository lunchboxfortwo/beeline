import { ROUTER_AUTHORITY_LOCK } from './router-authority-lock.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { missingReviewAttachments } from './review-evidence.js';
import { cornerReviewerSql } from './corner-reviewer.js';
import { CornerAccessDatabase } from './corner-access-database.js';
import { isZeroCheckCommander } from './corner-merge-approval.js';
import { reportToCommander } from './commander.js';
import type { activeCornerHolds } from './corner-holds.js';
import { createHash } from 'node:crypto';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import { assertCornerBriefAllowsMerge } from './corner-brief.js';
import { cornerImplementerSql } from './corner-worker.js';

import { CornerRow, loadCorner } from './corner-lifecycle-read-state.js';
import { greenReviewRequestSql, CORNER_LIFECYCLE_SLUG } from './corner-lifecycle-values.js';



export async function lockCornerLifecycle(db: SqlDatabase, cornerId: string): Promise<void> {
  await db.query('SELECT corner_id FROM corner_facts WHERE corner_id=$1 FOR UPDATE', [cornerId]);
}


/** Archival writers take lifecycle first, then authority before command or
 * Room/member locks. Acquiring only at the archival trigger is too late. */
export async function lockCornerArchivalAuthority(database: SqlDatabase): Promise<void> {
  await database.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [ROUTER_AUTHORITY_LOCK]);
}


/** Delivery diagnostic requires a green-head request, never a notice or the broad Review badge. */
export function cornerReviewWokenSql(cornerId: string): string {
  return `EXISTS(SELECT 1 FROM agent_commands review JOIN rooms corner ON corner.id=review.room_id
    JOIN rooms parent ON parent.id=corner.parent_id JOIN corner_github_cache cache ON cache.corner_id=corner.id WHERE corner.id=${cornerId}
      AND review.agent_id=${cornerReviewerSql()} AND ${greenReviewRequestSql('review')}
      AND review.reason='corner_review_dispatch' AND review.state IN ('pending','claimed','complete')
      AND review.review_context->>'headSha'=cache.lifecycle->'pr'->>'headSha'
      AND review.review_context->'pullRequest'=cache.lifecycle->'pr'->'number')`;
}


export async function noteReviewDispatchFailure(
  db: SqlDatabase,
  cornerId: string,
  headSha: string,
  reason: string,
): Promise<void> {
  await reportToCommander(
    db,
    cornerId,
    SYSTEM_IDENTITY_ID,
    systemMessage('corner-lifecycle.blocked', reason),
    undefined,
    createHash('sha256').update(`review-dispatch:${cornerId}:${headSha}:${reason}`).digest('hex'),
    { agentOnly: true },
  );
}


export async function loadCornerReviewState(db: SqlDatabase, cornerId: string, headSha: string | undefined) {
  const empty = {pending:false,requests:0,ended:undefined as undefined | {
    id:string;findings?:string;emptyCount:number;delivered:boolean;
  }};
  if(!headSha) return empty;
  const rows=(await db.query<{id:string;state:string;ended:boolean;findings:string|null;delivered:boolean}>(
    `SELECT command.id,command.state,
      command.state IN ('complete','cancelled') AND NOT EXISTS (SELECT 1 FROM agent_turns running
        WHERE running.room_id=command.room_id AND running.agent_id=command.agent_id
          AND running.request_id=command.turn_request_id AND running.status='working') ended,
      verdict.text findings,COALESCE(verdict.delivered,false) delivered
     FROM agent_commands command JOIN rooms corner ON corner.id=command.room_id
     JOIN rooms parent ON parent.id=corner.parent_id
     LEFT JOIN LATERAL (
       SELECT repair.private_payload->>'text' text,true delivered FROM agent_commands repair
       WHERE repair.parent_command_id=command.id AND repair.reason='order'
         AND repair.private_payload->>'authorId'=command.agent_id
         AND repair.review_context->>'purpose'='repair' AND repair.private_payload->>'text' ~* $3
       UNION ALL
       SELECT message.text,false FROM messages message
       WHERE message.room_id=command.room_id AND message.author_id=command.agent_id
         AND (message.id=command.result_message_id OR message.request_id=command.turn_request_id
           OR message.id IN (SELECT jsonb_array_elements_text(COALESCE(command.review_context->'reportIds','[]'::jsonb))))
         AND message.deleted_at IS NULL AND message.text ~* $3
       UNION ALL
       SELECT report.private_payload->>'text',false FROM agent_commands report
       WHERE report.id IN (SELECT jsonb_array_elements_text(COALESCE(command.review_context->'reportIds','[]'::jsonb)))
         AND report.private_payload->>'authorId'=command.agent_id AND report.private_payload->>'text' ~* $3
       ORDER BY delivered DESC LIMIT 1
     ) verdict ON true
     WHERE command.room_id=$1 AND command.agent_id=${cornerReviewerSql()}
       AND (command.state<>'cancelled' OR EXISTS (SELECT 1 FROM agent_turns finished
         WHERE finished.room_id=command.room_id AND finished.agent_id=command.agent_id
           AND finished.request_id=command.turn_request_id AND finished.status<>'working'))
       AND ${greenReviewRequestSql('command')} AND command.review_context->>'headSha'=$2
       AND command.review_context->'pullRequest'=(SELECT lifecycle->'pr'->'number' FROM corner_github_cache WHERE corner_id=$1)
     ORDER BY command.inbox_sequence DESC`,
    [cornerId,headSha,String.raw`(^|\n)[[:space:]>#*-]*(@[[:alnum:]_-]+[[:space:]]+)?((done|failed|blocked):[[:space:]]*)?(verdict:[[:space:]]*)?FAIL([[:space:]:*]|$)|(^|[[:space:]])F[0-9]+:|\mneeds? (a )?fix\M|\mfix (that|the|this)\M|\mbefore I can PASS\M`],
  )).rows;
  const latest=rows[0];
  let emptyCount=0;
  for(const row of rows) {if(!row.ended || row.findings) break; emptyCount++;}
  return {pending:rows.some(row=>row.state==='pending'||row.state==='claimed'),requests:rows.length,
    ended:latest && (latest.ended||latest.findings) ? {id:latest.id,findings:latest.findings??undefined,
      emptyCount,delivered:latest.delivered}:undefined};
}


/** A reviewer is configured and is not the implementer it would review. */
export function independentReviewerConfigured(corner: CornerRow): boolean {
  return (
    Boolean(corner.configured_reviewer_id) &&
    corner.configured_reviewer_id !== corner.worker_agent_id
  );
}


/** Which reviewer a green head wakes: the corner's reviewer, unless it is the implementer. */
export function reachableReviewer(corner: CornerRow): string | undefined {
  const reviewerId = corner.configured_reviewer_id;
  return reviewerId && reviewerId !== corner.worker_agent_id ? reviewerId : undefined;
}


export type CornerMergeGate = {
  /** A reviewer is configured. */
  reviewerExists: boolean;
  /**
   * A yes said on this exact head: a configured reviewer agent's PASS, or a
   * current Workspace owner or admin's order, or the zero-check commander's yes.
   */
  approved: boolean;
  evidenceMissing?: boolean;
  held: boolean;
  holds: Awaited<ReturnType<typeof activeCornerHolds>>;
  /** Everything but checks: a yes on this head and no hold. */
  open: boolean;
};


export type CornerMergeabilityInput = {
  checks: string;
  evidenceMissing?: boolean;
  approved: boolean;
  held: boolean;
  holds: readonly { id: string; holderId?: string; holderName?: string | null }[];
  archived: boolean;
  merged?: boolean;
  expectedHeadSha?: string | null;
  currentHeadSha: string;
  mergeability?: string;
};


/** One verdict and refusal reason for both the checks read and merge command. */
export function cornerMergeability(input: CornerMergeabilityInput) {
  const reasons = [
    input.merged ? 'the pull request is already merged' : '',
    input.archived ? 'the corner is closed' : '',
    input.expectedHeadSha && input.expectedHeadSha !== input.currentHeadSha
      ? 'PR head changed; checks and approval must match the corner head'
      : '',
    input.mergeability === 'draft' ? 'PR is a draft' : '',
    input.mergeability === 'dirty' ? 'GitHub reports merge conflicts with the base branch' : '',
    input.checks !== 'passed' ? `checks are ${input.checks}` : '',
    input.evidenceMissing
      ? 'missing review attachments: attach the screenshots or files claimed by the verdict'
      : input.approved
        ? ''
        : 'no yes on this head',
    input.held
      ? `a hold stands${input.holds.length ? `: ${input.holds.map((hold) => `${hold.id}${hold.holderName ? ` (${hold.holderName}, ${hold.holderId ?? ''})` : ''}`).join('; ')}` : ''}`
      : '',
  ].filter(Boolean);
  return {
    mergeAllowed: reasons.length === 0,
    ...(reasons.length ? { blockedReason: reasons.join('; ') } : {}),
  };
}


/**
 * The merge gate for one exact PR head, minus the checks verdict (the caller
 * supplies that live from GitHub). Shared by `pr_checks_status` and the server
 * merge, so the gate an agent reads is the gate `landCorner` merges on.
 */
export async function cornerMergeGate(
  db: SqlDatabase,
  cornerId: string,
  head: { number: number; headSha: string },
): Promise<CornerMergeGate> {
  db = new CornerAccessDatabase(db);
  const rows = await db.query<{
    configured_reviewer_id: string | null;
    approved: boolean;
    holds: CornerMergeGate['holds'];
  }>(
    `SELECT ${cornerReviewerSql()} configured_reviewer_id,
              EXISTS (
                SELECT 1 FROM corner_merge_approvals approval
                WHERE approval.corner_id=fact.corner_id AND approval.pull_request_number=$2
                  AND approval.head_sha=$3
                  AND (
                    -- The corner's reviewer, who is not its implementer.
                    (approval.approved_by=${cornerReviewerSql()}
                      AND approval.approved_by IS DISTINCT FROM ${cornerImplementerSql('fact', 'corner')})
                    -- Or a current Workspace owner or admin.
                    OR EXISTS (
                      SELECT 1 FROM memberships workspace_member
                      JOIN identities person ON person.id=workspace_member.identity_id AND person.kind='human'
                      WHERE workspace_member.workspace_id=corner.workspace_id
                        AND workspace_member.room_id IS NULL
                        AND workspace_member.identity_id=approval.approved_by
                        AND workspace_member.removed_at IS NULL
                        AND workspace_member.role IN ('owner','admin')
                    )
                  )
              ) approved,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('id',hold.id::text,'actorId',hold.actor_id,
                'holderId',COALESCE(hold.set_by_agent_id,hold.actor_id),'holderName',(SELECT name FROM identities WHERE id=COALESCE(hold.set_by_agent_id,hold.actor_id)),
                'sourceMessageId',hold.source_message_id,'sourceAuthorId',hold.source_author_id,
                'sourceAuthorName',(SELECT name FROM identities WHERE id=hold.source_author_id),'sourceText',hold.source_text,
                'standing',hold.standing,'setAt',hold.set_at::text) ORDER BY hold.set_at,hold.id)
                FROM corner_merge_holds hold WHERE hold.corner_id=fact.corner_id AND hold.released_at IS NULL),
                '[]'::jsonb) holds
       FROM corner_facts fact
       JOIN rooms corner ON corner.id=fact.corner_id
       JOIN rooms parent ON parent.id=corner.parent_id
       WHERE fact.corner_id=$1`,
    [cornerId, head.number, head.headSha],
  );
  const corner = rows.rows[0];
  if (!corner) throw new Error('corner not found');
  if (!corner.approved && !corner.configured_reviewer_id) {
    const approval = (
      await db.query<{ approved_by: string }>(
        `SELECT approved_by FROM corner_merge_approvals
       WHERE corner_id=$1 AND pull_request_number=$2 AND head_sha=$3`,
        [cornerId, head.number, head.headSha],
      )
    ).rows[0];
    if (approval) corner.approved = await isZeroCheckCommander(db, cornerId, approval.approved_by);
  }
  const approval = (
    await db.query<{ approved_by: string }>(
      `SELECT approval.approved_by FROM corner_merge_approvals approval JOIN identities reviewer
       ON reviewer.id=approval.approved_by AND reviewer.kind='agent'
     WHERE corner_id=$1 AND pull_request_number=$2 AND head_sha=$3`,
      [cornerId, head.number, head.headSha],
    )
  ).rows[0];
  const evidenceMissing = Boolean(
    approval && (await missingReviewAttachments(db, cornerId, head, approval.approved_by)),
  );
  if (evidenceMissing) corner.approved = false;
  const held = corner.holds.length > 0;
  return {
    ...(evidenceMissing ? { evidenceMissing: true } : {}),
    reviewerExists: Boolean(corner.configured_reviewer_id),
    approved: corner.approved,
    held,
    holds: corner.holds,
    open: corner.approved && !held,
  };
}


/**
 * Rechecks local merge authority under the run lock after the live gate read,
 * immediately before GitHub is asked to merge: the corner is open, the head
 * is unchanged, the brief still assigns repository work, a yes stands on this
 * head and no hold stands. Nothing is stored. GitHub's expected-head merge
 * merges a pull request at most once; a concurrent second attempt reads the
 * live pull request and confirms the merge instead of reporting a refusal.
 */
export async function confirmCornerMergeAuthority(
  database: SqlDatabase,
  cornerId: string,
  headSha: string,
  onBlocked?: (reason: string) => void,
): Promise<boolean> {
  const blocked = (reason: string) => {
    onBlocked?.(reason);
    return false;
  };
  return database.transaction(async (db) => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const corner = await loadCorner(db, cornerId, false);
    const pr = corner?.lifecycle.pr;
    if (!corner) return blocked('the corner no longer exists');
    if (corner.archived) return blocked('the corner is archived');
    if (!pr?.number) return blocked('the corner has no pull request');
    if (pr.headSha !== headSha) return blocked('the pull request head changed before the merge');
    // Brief, approval and hold are read from the same committed snapshot.
    await assertCornerBriefAllowsMerge(db, cornerId);
    const gate = await cornerMergeGate(db, cornerId, { number: pr.number, headSha });
    if (!gate.open)
      return blocked(
        gate.evidenceMissing
          ? 'missing review attachments: attach the screenshots or files claimed by the verdict'
          : gate.held
            ? 'a hold stands'
            : 'no yes on this head',
      );
    return true;
  });
}


export async function deleteStoredCornerWorkflows(database: SqlDatabase): Promise<number> {
  const deleted = await database.query(
    `DELETE FROM workspace_skills skill
     WHERE skill.slug=$1 AND skill.kind='workflow'
       AND EXISTS (
         SELECT 1 FROM workspace_skill_versions version
         WHERE version.skill_id=skill.id AND version.extractor_version='corner-workflow-v1'
       )`,
    [CORNER_LIFECYCLE_SLUG],
  );
  if (deleted.rowCount)
    console.log(
      `deleteStoredCornerWorkflows: deleted ${deleted.rowCount} stored corner workflow(s)`,
    );
  return deleted.rowCount;
}

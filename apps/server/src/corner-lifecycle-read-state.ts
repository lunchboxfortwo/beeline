import { cornerLifecycleSql } from './corner-github-cache.js';
import { cornerReviewerSql } from './corner-reviewer.js';
import { CornerAccessDatabase } from './corner-access-database.js';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { cornerImplementerSql } from './corner-worker.js';
import type { CornerMachine } from './corner-machine.js';
import { cornerCommanderInputSql } from './corner-waiting.js';
import { cornerWaitingReportSql } from './corner-waiting-report.js';

/** Read the question boundary and the newest accepted input, without changing cards.
 * Message probes use the Room/author index once per current chain member.
 * Reports retain their original boundary even if a legacy push marked them answered.
 * Their stored delivery Room is commanderReportAddress's resolved return place;
 * never derive a different route from a later order or the corner parent.
 */
export async function loadCornerQuestion(db: SqlDatabase, cornerId: string, itemId?: string | null) {
  return (await db.query<{
    id: string; asked_at: Date; answered_at: Date | null; text: string; kind: 'message' | 'report';
  }>(`WITH question AS MATERIALIZED (
    SELECT item.id,item.author_id,item.created_at asked_at,item.text,'message'::text kind,item.room_id return_room_id
      FROM messages item WHERE item.id=$2 AND item.text ~ '^(needs-decision|blocked):'
        AND item.card_type IS NULL AND item.deleted_at IS NULL
    UNION ALL
    SELECT command.id,command.private_payload->>'authorId',visible.created_at,
      command.private_payload->>'text','report',command.room_id FROM agent_commands command
      JOIN messages visible ON visible.id=encode(sha256(convert_to('agent-command-card:'||command.id,'UTF8')),'hex')
      WHERE command.id=$2 AND command.private_payload->>'kind'='report'
    UNION ALL
    SELECT COALESCE(report.report_id,report.message_id),${cornerImplementerSql('question_fact', 'question_corner')},
      report.asked_at,COALESCE(command.private_payload->>'text',message.text),
      CASE WHEN report.report_id IS NULL THEN 'message' ELSE 'report' END,report.return_room_id
      FROM rooms question_corner JOIN corner_facts question_fact ON question_fact.corner_id=question_corner.id
      CROSS JOIN LATERAL (${cornerWaitingReportSql('question_corner', true)}) report
      LEFT JOIN agent_commands command ON command.id=report.report_id
      LEFT JOIN messages message ON message.id=report.message_id
      WHERE question_corner.id=$1 AND $2::text IS NULL
  ) SELECT question.id,question.asked_at,question.text,question.kind,max(answer.answered_at) answered_at
    FROM question JOIN rooms question_corner ON question_corner.id=$1
    LEFT JOIN LATERAL (${cornerCommanderInputSql('question_corner','question.author_id','question.asked_at','question.return_room_id')}) answer ON true GROUP BY question.id,question.asked_at,question.text,question.kind
    ORDER BY question.asked_at DESC LIMIT 1`, [cornerId,itemId ?? null])).rows[0];
}



export type CornerRow = {
  machine: CornerMachine | null;
  parent_id: string;
  worker_agent_id: string | null;
  lifecycle: CornerLifecycleView;
  archived: boolean;
  locked: boolean;
  configured_reviewer_id: string | null;
  configured_reviewer_kind: string | null;
  configured_reviewer_name: string | null;
  reviewer_parent_member: boolean;
};


export async function loadCorner(db: SqlDatabase, cornerId: string, retain: boolean | 'skip-locked' = true): Promise<CornerRow | undefined> {
  db = new CornerAccessDatabase(db);
  return (
    await db.query<CornerRow>(
      `SELECT fact.machine,corner.parent_id,
              ${cornerImplementerSql('fact', 'corner')} worker_agent_id,
              ${cornerLifecycleSql('fact.corner_id')},fact.locked,
              corner.archived_at IS NOT NULL archived,
              ${cornerReviewerSql()} configured_reviewer_id,
              configured.kind configured_reviewer_kind,
              configured.name configured_reviewer_name,
              EXISTS (
                SELECT 1 FROM memberships reviewer_membership
                JOIN identities reviewer ON reviewer.id=reviewer_membership.identity_id
                  AND reviewer.kind='agent'
                WHERE reviewer_membership.room_id=parent.id
                  AND reviewer_membership.identity_id=${cornerReviewerSql()}
                  AND reviewer_membership.removed_at IS NULL
              ) reviewer_parent_member
       FROM corner_facts fact
       JOIN rooms corner ON corner.id=fact.corner_id
       JOIN rooms parent ON parent.id=corner.parent_id
       LEFT JOIN identities configured ON configured.id=${cornerReviewerSql()}
       WHERE fact.corner_id=$1
       ${retain === 'skip-locked' ? 'FOR UPDATE OF fact SKIP LOCKED' : retain ? 'FOR UPDATE OF fact' : ''}`,
      [cornerId],
    )
  ).rows[0];
}


export * from './corner-machine.js';

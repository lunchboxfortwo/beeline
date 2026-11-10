import { commanderChainSql } from './commander.js';
import { cornerImplementerSql } from './corner-worker.js';
import { cornerWaitingReportSql, reportAnswerMessageSql } from './corner-waiting-report.js';
import type { SqlDatabase } from './database.js';

/** The commander's reply or order resolves every kind of corner wait. */
export function cornerCommanderInputSql(
  corner: string,
  asker: string,
  askedAt: string,
  returnRoom: string,
): string {
  return `SELECT min(input.at) answered_at FROM (${commanderChainSql(corner, asker, askedAt)}) commander
    CROSS JOIN LATERAL (
      SELECT message.created_at at FROM messages message
      WHERE message.room_id IN (${corner}.id,${returnRoom}) AND message.author_id=commander.id
        AND ${reportAnswerMessageSql('message')} AND message.created_at>${askedAt}
      UNION ALL
      SELECT ordered.created_at FROM agent_commands ordered LEFT JOIN messages source ON source.id=ordered.source_message_id
      WHERE ordered.room_id=${corner}.id AND ordered.agent_id=${asker} AND ordered.created_at>=${askedAt}
        AND (ordered.private_payload->>'kind'='order' OR ordered.reason='corner_brief_revision')
        AND COALESCE(ordered.private_payload->>'authorId',source.author_id)=commander.id
    ) input`;
}

/** Source labels remain distinct; their waiting and clearing decisions do not. */
export function cornerWaitingSql(corner: string): string {
  const worker = cornerImplementerSql('waiting_fact', corner);
  return `SELECT waiting.*,CASE WHEN waiting.reason IN ('approve','connect') THEN 'user_action'
      WHEN waiting.text ~ '^blocked:' THEN 'blocked' ELSE 'question' END wait_reason
    FROM corner_facts waiting_fact CROSS JOIN LATERAL (
      SELECT COALESCE(report.message_id,report.report_id) item_id,report.person_id,report.created_at,
        report.return_room_id,report.asked_at,'question'::text reason,
        CASE WHEN report.return_room_id=${corner}.id AND report.message_id IS NOT NULL THEN 'message' ELSE 'report' END kind,
        COALESCE(command.private_payload->>'text',message.text) text,false private
      FROM (${cornerWaitingReportSql(corner)}) report
      LEFT JOIN agent_commands command ON command.id=report.report_id LEFT JOIN messages message ON message.id=report.message_id
      JOIN identities recipient ON recipient.id=report.person_id
        AND (recipient.kind='human' OR report.person_id=report.commander_id)
      UNION ALL
      SELECT owed.message_id,owed.person_id,owed.created_at,item.room_id,item.created_at,
        CASE WHEN item.card_type IN ('squire-approval','permission','grant-request') THEN 'approve'
          WHEN item.card_type IN ('connector-offer','app-sign-in','agent-sign-in') THEN 'connect' ELSE 'question' END,
        'message',item.text,false
      FROM corner_owed owed JOIN messages item ON item.id=owed.message_id
      JOIN memberships member ON member.room_id=${corner}.parent_id AND member.identity_id=owed.person_id AND member.removed_at IS NULL
      WHERE owed.corner_id=${corner}.id AND owed.blocking AND (owed.expires_at IS NULL OR owed.expires_at>now())
      UNION ALL
      SELECT 'grant:'||pending_grant.id::text,NULL::text,pending_grant.created_at,${corner}.id,pending_grant.created_at,'approve',NULL::text,NULL::text,true
      FROM agent_grants pending_grant WHERE pending_grant.room_id=${corner}.id AND pending_grant.status='pending'
        AND pending_grant.superseded_at IS NULL AND (pending_grant.expires_at IS NULL OR pending_grant.expires_at>now())
    ) waiting CROSS JOIN LATERAL (${cornerCommanderInputSql(corner, worker, 'waiting.asked_at', 'waiting.return_room_id')}) answer
    WHERE waiting_fact.corner_id=${corner}.id AND answer.answered_at IS NULL`;
}

export async function loadCornerWaiting(db: SqlDatabase, cornerId: string) {
  return (
    await db.query<{
      item_id: string;
      reason: 'question' | 'approve' | 'connect';
      kind: 'message' | 'report' | null;
      wait_reason: 'blocked' | 'user_action' | 'question';
    }>(
      `SELECT waiting.* FROM rooms waiting_corner CROSS JOIN LATERAL (${cornerWaitingSql('waiting_corner')}) waiting
     WHERE waiting_corner.id=$1 ORDER BY waiting.created_at,waiting.item_id LIMIT 1`,
      [cornerId],
    )
  ).rows[0];
}

export function cornerWaitingFunctionSql(): string {
  return `CREATE OR REPLACE FUNCTION corner_has_explicit_wait(waiting_corner_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $corner_wait$
BEGIN
  RETURN EXISTS (SELECT 1 FROM rooms waiting_corner CROSS JOIN LATERAL (${cornerWaitingSql('waiting_corner')}) waiting
    WHERE waiting_corner.id=waiting_corner_id AND waiting_corner.parent_id IS NOT NULL);
END $corner_wait$;`;
}

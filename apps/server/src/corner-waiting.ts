import { cornerImplementerSql } from './corner-worker.js';
import { cornerWaitingReportSql } from './corner-waiting-report.js';
import type { SqlDatabase } from './database.js';

/** Explicit closure owns worker blocks; native requests keep their terminal owners. */
export function cornerWaitingSql(corner: string): string {
  const worker = cornerImplementerSql('waiting_fact', corner);
  return `SELECT waiting.*
    FROM corner_facts waiting_fact CROSS JOIN LATERAL (
      SELECT COALESCE(report.message_id,report.report_id) item_id,report.person_id,report.created_at,
        report.return_room_id,report.asked_at,'question'::text reason,
        CASE WHEN report.return_room_id=${corner}.id AND report.message_id IS NOT NULL THEN 'message' ELSE 'report' END kind,
        false private,report.asked_items
      FROM (${cornerWaitingReportSql(corner)}) report
      JOIN identities recipient ON recipient.id=report.person_id
        AND (recipient.kind='human' OR report.person_id=report.commander_id)
      UNION ALL
      SELECT owed.message_id,owed.person_id,owed.created_at,item.room_id,item.created_at,
        CASE WHEN item.card_type IN ('squire-approval','permission','grant-request') THEN 'approve'
          WHEN item.card_type IN ('connector-offer','app-sign-in','agent-sign-in') THEN 'connect' ELSE 'question' END,
        'message',false,ARRAY[owed.message_id]
      FROM corner_owed owed JOIN messages item ON item.id=owed.message_id
      JOIN memberships member ON member.room_id=${corner}.parent_id AND member.identity_id=owed.person_id AND member.removed_at IS NULL
      WHERE owed.corner_id=${corner}.id AND owed.blocking AND (owed.expires_at IS NULL OR owed.expires_at>now())
        AND NOT (item.card->>'reportToId' IS NOT NULL AND item.author_id=${worker})
      UNION ALL
      SELECT choice.message_id,NULL::text,choice.created_at,item.room_id,item.created_at,
        'question','message',false,ARRAY[item.id]
      FROM room_choices choice JOIN messages item ON item.id=choice.message_id
      WHERE choice.room_id=${corner}.id AND choice.mode='question' AND choice.status='open' AND item.deleted_at IS NULL
      UNION ALL
      SELECT 'grant:'||pending_grant.id::text,NULL::text,pending_grant.created_at,${corner}.id,pending_grant.created_at,'approve',NULL::text,true,
        ARRAY[]::text[]
      FROM agent_grants pending_grant WHERE pending_grant.room_id=${corner}.id AND pending_grant.status='pending'
        AND pending_grant.superseded_at IS NULL AND (pending_grant.expires_at IS NULL OR pending_grant.expires_at>now())
    ) waiting
    WHERE waiting_fact.corner_id=${corner}.id `;
}

export async function loadCornerWaiting(db: SqlDatabase, cornerId: string) {
  return (
    await db.query<{
      persistent_block: boolean;
      item_id: string;
      reason: 'question' | 'approve' | 'connect';
      kind: 'message' | 'report' | null;
    }>(
      `SELECT waiting.*,EXISTS(SELECT 1 FROM messages block WHERE block.id=waiting.item_id AND block.block_corner_id IS NOT NULL AND block.ask_closed_reason IS NULL) persistent_block FROM rooms waiting_corner CROSS JOIN LATERAL (${cornerWaitingSql('waiting_corner')}) waiting
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

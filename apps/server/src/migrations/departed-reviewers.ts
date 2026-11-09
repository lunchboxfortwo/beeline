import type { SqlDatabase } from '../database.js';
import { clearCornerReviewersForMembershipsSql } from '../corner-lifecycle.js';

/** Repair old assignments without picking a replacement or changing merge policy. */
export async function clearDepartedReviewers(database: SqlDatabase): Promise<void> {
  await database.transaction(async db => {
    await db.query(`UPDATE rooms room SET reviewer_agent_id=NULL
      WHERE room.reviewer_agent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM memberships member JOIN identities identity
          ON identity.id=member.identity_id AND identity.kind='agent'
        WHERE member.room_id=COALESCE(room.parent_id,room.id)
          AND member.identity_id=room.reviewer_agent_id AND member.removed_at IS NULL
      )`);
    await db.query(`WITH departed AS (
      SELECT corner.parent_id room_id,fact.reviewer_agent_id identity_id
      FROM corner_facts fact JOIN rooms corner ON corner.id=fact.corner_id
      WHERE fact.reviewer_agent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM memberships member JOIN identities identity
          ON identity.id=member.identity_id AND identity.kind='agent'
        WHERE member.room_id=corner.parent_id
          AND member.identity_id=fact.reviewer_agent_id AND member.removed_at IS NULL
      )
    ) ${clearCornerReviewersForMembershipsSql('departed')}`);
  });
}

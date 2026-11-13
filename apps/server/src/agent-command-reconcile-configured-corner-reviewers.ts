import { subscribeConfiguredReviewers } from './agent-subscriptions.js';
import type { SqlDatabase } from './database.js';
import { advanceCorner } from './corner-lifecycle.js';
import { readLiveCornerChecks } from './corner-live-checks.js';



export async function reconcileConfiguredCornerReviewers(db: SqlDatabase, parentRoomId?: string): Promise<{ subscriptions: number; commands: number }> {
  const subscriptions = await subscribeConfiguredReviewers(db, [parentRoomId ?? null]);
  const corners = (await db.query<{ id: string; green: boolean }>(`SELECT room.id,
      COALESCE(cache.lifecycle->>'checks'='passing' AND cache.lifecycle->'pr'->>'number' IS NOT NULL,false) green
    FROM rooms room LEFT JOIN corner_github_cache cache ON cache.corner_id=room.id
    WHERE room.parent_id IS NOT NULL AND room.archived_at IS NULL
      AND ($1::uuid IS NULL OR room.parent_id=$1)`, [parentRoomId ?? null])).rows;
  let commands = 0;
  for (const corner of corners) {
    // A stored green may be stale: read GitHub before it can wake a reviewer.
    if (corner.green && !(await readLiveCornerChecks(corner.id))) continue;
    if ((await advanceCorner(db, corner.id, { kind: 'reconcile' })).wake?.queued) commands++;
  }
  return { subscriptions: subscriptions.rowCount, commands };
}

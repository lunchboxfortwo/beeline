import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { closeCornerPullRequestBestEffort, closeCornerState } from './corner-close.js';
import {
  lockCornerArchivalAuthority,
  lockCornerLifecycle,
} from './corner-lifecycle-review-state.js';
import { deleteCornerBranchBestEffort } from './corner-branch-cleanup.js';
import type { SqlDatabase } from './database.js';
import { ensureSystemIdentity, systemLine } from './system-line.js';

/** Creation is the fallback for a thread that has never received a person message.
 * Hidden human identities are system/bot authors, not people. */
const deadlines = `SELECT corner.id,corner.parent_id,corner.name,
  GREATEST(corner.created_at,(SELECT message.created_at FROM messages message
    JOIN identities author ON author.id=message.author_id
    WHERE message.room_id=corner.id AND message.presentation='message'
      AND message.system_event IS NULL AND author.kind='human' AND NOT author.hidden_from_roster
    ORDER BY message.created_at DESC LIMIT 1
  )) + interval '7 days' deadline
  FROM rooms corner JOIN corner_facts fact ON fact.corner_id=corner.id
  WHERE corner.parent_id IS NOT NULL AND corner.archived_at IS NULL AND NOT fact.locked`;

/** Shares the existing server deadline clock. An overdue, contended close waits
 * at least a second before re-admission instead of spinning the shared clock. */
export async function nextCornerCloseDelay(database: SqlDatabase): Promise<number | undefined> {
  const row = (
    await database.query<{ delay_ms: number | null }>(
      `SELECT greatest(1000,ceil(extract(epoch FROM (min(deadline)-clock_timestamp()))*1000))::float8 delay_ms
     FROM (${deadlines}) candidates HAVING min(deadline) IS NOT NULL`,
    )
  ).rows[0];
  return row?.delay_ms ?? undefined;
}

/** Archive and notice are one transaction; the existing lifecycle lock fences replicas. */
export async function closeInactiveCorners(
  database: SqlDatabase,
  cleanup?: {
    closePullRequest(cornerId: string): Promise<{ status: string; blocker?: string }>;
    deleteCornerBranch(cornerId: string): Promise<unknown>;
  },
): Promise<number> {
  const candidates = (
    await database.query<{ id: string }>(
      `SELECT id FROM (${deadlines}) candidates WHERE deadline<=now() ORDER BY deadline,id LIMIT 100`,
    )
  ).rows;
  let closed = 0;
  for (const candidate of candidates) {
    const archived = await database
      .transaction(async (db) => {
        await lockCornerLifecycle(db, candidate.id);
        await lockCornerArchivalAuthority(db);
        // Match archival's command-before-Room lock order. Never wait on a
        // message writer while holding its lifecycle row: it may need that row.
        await db.query(
          `SELECT id FROM agent_commands WHERE room_id=$1 AND state='pending' FOR UPDATE NOWAIT`,
          [candidate.id],
        );
        await db.query('SELECT id FROM rooms WHERE id=$1 FOR UPDATE NOWAIT', [candidate.id]);
        // Room admission holds FOR SHARE through message commit. Recheck after
        // acquiring its conflicting lock, so a human message cannot be missed.
        const corner = (
          await db.query<{ id: string; parent_id: string; name: string }>(
            `SELECT id,parent_id,name FROM (${deadlines}) candidates WHERE id=$1 AND deadline<=now()`,
            [candidate.id],
          )
        ).rows[0];
        if (!corner) return false;
        const result = await closeCornerState(db, corner.id);
        if (!result.archived) return false;
        await ensureSystemIdentity(db);
        await systemLine(db, {
          id: `thread-idle-close:${corner.id}`,
          roomId: corner.parent_id,
          authorId: SYSTEM_IDENTITY_ID,
          subject: { kind: 'system', name: corner.name },
          verb: systemMessage('corner-auto-close.closed'),
          // An unkinded line has no subscribers. A passive type also stays quiet
          // in DMs, where an untyped System line otherwise qualifies for push.
          cardType: 'thread-idle-close',
          routeCommands: false,
        });
        return true;
      })
      .catch((error) => {
        if ((error as { code?: string }).code === '55P03') return false;
        throw error;
      });
    if (archived) {
      closed++;
      await closeCornerPullRequestBestEffort(database, candidate.id, cleanup?.closePullRequest);
      await deleteCornerBranchBestEffort(candidate.id, cleanup?.deleteCornerBranch);
    }
  }
  return closed;
}

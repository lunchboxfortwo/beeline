import type { SqlDatabase } from './database.js';
import { openRun } from './workflow-runs.js';
import { closeRun } from './workflow-runs-cancel-run-timers.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';

// Pinned metadata also covers runs created before timeout enforcement existed.
const deadlines = `SELECT start.room_id,start.id run_id,
  head.created_at + make_interval(secs =>
    (version.markdown::jsonb->'handoffs'->(head.card->>'toState')->>'timeoutSeconds')::int) due_at
  FROM messages start JOIN rooms room ON room.id=start.room_id AND room.archived_at IS NULL
  JOIN workspace_skills skill ON skill.workspace_id=room.workspace_id
    AND skill.slug=start.card->>'workflowSlug' AND skill.kind='workflow'
  JOIN workspace_skill_versions version ON version.skill_id=skill.id
    AND version.version=(start.card->>'workflowVersion')::int
  JOIN LATERAL (SELECT message.created_at,message.card FROM messages message
    WHERE message.room_id=start.room_id AND message.card_type='workflow-handoff'
      AND message.card->>'runId'=start.id
    ORDER BY (message.card->>'seq')::int DESC LIMIT 1) head ON true
  WHERE start.card_type='workflow-handoff' AND start.card->>'runStatus'='live'
    AND start.id=start.card->>'runId'`;

export async function nextWorkflowExpiryDelay(db: SqlDatabase): Promise<number | undefined> {
  const row = (await db.query<{ delay: number | null }>(`SELECT
    greatest(0,ceil(extract(epoch FROM (min(due_at)-clock_timestamp()))*1000))::float8 delay
    FROM (${deadlines}) deadlines WHERE due_at IS NOT NULL HAVING count(*)>0`)).rows[0];
  return row?.delay ?? undefined;
}

/** Expiry ends the visit; it never supplies a person's gate answer. */
export async function expireWorkflowRuns(db: SqlDatabase, now: Date): Promise<string[]> {
  const due = (await db.query<{ room_id: string; run_id: string }>(
    `SELECT room_id,run_id FROM (${deadlines}) deadlines WHERE due_at<=$1`, [now],
  )).rows;
  const changed: string[] = [];
  for (const candidate of due) await db.transaction(async tx => {
    const scope = await openRun(tx, candidate.room_id, candidate.run_id);
    const seconds = scope.state && 'timeoutSeconds' in scope.state ? scope.state.timeoutSeconds : undefined;
    if (scope.ended || !seconds || new Date(scope.head.createdAt).getTime()+seconds*1000>now.getTime()) return;
    if (await closeRun(tx, scope, {
      status: 'failed', outcome: 'expired', reason: 'Step exceeded timeoutSeconds',
      line: { authorId: SYSTEM_IDENTITY_ID,
        subject: { kind: 'system', name: systemMessage('workflow-runs.the-workflow') },
        verb: systemMessage('workflow-runs.applied'), object: systemMessage('workflow-runs.timeout'),
        consequence: scope.stateName },
    })) changed.push(candidate.room_id);
  });
  return [...new Set(changed)];
}

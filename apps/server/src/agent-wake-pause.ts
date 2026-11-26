import type { WakeProvenanceLink, WakeReplyLink } from '@beeline/api-contract/daemon';
import type { RoomScheduleCadence } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { nextScheduleOccurrence } from './agent-schedules.js';
import { scheduleDisplayTitle } from './schedule-title.js';
import {
  formatScheduleReceipt,
  projectScheduleProvenance,
  scheduleProvenanceJoinsSql,
  scheduleProvenanceSelectSql,
  type ScheduleProvenanceColumns,
} from './wake-receipts.js';

export type SetAgentWakePausedResult = {
  paused: boolean;
  nextRunAt?: number;
  repliesTo?: WakeReplyLink;
  approvedBy?: WakeProvenanceLink;
  receipt: string;
};

/** Agents manage only their own wake sources, under current Room access. */
export async function setAgentWakePaused(db: SqlDatabase, agentId: string, input: {
  roomId: string; scheduleId?: string; subscriptionId?: string; paused: boolean;
}): Promise<SetAgentWakePausedResult> {
  if (typeof input.paused !== 'boolean' || Boolean(input.scheduleId) === Boolean(input.subscriptionId))
    throw new Error('give one scheduleId or subscriptionId and paused');
  return db.transaction(async tx => {
    if (input.scheduleId) {
      const row = (await tx.query<
        ScheduleProvenanceColumns & {
          id: string;
          title: string | null;
          workflow_slug: string | null;
          message: string;
          paused_at: Date | null;
          cadence: RoomScheduleCadence;
          next_run_at: Date;
          now_at: Date;
        }
      >(
        `SELECT wake.id,wake.title,wake.workflow_slug,wake.message,wake.paused_at,wake.cadence,wake.next_run_at,
           clock_timestamp() now_at,
           ${scheduleProvenanceSelectSql('wake')}
         FROM agent_schedules wake
         JOIN room_access member ON member.room_id=wake.room_id AND member.identity_id=$2 AND member.removed_at IS NULL
         JOIN rooms room ON room.id=wake.room_id AND room.archived_at IS NULL
         ${scheduleProvenanceJoinsSql('wake', 'room')}
         WHERE wake.id=$1 AND wake.agent_id=$2
           FOR UPDATE OF wake`,
        [input.scheduleId, agentId],
      )).rows[0];
      if (!row) throw new Error('wake source not found');
      const title = scheduleDisplayTitle({ title: row.title, workflow: row.workflow_slug, prompt: row.message });
      const provenance = projectScheduleProvenance(row);
      const unchanged = Boolean(row.paused_at) === input.paused;
      // Preserve interval phase, skip missed occurrences, and leave no catch-up work.
      const next = unchanged || input.paused
        ? row.next_run_at
        : nextScheduleOccurrence(row.cadence, row.now_at, row.next_run_at);
      if (!unchanged) {
        await tx.query(`UPDATE agent_schedules SET paused_at=$2,next_run_at=$3,updated_at=now() WHERE id=$1`,
          [row.id, input.paused ? row.now_at : null, next]);
      }
      const nextRunAt = Math.floor(next.getTime() / 1_000);
      const receipt = formatScheduleReceipt({
        verb: input.paused ? 'Paused' : 'Resumed',
        title,
        nextRunAt: input.paused ? undefined : next,
        cadence: row.cadence,
        repliesTo: provenance.repliesTo,
        approvedBy: provenance.approvedBy,
        note: unchanged ? (input.paused ? 'already paused' : 'already active') : undefined,
      });
      return {
        paused: input.paused,
        nextRunAt,
        ...provenance,
        receipt,
      };
    }

    const row = (await tx.query<{
      id: string;
      title: string | null;
      source: string;
      event: string;
      paused_at: Date | null;
      now_at: Date;
    }>(
      `SELECT wake.id,wake.title,wake.source,wake.event,wake.paused_at,clock_timestamp() now_at
       FROM agent_subscriptions wake
       JOIN room_access member ON member.room_id=wake.room_id AND member.identity_id=$2 AND member.removed_at IS NULL
       JOIN rooms room ON room.id=wake.room_id AND room.archived_at IS NULL
       WHERE wake.id=$1 AND wake.agent_id=$2
         FOR UPDATE OF wake`,
      [input.subscriptionId, agentId],
    )).rows[0];
    if (!row) throw new Error('wake source not found');
    const unchanged = Boolean(row.paused_at) === input.paused;
    if (!unchanged) {
      await tx.query('UPDATE agent_subscriptions SET paused_at=$2 WHERE id=$1',
        [row.id, input.paused ? row.now_at : null]);
    }
    const label = row.title?.trim() ? `"${row.title.trim()}"` : `${row.source} ${row.event}`;
    const verb = input.paused ? 'Paused' : 'Resumed';
    const suffix = unchanged ? (input.paused ? ' · already paused' : ' · already active') : '';
    return {
      paused: input.paused,
      receipt: `${verb} subscription ${label} (${row.source} ${row.event})${suffix}`,
    };
  });
}

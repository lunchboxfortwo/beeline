import type { WakeProvenanceLink, WakeReplyLink } from '@beeline/api-contract/daemon';
import type { RoomScheduleCadence } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { roomAudienceCanReadSourceSql } from './institutional-history.js';
import { scheduleDisplayTitle } from './schedule-title.js';

export type ScheduleProvenanceColumns = {
  approved_by_id: string | null;
  approved_by_handle: string | null;
  approved_by_name: string | null;
  approved_source_message_id: string | null;
  replies_to_id: string | null;
  replies_to_handle: string | null;
  replies_to_name: string | null;
};

/**
 * Resolve schedule approval and reply provenance within the schedule's existing
 * workspace/room audience partition. Deleted or cross-partition messages never leak.
 */
export function scheduleProvenanceJoinsSql(scheduleAlias = 'schedule', roomAlias = 'room'): string {
  return `
    LEFT JOIN identities creator_identity ON creator_identity.id=${scheduleAlias}.creator_id
    LEFT JOIN agents worker_agent ON worker_agent.agent_id=${scheduleAlias}.agent_id
    LEFT JOIN messages approved_msg
      ON approved_msg.id=${scheduleAlias}.human_command_message_id
     AND approved_msg.deleted_at IS NULL
    LEFT JOIN rooms approved_room
      ON approved_room.id=approved_msg.room_id
     AND approved_room.workspace_id=${roomAlias}.workspace_id
     AND (approved_room.id=${roomAlias}.id
       OR ${roomAudienceCanReadSourceSql(`COALESCE(${roomAlias}.parent_id,${roomAlias}.id)`, 'COALESCE(approved_room.parent_id,approved_room.id)')})
    LEFT JOIN identities approved_person
      ON approved_room.id IS NOT NULL
     AND approved_person.id=approved_msg.author_id
     AND approved_person.kind='human'
     AND NOT COALESCE(approved_person.hidden_from_roster,false)
    LEFT JOIN identities reply_person
      ON reply_person.id=COALESCE(
        NULLIF(${scheduleAlias}.owner_id,${scheduleAlias}.agent_id),
        approved_person.id,
        CASE WHEN creator_identity.kind='human' AND NOT COALESCE(creator_identity.hidden_from_roster,false)
          THEN ${scheduleAlias}.creator_id END,
        worker_agent.owner_id
      )
     AND reply_person.kind='human'
     AND NOT COALESCE(reply_person.hidden_from_roster,false)`;
}

export function scheduleProvenanceSelectSql(scheduleAlias = 'schedule'): string {
  return `
    approved_person.id approved_by_id,
    CASE WHEN approved_person.id IS NOT NULL THEN beeline_room_handle(approved_person.id,${scheduleAlias}.room_id) END approved_by_handle,
    NULLIF(approved_person.name,'') approved_by_name,
    CASE WHEN approved_person.id IS NOT NULL THEN approved_msg.id END approved_source_message_id,
    reply_person.id replies_to_id,
    CASE WHEN reply_person.id IS NOT NULL THEN beeline_room_handle(reply_person.id,${scheduleAlias}.room_id) END replies_to_handle,
    NULLIF(reply_person.name,'') replies_to_name`;
}

export function projectScheduleProvenance(row: ScheduleProvenanceColumns): {
  approvedBy?: WakeProvenanceLink;
  repliesTo?: WakeReplyLink;
} {
  const approvedBy: WakeProvenanceLink | undefined = row.approved_by_id
    ? {
        identityId: row.approved_by_id,
        ...(row.approved_by_handle ? { handle: row.approved_by_handle } : {}),
        ...(row.approved_by_name ? { name: row.approved_by_name } : {}),
        ...(row.approved_source_message_id ? { sourceMessageId: row.approved_source_message_id } : {}),
      }
    : undefined;
  const repliesTo: WakeReplyLink | undefined = row.replies_to_id
    ? {
        identityId: row.replies_to_id,
        ...(row.replies_to_handle ? { handle: row.replies_to_handle } : {}),
        ...(row.replies_to_name ? { name: row.replies_to_name } : {}),
        ...(row.approved_source_message_id && row.approved_by_id === row.replies_to_id
          ? { messageId: row.approved_source_message_id }
          : {}),
      }
    : undefined;
  return {
    ...(approvedBy ? { approvedBy } : {}),
    ...(repliesTo ? { repliesTo } : {}),
  };
}

export function formatPersonLabel(person: { identityId: string; handle?: string; name?: string }): string {
  if (person.handle) return `@${person.handle.replace(/^@/, '')}`;
  if (person.name) return person.name;
  return person.identityId.slice(0, 8);
}

export function formatScheduleNextRun(nextRunAt: Date, cadence?: RoomScheduleCadence): string {
  const timeZone = cadence?.kind === 'cron' && cadence.timeZone ? cadence.timeZone : 'UTC';
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
      timeZoneName: 'short',
    }).format(nextRunAt);
  } catch {
    return nextRunAt.toISOString();
  }
}

export function formatScheduleReceipt(params: {
  verb: 'Created' | 'Updated' | 'Paused' | 'Resumed' | 'Deleted';
  title: string;
  nextRunAt?: Date;
  cadence?: RoomScheduleCadence;
  repliesTo?: WakeReplyLink;
  approvedBy?: WakeProvenanceLink;
  note?: string;
}): string {
  const parts = [`${params.verb} "${params.title}"`];
  if (params.note) parts.push(params.note);
  if (params.nextRunAt && params.verb !== 'Deleted' && params.verb !== 'Paused') {
    parts.push(`next run ${formatScheduleNextRun(params.nextRunAt, params.cadence)}`);
  }
  if (params.repliesTo) {
    parts.push(`replies to ${formatPersonLabel(params.repliesTo)}`);
  }
  if (
    params.approvedBy &&
    (!params.repliesTo || params.approvedBy.identityId !== params.repliesTo.identityId)
  ) {
    parts.push(`approved by ${formatPersonLabel(params.approvedBy)}`);
  }
  return parts.join(' · ');
}

export async function readScheduleProvenance(
  db: SqlDatabase,
  scheduleId: string,
): Promise<{
  title: string;
  cadence: RoomScheduleCadence;
  nextRunAt: Date;
  approvedBy?: WakeProvenanceLink;
  repliesTo?: WakeReplyLink;
} | undefined> {
  const row = (
    await db.query<
      ScheduleProvenanceColumns & {
        title: string | null;
        workflow_slug: string | null;
        message: string;
        cadence: RoomScheduleCadence;
        next_run_at: Date;
      }
    >(
      `SELECT schedule.title,schedule.workflow_slug,schedule.message,schedule.cadence,schedule.next_run_at,
         ${scheduleProvenanceSelectSql('schedule')}
       FROM agent_schedules schedule
       JOIN rooms room ON room.id=schedule.room_id
       ${scheduleProvenanceJoinsSql('schedule', 'room')}
       WHERE schedule.id=$1`,
      [scheduleId],
    )
  ).rows[0];
  if (!row) return undefined;
  return {
    title: scheduleDisplayTitle({ title: row.title, workflow: row.workflow_slug, prompt: row.message }),
    cadence: row.cadence,
    nextRunAt: row.next_run_at,
    ...projectScheduleProvenance(row),
  };
}

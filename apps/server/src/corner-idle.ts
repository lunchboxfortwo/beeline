import { cornerIdleBudgetSql } from './corner-idle-budget.js';
import { PERSON_STOP_REASON } from './agent-turn-end.js';
import { cornerImplementerSql } from './corner-worker.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { cornerBlockerSql, cornerScheduledWaitSql, cornerWorkSql,
  type CornerStateRow } from './chat-corner-counts.js';

export type CornerIdleRow = CornerStateRow & {
  id: string;
  locked: boolean;
  worker_active: boolean;
  reviewer_active: boolean;
  peer_active: boolean;
  reviewer_agent_id: string | null;
  peer_agent_id: string | null;
  blocking: boolean;
  last_turn_ended_at: Date | null;
  name: string;
  parent_id: string;
  /** Epoch seconds kept as text to preserve PostgreSQL's microsecond precision. */
  idle_since: string;
  person_since: string;
  idle_report_count: number;
  idle_report_pending: boolean;
  suppressed: boolean;
};

/**
 * One source for attention, delivery and claim. No mutable episode state.
 * Deleted schedules have no surviving end timestamp; expired schedules alone,
 * without another event, do not open a new idle episode.
 */
export function cornerIdleSql(cornerId: string): string {
  return `WITH live_corner AS MATERIALIZED (
    SELECT rooms.* FROM rooms WHERE id=${cornerId} AND parent_id IS NOT NULL AND archived_at IS NULL
  ) SELECT snapshot.*,
    (machine->>'state'='idle' AND archived_at IS NULL
      AND machine->>'reason' IS DISTINCT FROM 'backlog'
      AND NOT (worker_active OR reviewer_active OR peer_active OR blocking OR suppressed)) idle_eligible
    FROM (SELECT c.id,c.name,c.parent_id,c.archived_at,gh.lifecycle,f.locked,f.machine,
      activity.worker_active,activity.reviewer_active,activity.peer_active,activity.reviewer_agent_id,activity.peer_agent_id,NULL::text latest_turn_status,
      extract(epoch FROM person_epoch.at)::text person_since,
      idle_budget.report_count idle_report_count,idle_budget.pending idle_report_pending,
      blocker.item_id IS NOT NULL blocking,blocker.item_id waiting_item_id,
      blocker.reason waiting_reason,blocker.kind waiting_kind,blocker.person_id waiting_person_id,
      CASE WHEN ended.status='complete' AND ended.ended_at>=boundary.at THEN ended.ended_at END last_turn_ended_at,
      extract(epoch FROM GREATEST(c.created_at,ended.ended_at,boundary.at,person_epoch.at,
        to_timestamp(COALESCE(gh.lifecycle->'checksSummary'->>'statusChangedAt',
          gh.lifecycle->'checksSummary'->>'updatedAt')::double precision)))::text idle_since,
      (${cornerScheduledWaitSql('c')}
        OR EXISTS(SELECT 1 FROM corner_merge_holds WHERE corner_id=c.id AND released_at IS NULL)
        OR EXISTS(SELECT 1 FROM agent_commands queued WHERE queued.room_id=c.id AND queued.action='input'
          AND queued.state='pending'
          AND queued.review_context->>'headSha'=gh.lifecycle->'pr'->>'headSha'
          AND queued.review_context->>'purpose' IS NULL AND queued.agent_id IS DISTINCT FROM ${cornerImplementerSql('f', 'c')})
        OR gh.lifecycle->>'checks'='pending'
        OR ${personStopHoldSql('c')}
        OR (NULLIF(gh.lifecycle->'pr','null'::jsonb) IS NOT NULL AND gh.lifecycle->'checksSummary'->>'status'='unknown'
          AND gh.lifecycle->'checksSummary'->>'fetchStartedAt' IS NULL)
      ) IS TRUE suppressed
      FROM live_corner c JOIN corner_facts f ON f.corner_id=c.id
      LEFT JOIN corner_github_cache gh ON gh.corner_id=c.id
      ${cornerWorkSql()} ${cornerBlockerSql()}
      ${cornerIdleBudgetSql('c')}
      LEFT JOIN LATERAL (SELECT turn.ended_at,turn.status FROM agent_turns turn
        WHERE turn.room_id=c.id AND turn.agent_id=${cornerImplementerSql('f', 'c')}
        ORDER BY turn.ended_at DESC NULLS LAST,turn.created_at DESC LIMIT 1) ended ON true
      CROSS JOIN LATERAL (SELECT GREATEST(c.created_at,
        (SELECT max(latest.created_at) FROM identities author CROSS JOIN LATERAL (
          SELECT message.created_at FROM messages message
          WHERE message.room_id=c.id AND message.author_id=author.id
            AND message.presentation='message' AND message.system_event IS NULL
          ORDER BY message.created_at DESC LIMIT 1
        ) latest WHERE author.kind='human' AND author.id<>'${SYSTEM_IDENTITY_ID}'),
        (SELECT max(released_at) FROM corner_merge_holds WHERE corner_id=c.id),
        (SELECT max(expires_at) FROM corner_owed WHERE corner_id=c.id AND expires_at<=now()),
        person_epoch.at
      ) at OFFSET 0) boundary
      ) snapshot`;
}

/** A person's stop holds idle notices until a person acts in the thread again or any turn starts there. */
function personStopHoldSql(corner: string): string {
  return `EXISTS(SELECT 1 FROM agent_commands stopped WHERE stopped.room_id=${corner}.id
    AND stopped.cancellation_reason='${PERSON_STOP_REASON}' AND stopped.completed_at>=person_epoch.at
    AND NOT EXISTS(SELECT 1 FROM agent_turns later WHERE later.room_id=${corner}.id
      AND later.started_at>stopped.completed_at))`;
}

/** Same idle episode command pickup used to inline. Planned once per session, and only for an idle alert. */
function currentIdleReportPredicateSql(command: string): string {
  return `EXISTS(SELECT 1 FROM (${cornerIdleSql(`(
    SELECT origin.id FROM rooms origin WHERE origin.archived_at IS NULL AND origin.id=CASE
      WHEN COALESCE(${command}.private_payload->>'originCornerId',${command}.private_payload->>'fromRoomId')
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN COALESCE(${command}.private_payload->>'originCornerId',${command}.private_payload->>'fromRoomId')::uuid END)`)}) idle
    WHERE idle.idle_since=${command}.private_payload->>'idleSince'
      AND idle.idle_eligible)`;
}

/** Delivery and claim require the same idle start and absence of every idle disqualifier.
 * The predicate stays in a function so command pickup does not plan it on every read. */
export function currentIdleReportSql(command: string): string {
  return `beeline_current_idle_report(${command}.private_payload)`;
}

export function currentIdleReportFunctionSql(): string {
  return `CREATE OR REPLACE FUNCTION beeline_current_idle_report(payload jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE AS $idle_report$
BEGIN
  RETURN COALESCE((
    SELECT ${currentIdleReportPredicateSql('command')}
    FROM (SELECT payload AS private_payload) command
  ), false);
END
$idle_report$;`;
}

import { cornerImplementerSql } from './corner-worker.js';
import { tagsKnownIdentitySql } from './message-mentions.js';

/** The report's originating corner, including a human report in its return Room. */
export function humanReportCornerSql(message: string): string {
  return `COALESCE(${message}.card->>'sourceRoomId',(
    SELECT COALESCE(source.private_payload->>'originCornerId',source.room_id::text)
    FROM agent_commands source WHERE source.id=${message}.request_id AND source.agent_id=${message}.author_id
  ),${message}.room_id::text)`;
}

/** Keep forwarded reports on their origin index, with a separate legacy fallback. */
export function cornerHumanReportsSql(cornerId: string, workerId: string): string {
  const columns = 'message.id,message.room_id,message.author_id,message.text,message.card,message.presentation,message.system_event,message.deleted_at,message.request_id,message.created_at';
  return `SELECT ${columns} FROM messages message
    WHERE message.author_id=${workerId} AND message.card->>'reportToId' IS NOT NULL
      AND message.card->>'sourceRoomId'=(${cornerId})::text
    UNION ALL
    SELECT ${columns} FROM messages message
    WHERE message.room_id=${cornerId} AND message.author_id=${workerId}
      AND message.card->>'reportToId' IS NOT NULL AND message.card->>'sourceRoomId' IS NULL
      AND ${humanReportCornerSql('message')}=(${cornerId})::text
    UNION ALL
    SELECT ${columns} FROM messages message
    WHERE message.author_id=${workerId}
      AND EXISTS (SELECT 1 FROM agent_commands source
        WHERE source.id=message.request_id AND source.agent_id=message.author_id
          AND (CASE WHEN source.private_payload->>'originCornerId'
            ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN (source.private_payload->>'originCornerId')::uuid ELSE source.room_id END)=${cornerId}
        OFFSET 0)
      AND message.room_id<>${cornerId} AND message.card->>'reportToId' IS NOT NULL
      AND message.card->>'sourceRoomId' IS NULL
      AND ${humanReportCornerSql('message')}=(${cornerId})::text`;
}

/** The visible card that records a private report command. */
export function reportCardIdSql(id: string): string {
  return `encode(sha256(convert_to('agent-command-card:'||${id},'UTF8')),'hex')`;
}

/**
 * The one projection of a worker's explicit waits from a corner: report
 * identity, display target, card, answer targets and delivery boundary. Live,
 * detail and historical reads all consume it. An explicit private report has its
 * explicit report status; automatic final prose has no such marker and cannot
 * start a wait even when it says "blocked:". `message_id` is the display target;
 * `card_id` retains optional historical cross-Room report linkage. `asked_at` is the delivery
 * boundary: the visible card's time, else the report's own time. `latestOnly`
 * keeps one newest row per source so each probe stays on its index.
 */
function cornerReportItemsSql(cornerId: string, worker: string, latestOnly = false): string {
  const newest = (table: string) => latestOnly ? `ORDER BY ${table}.created_at DESC,${table}.id DESC LIMIT 1` : '';
  return `SELECT items.*,ARRAY[items.message_id,items.card_id] asked_items FROM (
      (SELECT command.id report_id,
        CASE WHEN command.room_id=${cornerId} THEN visible.id END message_id,
        visible.id card_id,command.room_id return_room_id,command.created_at,COALESCE(visible.created_at,command.created_at) asked_at,
        COALESCE(command.private_payload->>'reportStatus',substring(command.private_payload->>'text' FROM '^([^:]+):')) report_status,
        command.agent_id commander_id,command.private_payload->>'text' text,
        command.private_payload->>'waitingAnswered' answered,command.id sort_id
      FROM agent_commands command
      LEFT JOIN messages visible ON visible.id=${reportCardIdSql('command.id')}
        AND visible.card_type='agent-command' AND visible.card->>'kind'='report'
      WHERE command.private_payload->>'kind'='report'
        AND (command.private_payload->>'reportStatus' IN ('blocked','needs-decision','done','failed') OR visible.id IS NOT NULL)
        AND command.private_payload->>'fromRoomId'=${cornerId}::text
        AND command.private_payload->>'authorId'=${worker}
      ${newest('command')})
      UNION ALL
      (SELECT NULL::text,message.id,${reportCardIdSql('message.id')},message.room_id,message.created_at,message.created_at,
        COALESCE(message.card->>'reportStatus',substring(message.text FROM '^([^:]+):')),
        message.card->>'reportToId',message.text,message.card->>'waitingAnswered',message.id
      FROM (${cornerHumanReportsSql(cornerId, worker)}) message
      WHERE message.card->>'reportToId' IS NOT NULL
        AND (message.card->>'reportStatus' IN ('blocked','needs-decision','done','failed') OR message.text ~ '^(needs-decision|blocked):')
        AND message.presentation='message' AND message.system_event IS NULL AND message.deleted_at IS NULL
        AND message.author_id=${worker}
        AND ${humanReportCornerSql('message')}=${cornerId}::text
      ${newest('message')})
    ) items`;
}

/**
 * The newest explicit worker block, unless later implementer output lifted it.
 * The report log owns its status and return address; conversation never clears it.
 * One row per recipient: the recorded commander and tagged human corner members.
 */
export function cornerWaitingReportSql(corner: string): string {
  const worker = cornerImplementerSql('waiting_fact', corner);
  return `SELECT ${corner}.id corner_id,latest.report_id,latest.message_id,latest.card_id,
    latest.return_room_id,latest.created_at,latest.asked_at,latest.asked_items,
    latest.commander_id,person.id person_id
  FROM corner_facts waiting_fact
  CROSS JOIN LATERAL (
    SELECT reports.* FROM (${cornerReportItemsSql(`${corner}.id`, worker, true)}) reports
    ORDER BY reports.created_at DESC,reports.sort_id DESC LIMIT 1
  ) latest
  CROSS JOIN LATERAL (SELECT latest.text,'message'::text presentation,${corner}.id room_id,
    ${worker} author_id) item
  JOIN identities person ON person.id=latest.commander_id OR (person.kind='human' AND EXISTS (
    SELECT 1 FROM room_access member WHERE member.room_id=${corner}.id
      AND member.identity_id=person.id AND member.removed_at IS NULL
  ) AND ${tagsKnownIdentitySql('item', 'person.id', 'person.handle', 'person.kind')})
    WHERE waiting_fact.corner_id=${corner}.id AND latest.report_status IN ('blocked','needs-decision')
    AND NOT EXISTS(SELECT 1 FROM (${workerOutputSql(`${corner}.id`, worker)}) output
      WHERE output.ended_at>latest.created_at)`;
}

/** Recorded implementer output lifts its block; receiving input or writing prose does not. */
function workerOutputSql(corner: string, worker: string): string {
  return `SELECT message.created_at ended_at FROM messages message
    WHERE message.room_id=${corner} AND message.author_id=${worker} AND message.deleted_at IS NULL AND (
      (message.presentation='activity' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(message.activity)='array'
          THEN message.activity ELSE '[]'::jsonb END) step
        JOIN agent_grants grant_run ON grant_run.id::text=substring(step->>'title' FROM 'under grant ([0-9a-f-]{36})')
          AND grant_run.workspace_id=(SELECT workspace_id FROM rooms WHERE id=${corner})
          AND grant_run.agent_id=${worker} AND grant_run.kind='command'
        WHERE step->>'operation'='execute'))
      OR (message.presentation='card' AND (message.card_type IN ('grant-request','permission','vault-save',
        'connector-offer','agent-sign-in','app-sign-in','squire-approval')
        OR (message.card_type='choice' AND message.card->>'mode'='question'))))`;
}

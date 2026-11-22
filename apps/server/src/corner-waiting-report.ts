import { messageAsksSql } from './message-asks.js';

/** The report's originating corner, including a human report in its return Room. */
export function humanReportCornerSql(message: string): string {
  return `COALESCE(${message}.card->>'sourceRoomId',(
    SELECT COALESCE(source.private_payload->>'originCornerId',source.room_id::text)
    FROM agent_commands source WHERE source.id=${message}.request_id AND source.agent_id=${message}.author_id
  ),${message}.room_id::text)`;
}

/** Only explicit closure releases the thread; answering releases Tasks separately. */
export function cornerWaitingReportSql(corner: string): string {
  return `SELECT ${corner}.id corner_id,NULL::text report_id,m.id message_id,m.id card_id,
    m.room_id return_room_id,m.created_at,COALESCE(m.block_reasked_at,m.created_at) asked_at,
    ARRAY[m.id] asked_items,m.card->>'reportToId' commander_id,m.card->>'reportToId' person_id
    FROM messages m WHERE m.block_corner_id=${corner}.id AND m.ask_closed_reason IS NULL
      AND m.deleted_at IS NULL
    UNION ALL ${messageAsksSql(corner)}`;
}


/** The report's originating corner, including a human report in its return Room. */
export function humanReportCornerSql(message: string): string {
  return `COALESCE(${message}.card->>'sourceRoomId',(
    SELECT COALESCE(source.private_payload->>'originCornerId',source.room_id::text)
    FROM agent_commands source WHERE source.id=${message}.request_id AND source.agent_id=${message}.author_id
  ),${message}.room_id::text)`;
}

/** Keep forwarded reports on their origin index, with a separate legacy fallback. */
export function cornerHumanReportsSql(cornerId: string, workerId: string): string {
  const columns =
    'message.id,message.room_id,message.author_id,message.text,message.card,message.presentation,message.system_event,message.deleted_at,message.request_id,message.created_at';
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

/** Only explicit closure releases the thread; answering releases Tasks separately. */
export function cornerWaitingReportSql(corner: string): string {
  return `SELECT ${corner}.id corner_id,NULL::text report_id,m.id message_id,m.id card_id,
    m.room_id return_room_id,m.created_at,COALESCE(m.block_reasked_at,m.created_at) asked_at,
    ARRAY[m.id] asked_items,m.card->>'reportToId' commander_id,m.card->>'reportToId' person_id
    FROM messages m WHERE m.block_corner_id=${corner}.id AND m.ask_closed_reason IS NULL
      AND m.deleted_at IS NULL`;
}

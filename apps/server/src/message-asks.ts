
/** Each message owns its own question; unrelated output never answers it. */
export function messageAsksSql(corner:string):string {
  return `SELECT ${corner}.id corner_id,question.report_id,question.message_id,NULL::text card_id,
    question.return_room_id,question.created_at,question.created_at asked_at,
    ARRAY[COALESCE(question.report_id,question.message_id)] asked_items,
    question.recipient commander_id,question.recipient person_id
  FROM corner_facts asking_fact CROSS JOIN LATERAL (
    SELECT item.id report_id,NULL::text message_id,item.room_id return_room_id,item.created_at,
      item.agent_id recipient
    FROM agent_commands item
    WHERE item.private_payload->'messageAsk' IS NOT NULL
      AND item.private_payload->'route'->'from'->>'place'=${corner}.id::text
      AND NOT EXISTS(SELECT 1 FROM agent_commands answer
        WHERE answer.private_payload->>'inReplyTo'=item.id
          AND answer.private_payload->'route'->'from'->>'agent'=item.agent_id)
    UNION ALL
    SELECT NULL::text,message.id,message.room_id,message.created_at,
      message.card->'route'->'to'->>'agent'
    FROM messages message JOIN work_questions question ON question.message_id=message.id
    JOIN room_choices choice ON choice.message_id=message.id
    WHERE message.card->'route'->'from'->>'place'=${corner}.id::text
      AND choice.status='open' AND message.deleted_at IS NULL
  ) question WHERE asking_fact.corner_id=${corner}.id`;
}

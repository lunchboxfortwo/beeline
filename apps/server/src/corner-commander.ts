/** The current commander for authority checks that previously used the creator. */
export function cornerCommanderIdSql(corner: string): string {
  return `COALESCE((${threadCommanderAddressSql(`${corner}.id`)})->>'agent',
    ${corner}.created_by)`;
}

/** The opening, else the first task delivered to the thread's implementer, records
 * its commander; tags of other agents, later messages and brief edits cannot move it. */
export function threadTaskSql(cornerId:string):string {
  return `SELECT task.* FROM agent_commands task LEFT JOIN corner_facts fact ON fact.corner_id=task.room_id
    WHERE task.room_id=${cornerId} AND (task.reason='corner_objective'
      OR task.reason IN ('human_tag','message') AND task.agent_id=fact.implementer_agent_id)
    ORDER BY (task.reason='corner_objective') DESC,task.inbox_sequence LIMIT 1`;
}
export function threadCommanderAddressSql(cornerId:string):string {
  return `(SELECT COALESCE(task.message->'route'->'from',task.private_payload->'route'->'from',
    jsonb_build_object('agent',COALESCE(task.private_payload->>'authorId',task.message->>'authorId'),
      'place',COALESCE(task.private_payload->>'fromRoomId',task.room_id::text)))
    FROM (${threadTaskSql(cornerId)}) task)`;
}

/** Only recorded human approvals transfer command. Agent approvals and the
 * opening brief preserve the original opening route. Historical revisions use
 * their recorded source Room; new revisions retain the dispatching turn too.
 */
export function cornerCommanderBriefSql(cornerId: string, at?: string): string {
  return `SELECT revision.revision,revision.author_id,revision.source_room_id,revision.approval_basis,revision.created_at FROM corner_brief_revisions revision
    JOIN identities approver ON approver.id=revision.approval_basis->>'approvedBy' AND approver.kind='human'
    WHERE revision.corner_id=${cornerId} AND revision.revision>1
      AND revision.approval_basis->>'kind' IN ('initiating-command','explicit-human-answer')
      ${at ? `AND revision.created_at<=${at}` : ''}
    ORDER BY revision.revision DESC LIMIT 1`;
}

/** The current commander for authority checks that previously used the creator. */
export function cornerCommanderIdSql(corner: string): string {
  return `COALESCE((${threadCommanderAddressSql(`${corner}.id`)})->>'agent',
    (SELECT author_id FROM (${cornerCommanderBriefSql(`${corner}.id`)}) commander),${corner}.created_by)`;
}

/** The opening, else the first task delivered to the thread's implementer, records
 * its commander; tags of other agents, later messages and brief edits cannot move it. */
export function threadTaskSql(cornerId:string):string {
  return `SELECT task.* FROM agent_commands task LEFT JOIN corner_facts fact ON fact.corner_id=task.room_id
    WHERE task.room_id=${cornerId} AND (task.reason='corner_objective'
      OR task.reason IN ('human_tag','message') AND task.agent_id=fact.implementer_agent_id)
    ORDER BY task.inbox_sequence LIMIT 1`;
}
export function threadCommanderAddressSql(cornerId:string):string {
  return `(SELECT COALESCE(task.message->'replyAddress',task.message->'route'->'from',task.private_payload->'route'->'from',
    jsonb_build_object('agent',COALESCE(task.private_payload->>'authorId',task.message->>'authorId'),
      'place',COALESCE(task.private_payload->>'fromRoomId',task.room_id::text)))
    FROM (${threadTaskSql(cornerId)}) task)`;
}

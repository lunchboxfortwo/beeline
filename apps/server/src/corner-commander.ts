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
  return `COALESCE((SELECT author_id FROM (${cornerCommanderBriefSql(`${corner}.id`)}) commander),${corner}.created_by)`;
}

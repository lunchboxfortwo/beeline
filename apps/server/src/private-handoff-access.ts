/**
 * One access rule for private hand-off rows (`agent_commands.private_payload IS NOT NULL`),
 * shared by single-message reads, conversation listings, and institutional history search.
 * Only the sender or recipient may read the payload, with current membership in their
 * side's Room (never through a borrowed review source).
 */
export function privateHandoffReadableSql(
  commandAlias: string,
  agentExpr: string,
  borrowedSourceExpr = 'false',
): string {
  return `(NOT (${borrowedSourceExpr})
    AND (${commandAlias}.agent_id=${agentExpr} OR ${commandAlias}.private_payload->>'authorId'=${agentExpr})
    AND EXISTS(SELECT 1 FROM rooms handoff_room
      JOIN memberships member ON member.room_id=COALESCE(handoff_room.parent_id,handoff_room.id)
      WHERE handoff_room.id=CASE WHEN ${commandAlias}.agent_id=${agentExpr} THEN ${commandAlias}.room_id
        WHEN ${commandAlias}.private_payload->>'fromRoomId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (${commandAlias}.private_payload->>'fromRoomId')::uuid END
        AND member.identity_id=${agentExpr}
        AND member.removed_at IS NULL))`;
}

/** True when `messageAlias` is a private hand-off that `agentExpr` cannot read. */
export function unreadablePrivateHandoffSql(
  messageAlias: string,
  agentExpr: string,
  borrowedSourceExpr = 'false',
): string {
  return `EXISTS(SELECT 1 FROM agent_commands handoff
    WHERE handoff.id=${messageAlias}.id
      AND handoff.private_payload IS NOT NULL
      AND NOT ${privateHandoffReadableSql('handoff', agentExpr, borrowedSourceExpr)})`;
}

export function permissionDeciderSql(
  permission: string,
  card: string,
  workspace: string,
  viewer: string,
): string {
  return `CASE WHEN ${card}->>'purpose'='squire-spending' THEN EXISTS (
    SELECT 1 FROM agents spender
    WHERE spender.agent_id=${card}->'agent'->>'pubkey' AND spender.owner_id=${viewer})
    ELSE (${permission}.principal_id=${viewer} OR EXISTS (
      SELECT 1 FROM memberships manager
      WHERE manager.workspace_id=${workspace} AND manager.room_id IS NULL
        AND manager.identity_id=${viewer} AND manager.removed_at IS NULL
        AND manager.role IN ('owner','admin'))) END`;
}

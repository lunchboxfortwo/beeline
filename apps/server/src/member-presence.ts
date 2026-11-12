/** Read existing joined-session connection state ahead of helper presence. */
export function memberPresenceSql(member: string): string {
  return `SELECT body,updated_at FROM (
    SELECT jsonb_build_object('status',CASE WHEN delivery.stream_id IS NOT NULL
        AND token.hash IS NOT NULL AND token.revoked_at IS NULL
        AND connection.identity_id IS NOT NULL AND connection.revoked_at IS NULL THEN 'online' ELSE 'offline' END,
      'held',delivery.stream_id IS NOT NULL
        AND token.hash IS NOT NULL AND token.revoked_at IS NULL AND connection.identity_id IS NOT NULL AND connection.revoked_at IS NULL,
      'observedAt',extract(epoch FROM delivery.created_at)::bigint) body,
      delivery.created_at updated_at,1 priority
    FROM rooms_mcp_delivery delivery
    LEFT JOIN rooms_mcp_tokens token ON token.hash=delivery.credential_hash
    LEFT JOIN rooms_mcp_connections connection ON connection.client_id=token.client_id
      AND connection.identity_id=token.identity_id
    WHERE delivery.member_id=${member} AND delivery.mechanism='local'
    UNION ALL
    SELECT body,updated_at,0 priority FROM live_outputs
    WHERE agent_id=${member} AND kind='presence'
  ) presence_source ORDER BY priority DESC,updated_at DESC LIMIT 1`;
}

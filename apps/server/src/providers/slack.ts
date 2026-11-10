import type { SqlDatabase } from '../database.js';
import type { ProviderAdapter } from './types.js';
export const key = 'slack' as const;
export const adapter: ProviderAdapter = { key };

export async function connectedSlackApp(db: SqlDatabase, workspaceId: string) {
  return (
    await db.query<{ id: string; composio_account_id: string }>(
      `SELECT app.id,app.composio_account_id FROM workspace_apps app
         JOIN memberships owner ON owner.workspace_id=$1 AND owner.room_id IS NULL
           AND owner.identity_id=app.owner_identity_id AND owner.removed_at IS NULL
         WHERE app.workspace_id=$1 AND app.app_key='slack' AND app.transport='composio'
           AND app.state='active' AND app.composio_account_id IS NOT NULL
         ORDER BY app.updated_at DESC LIMIT 1`,
      [workspaceId],
    )
  ).rows[0];
}

export async function slackEventAvailable(db: SqlDatabase, roomId: string, agentId: string) {
  return await db.query(
    `SELECT 1 FROM rooms room
     JOIN room_access agent ON agent.room_id=room.id AND agent.identity_id=$2 AND agent.removed_at IS NULL
     JOIN workspace_apps app ON app.workspace_id=room.workspace_id AND app.app_key='slack'
       AND app.transport='composio' AND app.state='active' AND app.composio_account_id IS NOT NULL
     JOIN memberships owner ON owner.workspace_id=room.workspace_id AND owner.room_id IS NULL
       AND owner.identity_id=app.owner_identity_id AND owner.removed_at IS NULL
     WHERE room.id=$1 AND room.archived_at IS NULL LIMIT 1`,
    [roomId, agentId],
  );
}

export async function slackDeliveries<Row extends Record<string, unknown>>(
  db: SqlDatabase,
  triggerId: string,
  accountId: string,
) {
  return await db.query<Row>(
    `SELECT subscription.* FROM agent_subscriptions subscription
     JOIN rooms room ON room.id=subscription.room_id AND room.archived_at IS NULL
     JOIN room_access agent ON agent.room_id=room.id AND agent.identity_id=subscription.agent_id
       AND agent.removed_at IS NULL
     JOIN workspace_apps app ON app.id=subscription.service_app_id AND app.workspace_id=room.workspace_id
       AND app.state='active' AND app.transport='composio' AND app.app_key='slack'
       AND app.composio_account_id=subscription.service_account_id
     JOIN memberships owner ON owner.workspace_id=room.workspace_id AND owner.room_id IS NULL
       AND owner.identity_id=app.owner_identity_id AND owner.removed_at IS NULL
     WHERE subscription.paused_at IS NULL AND subscription.source='service' AND subscription.event='new_message'
       AND subscription.trigger_id=$1 AND subscription.service_account_id=$2`,
    [triggerId, accountId],
  );
}

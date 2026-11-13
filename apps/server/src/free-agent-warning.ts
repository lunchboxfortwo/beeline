import type { SqlDatabase } from './database.js';

/** Pairing is a server-observed conversion; model-authored offers are not inferred. */
export async function recordAgentConnectedAfterNudge(
  db: SqlDatabase, ownerId: string, workspaceId: string, agentId: string,
): Promise<void> {
  await db.query(`INSERT INTO free_agent_events(agent_id,kind,detail)
    SELECT free.agent_id,'agent_connected_after_nudge',jsonb_build_object('connectedAgentId',$3::text)
    FROM free_agents free JOIN memberships member ON member.identity_id=free.agent_id
      AND member.room_id IS NULL AND member.removed_at IS NULL
    WHERE free.owner_id=$1 AND member.workspace_id=$2
      AND NOT EXISTS(SELECT 1 FROM free_agents own WHERE own.agent_id=$3)
      AND EXISTS(SELECT 1 FROM free_agent_events event WHERE event.agent_id=free.agent_id
        AND event.kind IN ('allowance_warning','nudge_shown') AND event.at>=now()-interval '24 hours')
      AND NOT EXISTS(SELECT 1 FROM free_agent_events event WHERE event.agent_id=free.agent_id
        AND event.kind='agent_connected_after_nudge' AND event.detail->>'connectedAgentId'=$3)`,
  [ownerId, workspaceId, agentId]);
}

/** A person reaching the real Add agent command is an observable guide start. */
export async function recordFreeAgentGuideStarted(database: SqlDatabase, ownerId: string, workspaceId: string): Promise<void> {
  await database.query(`INSERT INTO free_agent_events(agent_id,kind,detail)
    SELECT free.agent_id,'guide_started',jsonb_build_object('source','add_agent_command','warningId',warning.id)
    FROM free_agents free JOIN memberships member ON member.identity_id=free.agent_id
      AND member.room_id IS NULL AND member.removed_at IS NULL
    JOIN LATERAL (
      SELECT event.id FROM free_agent_events event WHERE event.agent_id=free.agent_id
        AND event.kind='allowance_warning' AND event.at>=now()-interval '24 hours'
      ORDER BY event.at DESC,event.id DESC LIMIT 1
    ) warning ON true
    WHERE free.owner_id=$1 AND member.workspace_id=$2
      AND NOT EXISTS(SELECT 1 FROM free_agent_events started WHERE started.agent_id=free.agent_id
        AND started.kind='guide_started' AND started.detail->>'warningId'=warning.id::text)
    ON CONFLICT DO NOTHING`,
    [ownerId, workspaceId]);
}

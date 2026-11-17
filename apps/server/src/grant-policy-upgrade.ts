import {
  agentGrantAutoApproves,
  isAgentGrantKind,
  commandRuleEscalations,
  parseCommandGrantTarget,
  type CommandGrantScript,
} from '@beeline/api-contract/agent-grants';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import { ensureSystemIdentity } from './system-line.js';

/** Withdraw only obsolete pending prompts; current Ask first requests survive boot. */
export async function withdrawSupersededGrantAsks(database: SqlDatabase): Promise<number> {
  return database.transaction(async (db) => {
    const pending = await db.query<{
      id: string;
      kind: string;
      target: string;
      script: CommandGrantScript | null;
      yolo: boolean;
      own_app: boolean;
      requester_is_owner: boolean;
    }>(`SELECT g.id::text,g.kind,g.target,g.script,
        (agent.yolo_mode AND workspace.visibility<>'public') yolo,
        (g.app_id IS NULL OR app.owner_identity_id=agent.owner_id) own_app,
        (g.requested_by=agent.owner_id) requester_is_owner
      FROM agent_grants g JOIN agents agent ON agent.agent_id=g.agent_id
      JOIN workspaces workspace ON workspace.id=g.workspace_id
      LEFT JOIN workspace_apps app ON app.id=g.app_id
      WHERE g.status='pending' FOR UPDATE OF g`);
    const superseded = pending.rows
      .filter((grant) => {
        if (grant.kind === 'mcp' && grant.target === 'wallet') return false;
        if (grant.kind === 'budget' || grant.kind === 'repository' || grant.kind === 'shared_asset') return true;
        if (!isAgentGrantKind(grant.kind)) return false;
        try {
          const escalations = grant.kind === 'command'
            ? commandRuleEscalations(parseCommandGrantTarget(grant.target), grant.script ?? undefined) : [];
          return agentGrantAutoApproves({ kind: grant.kind, target: grant.target, escalations,
            yolo: grant.yolo, ownApp: grant.own_app, requesterIsOwner: grant.requester_is_owner });
        } catch { return false; }
      })
      .map((grant) => grant.id);
    if (!superseded.length) return 0;
    await ensureSystemIdentity(db);
    await db.query(
      `UPDATE agent_grants SET status='revoked',decided_by=$2,decided_at=now()
       WHERE id::text=ANY($1::text[]) AND status='pending'`,
      [superseded, SYSTEM_IDENTITY_ID],
    );
    await db.query(
      `UPDATE messages m SET card=jsonb_set(m.card,'{grants}',(
        SELECT jsonb_agg(CASE WHEN e->>'grantId'=ANY($1::text[])
          THEN jsonb_set(e,'{status}','"revoked"'::jsonb) ELSE e END ORDER BY ordinal)
        FROM jsonb_array_elements(m.card->'grants') WITH ORDINALITY entries(e,ordinal)
      )) WHERE m.card_type='grant-request' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(m.card->'grants') e
        WHERE e->>'grantId'=ANY($1::text[])
      )`,
      [superseded],
    );
    return superseded.length;
  });
}

import { diagnosticContext } from './diagnostics.js';
import { randomUUID as diagnosticId } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import type { FreeAgentService } from './free-agents.js';
import { createWorkspaceOwnerMembership } from './membership-join.js';
import { ensureFirstRoom } from './first-room.js';

/** Shared first-run creation. The caller owns the transaction, including any consent grant. */
export async function createWorkspace(
  db: SqlDatabase, input: PhoneOperationMap['createWorkspace']['input'], viewerId: string,
  freeAgents?: Pick<FreeAgentService, 'createInWorkspace'>,
  source: 'manual_ui'|'onboarding'|'mcp_consent'|'recovery' = input.creationSource ?? 'manual_ui',
): Promise<{ id: string; roomId: string }> {
  if (input.timeZone !== undefined) {
    if (typeof input.timeZone !== 'string' || input.timeZone.length > 100) throw new Error('Invalid time zone');
    try { new Intl.DateTimeFormat('en', { timeZone: input.timeZone }); } catch { throw new Error('Invalid time zone'); }
  }
  if (!['manual_ui','onboarding','mcp_consent','recovery'].includes(source)) throw new Error('Invalid creation source');
  const origin = diagnosticContext()?.origin;
  const id = input.workspaceId ?? randomUUID();
  const inserted = await db.query(
    `INSERT INTO workspaces(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING`,
    [id, input.name],
  );
  if (!inserted.rowCount) {
    const owned = await db.query(
      `SELECT 1 FROM workspaces w JOIN memberships m ON m.workspace_id=w.id AND m.room_id IS NULL
       WHERE w.id=$1 AND m.identity_id=$2 AND m.role='owner' AND m.removed_at IS NULL`,
      [id, viewerId],
    );
    if (!owned.rowCount) throw new Error('workspaceId is invalid');
  } else {
    await createWorkspaceOwnerMembership(db, [id, viewerId]);
    await db.query(`WITH fact AS (
      INSERT INTO workspace_creation_facts(workspace_id,user_id,source,action_id,session_id,device_id)
      VALUES($1,$2,$3,$4,
        (SELECT id FROM diagnostic_sessions WHERE id=$5 AND user_id=$2),
        (SELECT device_id FROM diagnostic_sessions WHERE id=$5 AND user_id=$2)) RETURNING *
    ) INSERT INTO diagnostic_actions(event_id,session_id,user_id,source,occurred_at,action_id,detail)
      SELECT $6,session_id,user_id,'server',now(),action_id,
        jsonb_build_object('name','workspace_created','outcome','success','workspaceId',workspace_id,'creationSource',source)
      FROM fact`,[id,viewerId,source,origin?.actionId ?? null,origin?.sessionId ?? null,diagnosticId()]);
  }
  const generalId = await ensureFirstRoom(db, id, viewerId);
  // Only a newly created Workspace gets a free starter agent, in the same
  // transaction as its #general, so the creator lands next to it.
  if (inserted.rowCount && freeAgents)
    await freeAgents.createInWorkspace(db, {
      workspaceId: id,
      creatorId: viewerId,
      roomId: generalId,
      team: true,
      timeZone: input.timeZone,
    });
  return { id, roomId: generalId };
}

/** The app asks for a name; automatic onboarding uses the person's first name. */
export function defaultWorkspaceName(identityName: string | null): string {
  const firstName = identityName?.trim().split(/\s+/)[0];
  return firstName ? `${firstName}'s team` : 'Your team';
}

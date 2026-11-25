import type { AgentPlaceReset } from '@beeline/api-contract/daemon';
import { endAgentTurn } from './agent-turn-end.js';
import type { SqlDatabase } from './database.js';

/** Order restart commits with invocation starts and output for the same place. */
export async function lockAgentPlace(db: SqlDatabase, agentId: string, roomId: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('agent-place:' || $1 || ':' || $2, 0))",
    [agentId, roomId]);
}

export async function readAgentPlaceResets(db: SqlDatabase, agentId: string, roomId?: string): Promise<AgentPlaceReset[]> {
  return (await db.query<AgentPlaceReset>(`SELECT DISTINCT ON (room_id) room_id::text AS "roomId",id
    FROM agent_commands WHERE agent_id=$1 AND ($2::uuid IS NULL OR room_id=$2)
      AND action='restart' AND state='complete'
    ORDER BY room_id,inbox_sequence DESC,id DESC`, [agentId, roomId ?? null])).rows;
}

/** The restart request is terminal at commit. Its predecessor's input stays owed. */
export async function commitAgentPlaceReset(
  db: SqlDatabase, command: { id: string; agent_id: string; room_id: string },
): Promise<void> {
  if (!await endAgentTurn(db, command, 'complete')) return;
  await db.query(`UPDATE agent_invocations invocation SET ended=true
    FROM agent_commands command WHERE invocation.command_id=command.id
      AND command.agent_id=$1 AND command.room_id=$2 AND NOT invocation.ended`,
    [command.agent_id, command.room_id]);
  await db.query(`SELECT interrupted.* FROM agent_turns turn CROSS JOIN LATERAL
    beeline_interrupt_agent_turn(turn.agent_id,turn.room_id,turn.request_id,NULL,turn.started_at) interrupted
    WHERE turn.agent_id=$1 AND turn.room_id=$2 AND turn.status='working'`, [command.agent_id, command.room_id]);
  await db.query("DELETE FROM live_outputs WHERE agent_id=$1 AND room_id=$2 AND kind IN ('draft','thought')",
    [command.agent_id, command.room_id]);
}

/** Finish pending restart controls left by the previous server. */
export async function migratePendingAgentPlaceResets(database: SqlDatabase): Promise<void> {
  const pending = await database.query<{ id: string; agent_id: string; room_id: string }>(
    "SELECT id,agent_id,room_id FROM agent_commands WHERE action='restart' AND state='pending'");
  for (const command of pending.rows)
    await database.transaction(async db => {
      await lockAgentPlace(db, command.agent_id, command.room_id);
      await commitAgentPlaceReset(db, command);
    });
}

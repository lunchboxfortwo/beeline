import type { SqlDatabase } from './database.js';
import type { RoomViewPendingAgentCommand } from '@beeline/api-contract/phone';

export type FreeAgentRuntimePhase = NonNullable<RoomViewPendingAgentCommand['runtimePhase']>;

/** Commit the phase and journal together; an old operation cannot overwrite its successor. */
export async function writeRuntimePhase(
  db: SqlDatabase,
  agentId: string,
  operationId: string,
  phase: FreeAgentRuntimePhase['phase'],
  machineVersion?: string,
  cause?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const detail: FreeAgentRuntimePhase = {
      operationId,
      phase,
      ...(machineVersion ? { machineVersion } : {}),
      ...(cause ? { cause } : {}),
    };
    const changed = await tx.query(
      `UPDATE free_agents SET runtime_phase=$3::jsonb,updated_at=now()
      WHERE agent_id=$1 AND runtime_operation_id=$2 AND removed_at IS NULL RETURNING agent_id`,
      [agentId, operationId, JSON.stringify(detail)],
    );
    if (changed.rowCount)
      await tx.query(
        `INSERT INTO free_agent_events(agent_id,kind,detail) VALUES($1,'runtime_phase',$2::jsonb)`,
        [agentId, JSON.stringify(detail)],
      );
  });
}

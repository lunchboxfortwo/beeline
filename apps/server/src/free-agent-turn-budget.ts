import type { SqlDatabase } from './database.js';
import type { CommandRow } from './agent-command.js';
import { endAgentTurn } from './agent-turn-end.js';
import { recordAgentTurnFailure } from './agent-turn-failure.js';

/** The hosted-model allowance (part of the agent's own credentials) refused this item. */
export async function endFreeAgentModelTurn(db: SqlDatabase, commandId: string, reason: string): Promise<void> {
  await db.transaction(async db => {
    const command = (await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1 FOR UPDATE`, [commandId])).rows[0];
    if (command && await endAgentTurn(db,command,'failed',reason)) await recordAgentTurnFailure(db,command,reason);
  });
}

import type { SqlDatabase } from './database.js';
import type { CommandRow } from './agent-command.js';
import { endAgentTurn } from './agent-turn-end.js';
import { invocationCommandSql } from './turn-ownership.js';
import { recordAgentTurnFailure } from './agent-turn-failure.js';

export async function endFreeAgentModelTurn(db: SqlDatabase, commandId: string,
  generation: string | null, reason: string): Promise<void> {
  await db.transaction(async db => {
    const commands = (await db.query<CommandRow>(`SELECT invocation_command.*
      FROM agent_commands anchor JOIN agent_commands invocation_command
        ON ${invocationCommandSql('anchor','invocation_command')}
      WHERE anchor.id=$1 AND anchor.generation_id IS NOT DISTINCT FROM $2
      ORDER BY invocation_command.created_at,invocation_command.id FOR UPDATE OF invocation_command`, [commandId,generation])).rows;
    for (const command of commands)
      if (await endAgentTurn(db,command,'failed',reason)) await recordAgentTurnFailure(db,command,reason);
  });
}

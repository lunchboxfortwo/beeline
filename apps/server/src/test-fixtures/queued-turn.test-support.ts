import type { SqlDatabase } from '../database.js';
import type { DaemonService } from '../daemon-service.js';
import type { CommandRow } from '../agent-command.js';

/** Publish delivery status for an existing item; the item remains pending. */
export async function startQueuedTurn(db: SqlDatabase, roomId: string, agentId: string, commandId: string) {
  const command = (await db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1 AND room_id=$2 AND agent_id=$3',
    [commandId, roomId, agentId])).rows[0];
  if (!command) throw new Error('queue item not found');
  await db.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status)
    VALUES($1,$2,$3,'working') ON CONFLICT(room_id,request_id,agent_id) DO NOTHING`,
    [roomId, command.turn_request_id, agentId]);
  return { ...command, commandId, requestId: command.turn_request_id };
}

export async function startQueuedCommand(daemon: DaemonService, input: { roomId: string; commandId: string }, agentId: string) {
  const { commands } = await daemon.execute('getAgentCommands', { roomId: input.roomId }, agentId);
  const command = commands.find(item => item.id === input.commandId);
  if (!command) throw new Error('queue item not found');
  await daemon.execute('startAgentTurn', { roomId: command.roomId, requestId: command.turnRequestId }, agentId);
  return { ...command, commandId: command.id, requestId: command.turnRequestId };
}

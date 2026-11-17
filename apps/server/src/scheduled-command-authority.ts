import { authorizeCommandOutput, type CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { resourceReadAuthority } from './resource-requester.js';

/** Capture only the command verified at save time, including command-only roots.
 * A worker's current owner or an event payload never supplies missing provenance. */
export async function verifiedScheduleCommand(
  db: SqlDatabase, roomId: string, agentId: string, requestId: unknown,
): Promise<CommandRow | undefined> {
  if (typeof requestId !== 'string') return undefined;
  const command = await authorizeCommandOutput(db, roomId, agentId, requestId);
  const authority = await resourceReadAuthority(db, command);
  if (!authority) return undefined;
  const human = await db.query(`SELECT 1 FROM identities WHERE id=$1 AND kind='human' AND NOT hidden_from_roster`,
    [authority.requester_identity_id]);
  return human.rowCount ? command : undefined;
}

/** Definition-owned provenance, scoped to its original agent and place. */
export async function savedScheduleCommand(
  db: SqlDatabase, commandId: string | null | undefined, roomId: string, agentId: string,
): Promise<CommandRow | undefined> {
  if (!commandId) return undefined;
  return (await db.query<CommandRow>(
    'SELECT * FROM agent_commands WHERE id=$1 AND room_id=$2 AND agent_id=$3',
    [commandId, roomId, agentId],
  )).rows[0];
}

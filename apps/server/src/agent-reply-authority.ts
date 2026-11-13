import { RECLAIMED_REPLY_REFUSAL } from '@beeline/api-contract/helper-turn-ownership';
import { CommandRefusalError } from './command-refusal.js';
import type { SqlDatabase } from './database.js';
import type { CommandRow } from './agent-command.js';
import { ownedRoomAccessSql } from './turn-ownership.js';

/** Reply delivery survives transport replacement. Tools retain their stricter
 * execution ownership; only a previously claimed generation can answer a job. */
export async function authorizeAgentReply(db: SqlDatabase, room: string, agent: string,
  request: unknown, generation: unknown): Promise<CommandRow> {
  if (typeof request !== 'string' || typeof generation !== 'string')
    throw new CommandRefusalError('command output authority rejected: missing reply identity', 403);
  // Membership writers must complete before admission, or wait for this reply
  // transaction. No connection or server lease participates in publication.
  if (!(await db.query(ownedRoomAccessSql('$1', '$2', '$3', true), [room, agent, null])).rowCount)
    throw new CommandRefusalError('command output authority rejected: membership or place ended', 403);
  const command = (await db.query<CommandRow>(`SELECT command.* FROM agent_commands command
    WHERE command.room_id=$1 AND command.agent_id=$2 AND command.turn_request_id=$3
      AND command.action IN ('input','resume')
      AND EXISTS(SELECT 1 FROM agent_command_generation_owners binding
        WHERE binding.command_id=command.id AND binding.generation_id=$4)
    ORDER BY command.created_at DESC,command.id DESC LIMIT 1 FOR UPDATE OF command`,
    [room, agent, request, generation])).rows[0];
  if (!command) throw new CommandRefusalError('command output authority rejected: unknown reply generation', 403);
  // A workflow visit is a separate authority boundary. Reconnect tolerance
  // cannot revive a reclaimed visit or manufacture its historical output.
  if (command.generation_id !== generation && (await db.query(`SELECT 1 FROM messages
    WHERE id=$1 AND card->>'runId' IS NOT NULL`, [command.source_message_id])).rowCount)
    throw new CommandRefusalError(RECLAIMED_REPLY_REFUSAL.message, RECLAIMED_REPLY_REFUSAL.status);
  if (command.state === 'cancelled') throw new CommandRefusalError('command turn cancelled', 403);
  if ((await db.query(`SELECT 1 FROM agent_turns WHERE room_id=$1 AND agent_id=$2
    AND request_id=$3 AND completion_kind='no-reply'`, [room, agent, request])).rowCount)
    throw new CommandRefusalError('Reply not delivered: text was dropped because this turn chose no reply.', 409);
  // An explicit failed report may precede the harness's closing text.
  // Terminal command state still fences new results; cancellation is final.
  if ((await db.query(`SELECT 1 FROM agent_turns WHERE room_id=$1 AND agent_id=$2
    AND request_id=$3 AND status='cancelled'`, [room, agent, request])).rowCount)
    throw new CommandRefusalError('Reply not delivered: command turn cancelled.', 403);
  return command;
}

/** A refused result cannot leave its matching execution holding the queue.
 * Never release a successor generation or resurrect completed/cancelled work. */
export async function requeueRefusedReply(db: SqlDatabase, room: string, agent: string,
  request: unknown, generation: unknown): Promise<boolean> {
  const requeued = await db.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,
    lease_expires_at=NULL,claimed_at=NULL,turn_owner_connection_id=NULL,turn_owner_epoch=NULL
    WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3 AND generation_id=$4 AND state='claimed'`,
    [room, agent, request ?? null, generation ?? null]);
  return requeued.rowCount > 0;
}

import type { AgentInvocation } from '@beeline/api-contract/daemon';
import type { CommandRow } from './agent-command.js';
import { CommandRefusalError,ExpectedRefusalError } from './command-refusal.js';
import type { SqlDatabase } from './database.js';

/** Register before prompt delivery, never reset an existing attempt's receipt. */
export async function beginAgentInvocation(database: SqlDatabase, agent: string, room: string, request: string, id: string, batchedCommandIds: readonly string[] = []): Promise<void> {
  if (!id || id.length > 128) throw new ExpectedRefusalError('invalid invocation');
  await database.transaction(async db => {
    await db.query(`SELECT command.id FROM agent_commands command
      WHERE command.agent_id=$1 AND command.room_id=$2 AND command.turn_request_id=$3
        AND EXISTS(SELECT 1 FROM rooms_mcp_members member WHERE member.member_id=command.agent_id)
      ORDER BY command.id FOR UPDATE OF command`, [agent,room,request]);
    const saved = await db.query(`INSERT INTO agent_invocations(command_id,invocation_id,batched_command_ids)
      SELECT id,$4,ARRAY(SELECT batch.id FROM agent_commands batch WHERE batch.room_id=$2 AND batch.agent_id=$1
        AND batch.action='input' AND batch.state='pending' AND batch.id=ANY($5::text[])) FROM agent_commands WHERE agent_id=$1 AND room_id=$2 AND turn_request_id=$3 AND state='pending'
      ORDER BY created_at DESC,id DESC LIMIT 1 ON CONFLICT DO NOTHING RETURNING command_id`, [agent,room,request,id,batchedCommandIds]);
    if (!saved.rowCount && !(await db.query(`SELECT 1 FROM agent_invocations invocation JOIN agent_commands command ON command.id=invocation.command_id
      WHERE command.agent_id=$1 AND command.room_id=$2 AND command.turn_request_id=$3 AND invocation.invocation_id=$4`,[agent,room,request,id])).rowCount)
      throw new ExpectedRefusalError('invocation requires a pending command');
  });
}

/** Lock the invocation before any target command locks. Both reply and final use this order. */
export async function lockAgentInvocation(db: SqlDatabase, agent: string, room: string, invocation: AgentInvocation) {
  const row = (await db.query<{command_id:string;state:string}>(`SELECT receipt.command_id,command.state
    FROM agent_invocations receipt JOIN agent_commands command ON command.id=receipt.command_id
    WHERE command.agent_id=$1 AND command.room_id=$2 AND command.turn_request_id=$3 AND receipt.invocation_id=$4
    FOR UPDATE OF receipt`,[agent,room,invocation.requestId,invocation.id])).rows[0];
  if (!row) throw new ExpectedRefusalError('unknown invocation for this agent and place');
  return row;
}

export async function deliveredReplyCommand(db: SqlDatabase, agent: string, room: string, request: string | undefined,
  quote: string | undefined, invocation?: AgentInvocation): Promise<CommandRow> {
  const row = (await db.query<CommandRow>(`WITH current_turn AS (
      SELECT request_id,invocation_id,status FROM agent_turns WHERE agent_id=$1 AND room_id=$2
      ORDER BY started_at DESC,version DESC LIMIT 1)
    SELECT wake.* FROM current_turn turn
    JOIN agent_commands first ON first.agent_id=$1 AND first.room_id=$2 AND first.turn_request_id=turn.request_id
    JOIN agent_invocations receipt ON receipt.command_id=first.id AND receipt.invocation_id=turn.invocation_id
    JOIN agent_commands wake ON (wake.id=first.id OR wake.id=ANY(receipt.batched_command_ids))
    WHERE turn.status='working' AND NOT receipt.ended AND first.state<>'cancelled'
      AND ($5::text IS NULL OR (receipt.invocation_id=$5 AND turn.request_id=$6))
      AND wake.agent_id=$1 AND wake.room_id=$2 AND wake.turn_request_id=$3 AND wake.state='pending'
      AND wake.message->>'id'=$4 FOR UPDATE OF receipt,wake`,
    [agent,room,request ?? null,quote ?? null,invocation?.id ?? null,invocation?.requestId ?? null])).rows[0];
  if (!row) throw new CommandRefusalError('Quote a message that woke this turn.',400);
  return row;
}

/** Close the recorded execution and publish only if it has not been replaced. */
export async function finalizeAgentInvocation<T>(database: SqlDatabase, agent: string, room: string,
  invocation: AgentInvocation, publish: (db: SqlDatabase) => Promise<T>) {
  return database.transaction(async db => {
    const receipt = await lockAgentInvocation(db,agent,room,invocation);
    await db.query(`UPDATE agent_invocations SET ended=true WHERE command_id=$1 AND invocation_id=$2`,
      [receipt.command_id,invocation.id]);
    // Older senders may register an invocation without publishing a turn projection.
    // Only a recorded replacement proves that this final belongs to an obsolete session.
    const replacement = await db.query(`SELECT 1 FROM agent_turns WHERE agent_id=$1 AND room_id=$2
      AND request_id=$3 AND invocation_id IS NOT NULL AND invocation_id<>$4`, [agent,room,invocation.requestId,invocation.id]);
    if (replacement.rowCount) return {id:receipt.command_id,createdAt:Math.floor(Date.now()/1000)};
    const result = await publish(db);
    await db.query(`SELECT ended.* FROM agent_turns turn
        CROSS JOIN LATERAL beeline_interrupt_agent_turn($1,$2,$3,NULL,turn.started_at) ended
        WHERE turn.agent_id=$1 AND turn.room_id=$2 AND turn.request_id=$3 AND (turn.invocation_id IS NULL OR turn.invocation_id=$4)`,
        [agent,room,invocation.requestId,invocation.id]);
    return result;
  });
}

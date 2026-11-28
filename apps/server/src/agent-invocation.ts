import type { AgentInvocation } from '@beeline/api-contract/daemon';
import type { CommandRow } from './agent-command.js';
import { ExpectedRefusalError } from './command-refusal.js';
import type { SqlDatabase } from './database.js';
import { lockAgentPlace, readAgentPlaceResets } from './agent-place-reset.js';

/** Register before prompt delivery, never reset an existing attempt's receipt. */
export async function beginAgentInvocation(database: SqlDatabase, agent: string, room: string, request: string, id: string, batchedCommandIds: readonly string[] = [], resetId: string | null = null): Promise<void> {
  if (!id || id.length > 128) throw new ExpectedRefusalError('invalid invocation');
  await database.transaction(async db => {
    await db.query(`SELECT command.id FROM agent_commands command
      WHERE command.agent_id=$1 AND command.room_id=$2 AND command.turn_request_id=$3
        AND EXISTS(SELECT 1 FROM rooms_mcp_members member WHERE member.member_id=command.agent_id)
      ORDER BY command.id FOR UPDATE OF command`, [agent,room,request]);
    const saved = await db.query(`INSERT INTO agent_invocations(command_id,invocation_id,batched_command_ids,reset_id)
      SELECT command.id,$4,ARRAY(SELECT batch.id FROM agent_commands batch WHERE batch.room_id=$2 AND batch.agent_id=$1
        AND batch.action='input' AND batch.state='pending' AND batch.id=ANY($5::text[])),$6
      FROM agent_commands command
      JOIN rooms room ON room.id=command.room_id AND room.archived_at IS NULL
      WHERE command.agent_id=$1 AND command.room_id=$2 AND command.turn_request_id=$3 AND command.state='pending'
      ORDER BY command.created_at DESC,command.id DESC LIMIT 1 ON CONFLICT DO NOTHING RETURNING command_id`, [agent,room,request,id,batchedCommandIds,resetId]);
    if (!saved.rowCount && !(await db.query(`SELECT 1 FROM agent_invocations invocation JOIN agent_commands command ON command.id=invocation.command_id
      WHERE command.agent_id=$1 AND command.room_id=$2 AND command.turn_request_id=$3 AND invocation.invocation_id=$4
        AND invocation.reset_id IS NOT DISTINCT FROM $5`,[agent,room,request,id,resetId])).rowCount)
      throw new ExpectedRefusalError('invocation requires a pending command');
  });
}

/** Lock the invocation before any target command locks. Both reply and final use this order. */
export async function lockAgentInvocation(db: SqlDatabase, agent: string, room: string, invocation: AgentInvocation) {
  const row = (await db.query<{command_id:string;state:string;reset_id:string|null}>(`SELECT receipt.command_id,command.state,receipt.reset_id
    FROM agent_invocations receipt JOIN agent_commands command ON command.id=receipt.command_id
    WHERE command.agent_id=$1 AND command.room_id=$2 AND command.turn_request_id=$3 AND receipt.invocation_id=$4
    FOR UPDATE OF receipt`,[agent,room,invocation.requestId,invocation.id])).rows[0];
  if (!row) throw new ExpectedRefusalError('unknown invocation for this agent and place');
  return row;
}

/** A callback can still be in flight when its place is reset. */
export async function currentAgentInvocation(db: SqlDatabase, agent: string, room: string,
  invocation: AgentInvocation): Promise<boolean> {
  await lockAgentPlace(db, agent, room);
  const receipt = await lockAgentInvocation(db, agent, room, invocation);
  const [reset] = await readAgentPlaceResets(db, agent, room);
  return receipt.reset_id === (reset?.id ?? null);
}

/** Select the quoted wake or default a reply to the primary wake. */
export async function currentInvocationCommand(db: SqlDatabase, agent: string, room: string,
  reply?: { quote: string | undefined }): Promise<CommandRow | undefined> {
  return (await db.query<CommandRow>(`WITH current_turn AS (
      SELECT request_id,invocation_id,status FROM agent_turns WHERE agent_id=$1 AND room_id=$2
      ORDER BY started_at DESC,version DESC LIMIT 1)
    SELECT wake.* FROM current_turn turn
    JOIN agent_commands first ON first.agent_id=$1 AND first.room_id=$2 AND first.turn_request_id=turn.request_id
    JOIN agent_invocations receipt ON receipt.command_id=first.id AND receipt.invocation_id=turn.invocation_id
    JOIN agent_commands wake ON (wake.id=first.id OR wake.id=ANY(receipt.batched_command_ids))
    WHERE turn.status='working' AND NOT receipt.ended AND first.state<>'cancelled'
      AND wake.agent_id=$1 AND wake.room_id=$2 AND wake.action='input'
      AND (NOT $3::boolean AND (wake.id=first.id OR wake.reason='corner_review_dispatch' AND wake.state='pending')
        OR $3 AND wake.state='pending' AND (wake.message->>'id'=$4 OR $4 IS NULL AND wake.id=first.id))
    ORDER BY (NOT $3 AND wake.reason='corner_review_dispatch') DESC,(wake.id=first.id) DESC,wake.inbox_sequence
    LIMIT 1 FOR UPDATE OF receipt,wake`,
    [agent,room,Boolean(reply),reply?.quote ?? null])).rows[0];
}

/** Mark the calling agent's active self-closing invocation and return its commands. */
export async function activeClosingCornerCommands(
  db: SqlDatabase,
  cornerId: string,
  preserveTurn: { agentId: string; requestId?: string },
): Promise<Array<{ id: string; turn_request_id: string; state: string; invocation_id: string }>> {
  return (
    await db.query<{ id: string; turn_request_id: string; state: string; invocation_id: string }>(
      preserveTurn.requestId
        ? `WITH active AS (
             SELECT command.id, inv.invocation_id, inv.batched_command_ids
             FROM agent_commands command
             JOIN agent_invocations inv ON inv.command_id=command.id AND NOT inv.ended
             LEFT JOIN agent_turns turn
               ON turn.room_id=command.room_id AND turn.agent_id=command.agent_id
              AND turn.request_id=command.turn_request_id
             WHERE command.room_id=$1 AND command.agent_id=$2 AND command.state IN ('pending','complete')
               AND (turn.invocation_id IS NULL OR inv.invocation_id=turn.invocation_id)
               AND (command.turn_request_id=$3 OR EXISTS(
                 SELECT 1 FROM agent_commands batched
                 WHERE batched.room_id=$1 AND batched.agent_id=$2
                   AND batched.turn_request_id=$3 AND batched.id=ANY(inv.batched_command_ids)
               ))
             ORDER BY (turn.invocation_id=inv.invocation_id) DESC NULLS LAST,
               turn.version DESC NULLS LAST, command.created_at DESC, command.id DESC
             LIMIT 1
           ), marked AS (
             UPDATE agent_invocations inv SET self_closed=true
             FROM active
             WHERE inv.command_id=active.id AND inv.invocation_id=active.invocation_id
             RETURNING active.id, active.invocation_id, active.batched_command_ids
           )
           SELECT item.id, item.turn_request_id, item.state, marked.invocation_id
           FROM agent_commands item
           JOIN marked ON item.id=marked.id OR item.id=ANY(marked.batched_command_ids)
           WHERE item.room_id=$1 AND item.agent_id=$2 AND item.state IN ('pending','complete')`
        : `WITH current_turn AS (
             SELECT request_id, invocation_id, status
             FROM agent_turns
             WHERE agent_id=$2 AND room_id=$1
             ORDER BY started_at DESC, version DESC
             LIMIT 1
           ), active AS (
             SELECT first.id, receipt.invocation_id, receipt.batched_command_ids
             FROM current_turn turn
             JOIN agent_commands first ON first.agent_id=$2 AND first.room_id=$1 AND first.turn_request_id=turn.request_id
             JOIN agent_invocations receipt ON receipt.command_id=first.id AND receipt.invocation_id=turn.invocation_id
             WHERE turn.status='working' AND NOT receipt.ended AND first.state='pending'
             ORDER BY first.created_at DESC, first.id DESC
             LIMIT 1
           ), marked AS (
             UPDATE agent_invocations inv SET self_closed=true
             FROM active
             WHERE inv.command_id=active.id AND inv.invocation_id=active.invocation_id
             RETURNING active.id, active.invocation_id, active.batched_command_ids
           )
           SELECT item.id, item.turn_request_id, item.state, marked.invocation_id
           FROM agent_commands item
           JOIN marked ON item.id=marked.id OR item.id=ANY(marked.batched_command_ids)
           WHERE item.room_id=$1 AND item.agent_id=$2 AND item.state IN ('pending','complete')`,
      preserveTurn.requestId
        ? [cornerId, preserveTurn.agentId, preserveTurn.requestId]
        : [cornerId, preserveTurn.agentId],
    )
  ).rows;
}

/** Close the recorded execution and publish only if it has not been replaced. */
export async function finalizeAgentInvocation<T>(database: SqlDatabase, agent: string, room: string,
  invocation: AgentInvocation, publish: (db: SqlDatabase) => Promise<T>) {
  return database.transaction(async db => {
    await lockAgentPlace(db, agent, room);
    const receipt = await lockAgentInvocation(db,agent,room,invocation);
    const [reset] = await readAgentPlaceResets(db, agent, room);
    if (receipt.reset_id !== (reset?.id ?? null))
      return {commandId:receipt.command_id,completed:false,published:false,answered:false};
    await db.query(`UPDATE agent_invocations SET ended=true WHERE command_id=$1 AND invocation_id=$2`,
      [receipt.command_id,invocation.id]);
    // Older senders may register an invocation without publishing a turn projection.
    // Only a recorded replacement proves that this final belongs to an obsolete session.
    const replacement = await db.query(`SELECT 1 FROM agent_turns WHERE agent_id=$1 AND room_id=$2
      AND request_id=$3 AND invocation_id IS NOT NULL AND invocation_id<>$4`, [agent,room,invocation.requestId,invocation.id]);
    if (replacement.rowCount) return {commandId:receipt.command_id,completed:receipt.state === 'complete',published:false,superseded:true,answered:false};
    const result = await publish(db);
    await db.query(`SELECT ended.* FROM agent_turns turn
        CROSS JOIN LATERAL beeline_interrupt_agent_turn($1,$2,$3,NULL,turn.started_at) ended
        WHERE turn.agent_id=$1 AND turn.room_id=$2 AND turn.request_id=$3 AND (turn.invocation_id IS NULL OR turn.invocation_id=$4)`,
        [agent,room,invocation.requestId,invocation.id]);
    return result;
  });
}

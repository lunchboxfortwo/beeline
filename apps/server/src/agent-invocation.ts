import type { AgentInvocation } from '@beeline/api-contract/daemon';
import { ExpectedRefusalError } from './command-refusal.js';
import type { SqlDatabase } from './database.js';

/** Register before prompt delivery, never reset an existing attempt's receipt. */
export async function beginAgentInvocation(database: SqlDatabase, agent: string, room: string, request: string, id: string): Promise<void> {
  if (!id || id.length > 128) throw new ExpectedRefusalError('invalid invocation');
  await database.transaction(async db => {
    await db.query(`SELECT command.id FROM agent_commands command
      WHERE command.agent_id=$1 AND command.room_id=$2 AND command.turn_request_id=$3
        AND EXISTS(SELECT 1 FROM rooms_mcp_members member WHERE member.member_id=command.agent_id)
      ORDER BY command.id FOR UPDATE OF command`, [agent,room,request]);
    const saved = await db.query(`INSERT INTO agent_invocations(command_id,invocation_id)
      SELECT id,$4 FROM agent_commands WHERE agent_id=$1 AND room_id=$2 AND turn_request_id=$3 AND state='pending'
      ORDER BY created_at DESC,id DESC LIMIT 1 ON CONFLICT DO NOTHING RETURNING command_id`, [agent,room,request,id]);
    if (!saved.rowCount && !(await db.query(`SELECT 1 FROM agent_invocations invocation JOIN agent_commands command ON command.id=invocation.command_id
      WHERE command.agent_id=$1 AND command.room_id=$2 AND command.turn_request_id=$3 AND invocation.invocation_id=$4`,[agent,room,request,id])).rowCount)
      throw new ExpectedRefusalError('invocation requires a pending command');
  });
}

/** Lock the invocation before any target command locks. Both reply and final use this order. */
export async function lockAgentInvocation(db: SqlDatabase, agent: string, room: string, invocation: AgentInvocation) {
  const row = (await db.query<{command_id:string;replied:boolean;final_suppressed:boolean;state:string}>(`SELECT receipt.*,command.state
    FROM agent_invocations receipt JOIN agent_commands command ON command.id=receipt.command_id
    WHERE command.agent_id=$1 AND command.room_id=$2 AND command.turn_request_id=$3 AND receipt.invocation_id=$4
    FOR UPDATE OF receipt`,[agent,room,invocation.requestId,invocation.id])).rows[0];
  if (!row) throw new ExpectedRefusalError('unknown invocation for this agent and place');
  return row;
}

/** Check once before fanout. A suppression is accepted, but never answers a request. */
export async function finalizeAgentInvocation<T>(database: SqlDatabase, agent: string, room: string,
  invocation: AgentInvocation, publish: (db: SqlDatabase) => Promise<T>) {
  return database.transaction(async db => {
    const receipt = await lockAgentInvocation(db,agent,room,invocation);
    await db.query(`UPDATE agent_invocations SET ended=true WHERE command_id=$1 AND invocation_id=$2`,
      [receipt.command_id,invocation.id]);
    const current = await db.query(`SELECT 1 FROM agent_turns WHERE agent_id=$1 AND room_id=$2
      AND request_id=$3 AND invocation_id=$4`, [agent,room,invocation.requestId,invocation.id]);
    if (!current.rowCount) return {id:receipt.command_id,createdAt:Math.floor(Date.now()/1000),answered:false as const,suppressed:true as const};
    if (!receipt.replied) {
      const result = await publish(db);
      await db.query(`SELECT ended.* FROM agent_turns turn
        CROSS JOIN LATERAL beeline_interrupt_agent_turn($1,$2,$3,NULL,turn.started_at) ended
        WHERE turn.agent_id=$1 AND turn.room_id=$2 AND turn.request_id=$3 AND turn.invocation_id=$4`,
        [agent,room,invocation.requestId,invocation.id]);
      return result;
    }
    await db.query(`UPDATE agent_invocations SET final_suppressed=true WHERE command_id=$1 AND invocation_id=$2`,
      [receipt.command_id,invocation.id]);
    await db.query(`SELECT ended.* FROM agent_turns turn
        CROSS JOIN LATERAL beeline_interrupt_agent_turn($1,$2,$3,NULL,turn.started_at) ended
        WHERE turn.agent_id=$1 AND turn.room_id=$2 AND turn.request_id=$3 AND turn.invocation_id=$4`,
        [agent,room,invocation.requestId,invocation.id]);
    return {id:receipt.command_id,createdAt:Math.floor(Date.now()/1000),answered:false as const,suppressed:true as const};
  });
}

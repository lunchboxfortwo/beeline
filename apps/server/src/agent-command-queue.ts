import { commandOrder } from './commander.js';
import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { CornerAccessDatabase } from './corner-access-database.js';

/** The existing recipient membership fences insertion, answers and Stop even
 * when the queue is empty. Take it before command rows or shared member reads. */
export function lockAgentCommandQueue(db:SqlDatabase,roomId:string,agentId:string):Promise<void>;
export function lockAgentCommandQueue(db:SqlDatabase,recipients:readonly {roomId:string;agentId:string}[]):Promise<void>;
export async function lockAgentCommandQueue(db:SqlDatabase,room: string|readonly {roomId:string;agentId:string}[],agentId?:string):Promise<void> {
  const recipients=typeof room==='string'?[{roomId:room,agentId:agentId!}]:room;
  await CornerAccessDatabase.physical(db).query(`SELECT member.identity_id FROM memberships member
    WHERE (member.room_id,member.identity_id) IN (
      SELECT COALESCE(room.parent_id,room.id),recipient."agentId"
      FROM jsonb_to_recordset($1::jsonb) recipient("roomId" uuid,"agentId" text)
      JOIN rooms room ON room.id=recipient."roomId")
    ORDER BY member.room_id,member.identity_id FOR UPDATE OF member`,[JSON.stringify(recipients)]);
}

/** The Stop transaction's timestamp fences orders accepted after the Stop. */
export async function dropQueuedOrdersForStop(db: SqlDatabase, stopped: CommandRow): Promise<number> {
  const order = await commandOrder(db, stopped);
  if (order.private_payload?.kind !== 'order' || order.agent_id !== stopped.agent_id) return 0;
  const dropped = await db.query<CommandRow>(
    `SELECT (terminal.ended).* FROM (SELECT beeline_finish_agent_command(agent_commands.id,'cancelled','stop',NULL) ended FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND action='input'
       AND state='pending'
       AND private_payload->>'kind'='order'
       AND private_payload->>'authorId'=$3 AND private_payload->>'fromRoomId'=$4
       AND created_at<=now() AND turn_request_id<>$5) terminal`,
    [stopped.room_id, stopped.agent_id, order.private_payload.authorId,
      order.private_payload.fromRoomId, stopped.turn_request_id],
  );
  return dropped.rowCount;
}

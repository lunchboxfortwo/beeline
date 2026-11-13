import { lockAgentCommandQueue } from './agent-command-queue.js';
import { CommandRow } from './agent-command.js';
import { ExpectedRefusalError } from './command-refusal.js';
import type { SqlDatabase } from './database.js';



/**
 * Marks the handback-limit line so push delivery (`background.ts`) can send it
 * to the corner's commissioner. The phone has no renderer for it, so the line
 * still shows as a plain system line.
 */
export const CORNER_REVIEW_DEADLOCK_CARD_TYPE = 'corner-review-deadlock';


/** Legacy discriminator retained for historical checks-blocked lines. */
export const CORNER_CHECKS_BLOCKED_CARD_TYPE = 'corner-checks-blocked';


/** Historical discriminator; new queue refusals are private commander reports. */
export const CORNER_AGENT_UNREACHABLE_CARD_TYPE = 'corner-agent-unreachable';


/**
 * Marks the line a green head with no other reviewer writes. Its card names
 * the people whose yes can merge it (`card.approverIds`), and push delivery
 * (`corner-owed.ts`) sends it to them; like the two above it renders as a
 * plain system line.
 */
export const CORNER_MERGE_YES_CARD_TYPE = 'corner-merge-yes';


/** A connected app answers its orders through the queue: the order it names,
 * or its oldest pending order (this Room first). */
export async function selectMcpOrder(db: SqlDatabase, agentId: string, target: string,
  commandId?: string): Promise<CommandRow | undefined> {
  const waiting = (await db.query<CommandRow>(
    `SELECT * FROM agent_commands WHERE agent_id=$1 AND state='pending'
       AND private_payload->>'kind'='order' AND ($3::text IS NULL OR id=$3)
     ORDER BY (room_id::text=$2) DESC,created_at,id LIMIT 1`, [agentId,target,commandId ?? null])).rows;
  return waiting[0];
}


/** Acknowledging notifications never spends an unanswered queue item. */
export async function dismissAgentCommandWakes(db: SqlDatabase, roomId: string, agentId: string,
  commandId?: string): Promise<number> {
  return db.transaction(async db => {
    await lockAgentCommandQueue(db, roomId, agentId);
    const waiting = (await db.query<CommandRow>(`SELECT command.* FROM agent_commands command
      JOIN rooms room ON room.id=command.room_id AND room.archived_at IS NULL
      JOIN room_access member ON member.room_id=room.id AND member.identity_id=command.agent_id AND member.removed_at IS NULL
      WHERE command.room_id=$1 AND command.agent_id=$2 AND command.action='input' AND command.reason<>'mcp_call'
        AND ($3::text IS NULL OR command.id=$3)
        AND command.state='pending' AND EXISTS(SELECT 1 FROM messages answer
          WHERE answer.room_id=command.return_room_id AND answer.author_id=command.agent_id
            AND (answer.request_id IN (command.id,command.turn_request_id) OR EXISTS(
              SELECT 1 FROM agent_commands tool WHERE tool.parent_command_id=command.id
                AND tool.agent_id=command.agent_id AND tool.reason='mcp_call'
                AND tool.turn_request_id=answer.request_id)) AND answer.deleted_at IS NULL)
      ORDER BY command.created_at,command.id FOR UPDATE OF command`, [roomId,agentId,commandId ?? null])).rows;
    await db.query(`SELECT ended.id FROM agent_commands command CROSS JOIN LATERAL
      beeline_finish_agent_command(command.id,'complete',NULL,NULL) ended
      WHERE command.id=ANY($1::text[])`,[waiting.map(command=>command.id)]);
    return waiting.length;
  });
}


/** The queue item a tool call serves: the agent's newest item for this
 * request in this Room. Stop (a cancelled item) is the only refusal. */
export async function authorizeCommandOutput(
  db: SqlDatabase,
  roomId: string,
  agentId: string,
  requestId: unknown,
): Promise<CommandRow> {
  const row = typeof requestId === 'string'
    ? (await db.query<CommandRow>(
        `SELECT command.* FROM agent_commands command
         WHERE command.room_id=$1 AND command.agent_id=$2 AND command.turn_request_id=$3
         ORDER BY command.created_at DESC,command.id DESC LIMIT 1 FOR UPDATE OF command`,
        [roomId, agentId, requestId])).rows[0]
    : undefined;
  if (!row) throw new ExpectedRefusalError('command output authority rejected: no command row');
  if (row.state === 'cancelled') throw new ExpectedRefusalError('command turn cancelled');
  return row;
}


export { mergeCardDetail,squireDecisionDetail,workflowWakeDetail } from './agent-input-context.js';
export type { MergeCard,WorkflowWakeCard } from './agent-input-context.js';

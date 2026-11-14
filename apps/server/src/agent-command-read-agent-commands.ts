import type { AgentCommand,RoomInboxResult } from '@beeline/api-contract/daemon';
import { isResumeKind } from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { CommandRow,checkFailureLogBody,createAgentCommand,reportedHeadBody } from './agent-command.js';
import { advanceCorner } from './corner-lifecycle.js';
import type { SqlDatabase } from './database.js';



/** One durable queue read, shared by helper push and connected-app delivery. */
export async function readAgentQueueRows(db:SqlDatabase,agentId:string,roomId?:string) {
  return db.query<CommandRow & { parent_room_id: string | null }>(
    `SELECT item.*,room.parent_id parent_room_id FROM agent_commands item
     LEFT JOIN rooms room ON room.id=item.room_id
     WHERE item.agent_id=$1 AND ($2::text IS NULL OR item.room_id::text=$2) AND item.state='pending'
     ORDER BY item.inbox_sequence,item.created_at,item.id`, [agentId, roomId ?? null]);
 }

/** Every pending item in one agent's queue, in append order.
 * Membership belongs to insertion and publication; reading never spends an item. */
export async function readAgentCommands(
  db: SqlDatabase,
  agentId: string,
  roomId?: string,
): Promise<{ commandProtocol: 2; commands: AgentCommand[] }> {
  const rows = await readAgentQueueRows(db,agentId,roomId);
  return {
    commandProtocol: 2,
    commands: rows.rows.map(item => {
      const createdAt = Math.floor(new Date(item.created_at).getTime() / 1000);
      const source: AgentCommand['source'] = item.message ?? {
        createdAt,
        id: item.source_message_id ?? item.id, authorId: item.private_payload?.authorId ?? SYSTEM_IDENTITY_ID,
        body: item.private_payload?.text ?? item.reason,
        attachments: item.private_payload?.attachments ?? [], type: item.private_payload ? 'private' : 'system',
      };
      return {
        id: item.id, roomId: item.room_id, returnRoomId: item.return_room_id ?? item.room_id,
        ...(item.parent_room_id ? {parentRoomId:item.parent_room_id} : {}),
        agentId: item.agent_id, createdAt, sourceMessageId: source.id,
        turnRequestId: item.id, action: item.action, reason: item.reason,
        rootCommandId: item.root_command_id, rootSourceMessageId: item.root_source_message_id,
        ...(item.parent_command_id ? {parentCommandId:item.parent_command_id} : {}),
        agentDepth: item.agent_depth, ...(source.type === 'private' ? {private:true} : {}),
        ...(source.systemEvent?.scheduleId ? {scheduleId:source.systemEvent.scheduleId} : {}),
        source: { ...source, createdAt, body: source.body + checkFailureLogBody(source.systemEvent ?? null) + reportedHeadBody(source.systemEvent ?? null) },
      };
    }),
  };
}


/** Compatibility is a projection of durable commands, never a history query. */
export async function commandInbox(
  db: SqlDatabase,
  roomId: string,
  agentId: string,
): Promise<RoomInboxResult> {
  const { commands } = await readAgentCommands(db, agentId, roomId);
  return {
    dispatchVersion: 1,
    items: commands.map((c) => ({ ...c.source, id: c.sourceMessageId })),
  };
}


export async function routeSystemCommand(
  db: SqlDatabase,
  input: {
    roomId: string;
    sourceMessageId: string;
    kind?: string;
    targets: readonly string[];
    assignmentTargets?: readonly string[];
    requestId?: string;
    causeId?: string;
    commandId?: string;
  },
): Promise<void> {
  if (!input.kind) return;
  // A checks verdict in a corner is a corner lifecycle event: the transition
  // decides who wakes, exactly once.
  if (input.kind === 'check-passed' || input.kind === 'check-failed') {
    const corner = await db.query(`SELECT 1 FROM corner_facts WHERE corner_id=$1`, [input.roomId]);
    if (corner.rowCount) {
      await advanceCorner(db, input.roomId, {
        kind: 'checks',
        result: input.kind === 'check-passed' ? 'passing' : 'failing',
        sourceMessageId: input.sourceMessageId,
      });
      return;
    }
  }
  // A Stop cancels the stopped turn's pending items. A decision (approval,
  // connector, Squire) is a new item that continues its parent's turn; the
  // parent stays queued until it is answered.
  for (const agentId of new Set(input.targets)) {
    const cancel = input.kind === 'turn-cancelled';
    const resume = !cancel && isResumeKind(input.kind);
    let parent: CommandRow | undefined;
    if (cancel || resume) {
      parent = (await db.query<CommandRow>(
        `SELECT * FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND action='input'
           AND (($3::text IS NOT NULL AND turn_request_id=$3) OR ($4::text IS NOT NULL AND id=$4))
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [input.roomId, agentId, input.requestId ?? null, input.commandId ?? null])).rows[0];
      if (!parent) continue;
      if (cancel) {
        await db.query(`SELECT (terminal.ended).* FROM (SELECT beeline_finish_agent_command(id,'cancelled','stop',NULL) ended
          FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3 AND state='pending') terminal`,
          [input.roomId, agentId, parent.turn_request_id]);
        continue;
      }
    } else if (input.kind.startsWith('agent:')) {
      parent = (await db.query<CommandRow>(
        `SELECT * FROM agent_commands WHERE room_id=$1 AND id=$2 ORDER BY created_at DESC LIMIT 1`,
        [input.roomId, input.commandId ?? null])).rows[0];
      if (!parent) continue;
    }
    await createAgentCommand(db, {
      roomId: input.roomId,
      agentId,
      sourceMessageId: input.sourceMessageId,
      workflowAssignment: input.assignmentTargets?.includes(agentId),
      reason: resume ? 'resume' : input.kind === 'schedule-ran' ? 'schedule' : input.kind === 'computer-session-activity' ? 'computer_activity' : 'subscribed_event',
      ...(parent ? { parent, retainDepth: resume, resume } : {}),
    });
  }
}


/** Compatibility adapters: all admissions belong to the corner machine. */
export async function queueCornerMergeConflict(db: SqlDatabase, cornerId: string, sourceMessageId: string): Promise<boolean> {
  return Boolean((await advanceCorner(db, cornerId, { kind: 'merge-conflict', sourceMessageId })).wake?.queued);
}

export async function reconcileCornerMergeBlockers(db: SqlDatabase, cornerId?: string): Promise<number> {
  const rows = (await db.query<{ id: string }>(`SELECT id FROM rooms WHERE parent_id IS NOT NULL AND archived_at IS NULL
    AND ($1::uuid IS NULL OR id=$1)`, [cornerId ?? null])).rows;
  let commands = 0;
  for (const row of rows) if ((await advanceCorner(db, row.id, { kind: 'reconcile' })).wake?.queued) commands++;
  return commands;
}

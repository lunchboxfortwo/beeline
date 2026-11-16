import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { createHash,randomBytes } from 'node:crypto';
import { dropQueuedOrdersForStop,lockAgentCommandQueue } from './agent-command-queue.js';
import { queueMessage,type CommandRow,type PrivateCommandPayload,type QueuedDelivery } from './agent-command.js';
import { CommandRefusalError } from './command-refusal.js';
import { cornerCommanderBriefSql,cornerCommanderIdSql,threadTaskSql } from './corner-commander.js';
import { recordedMessageRoute } from './message-route.js';
import { cornerOpenedFromSql,cornerOpeningSql } from './corner-opening.js';
import { cornerImplementerSql } from './corner-worker.js';
import type { SqlDatabase } from './database.js';
import type { AfterCommit } from './institutional-memory-embeddings.js';
import { systemIdentityMention,systemLine } from './system-line.js';
import type { AgentVoice,Composed,SystemAuthorId } from './message-origin.js';
export { CommandRefusalError } from './command-refusal.js';

/** Follow provenance to the order that selects this command's return route. */
export async function commandOrder(db: SqlDatabase, command: CommandRow): Promise<CommandRow> {
  if (command.private_payload?.route || command.private_payload?.kind === 'order') return command;
  return (
    (
      await db.query<CommandRow>(
        `WITH RECURSIVE chain AS (
       SELECT command.*,0 hop FROM agent_commands command WHERE id=$1
       UNION ALL SELECT parent.*,child.hop+1 FROM agent_commands parent JOIN chain child
         ON parent.id=child.parent_command_id
     ) SELECT chain.* FROM chain LEFT JOIN messages source ON source.id=chain.source_message_id
     WHERE (chain.private_payload->>'kind'='order' AND (chain.agent_id=$2 OR chain.room_id=$3))
       OR (chain.private_payload IS NULL AND chain.agent_id=$2 AND source.id IS NOT NULL AND source.system_event IS NULL)
     ORDER BY hop LIMIT 1`,
        [command.id, command.agent_id, command.room_id],
      )
    ).rows[0] ?? command
  );
}

/** Reach stays membership based. Delegated orders recheck the issuing member
 * at commit so this read never upgrades another recipient's queue fence. */
export async function commandAddress(
  db: SqlDatabase,
  address: string,
  agentId: string,
  allowArchived = false,
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(address))
    throw new CommandRefusalError('address requires current membership', 403);
  const row = (
    await db.query<{ id: string; worker: string | null; parent_id: string | null; archived: boolean }>(
      `SELECT room.id,room.parent_id,room.archived_at IS NOT NULL archived,${cornerImplementerSql('fact', 'room')} worker
     FROM rooms room LEFT JOIN corner_facts fact ON fact.corner_id=room.id
     JOIN memberships member ON member.room_id=COALESCE(room.parent_id,room.id)
       AND member.identity_id=$2 AND member.removed_at IS NULL
     WHERE room.id=$1
     LIMIT 1 FOR SHARE OF room`,
      [address, agentId],
    )
  ).rows[0];
  if (!row) throw new CommandRefusalError('address requires current membership', 403);
  if (row.archived && !allowArchived) throw new CommandRefusalError('address is archived', 409);
  return row;
}

/** Corner turns reject DMs and ancestors, with a direct-parent exception for orders. */
export async function assertCornerCommandTarget(
  db: SqlDatabase, sourceRoomId: string, targetRoomId: string, allowParentOrder = false,
) {
  const dm = await db.query(
    `SELECT 1 FROM rooms source WHERE source.id=$1 AND source.parent_id IS NOT NULL
       AND (EXISTS (SELECT 1 FROM rooms target WHERE target.id::text=lower($2) AND target.direct_participants IS NOT NULL)
         OR EXISTS (SELECT 1 FROM identities agent WHERE agent.kind='agent'
           AND (agent.id=$2 OR lower(beeline_workspace_handle(agent.id,source.workspace_id))=lower(ltrim($2,'@'))))) LIMIT 1`,
    [sourceRoomId, targetRoomId],
  );
  if (dm.rowCount)
    throw new CommandRefusalError(
      "Threads can't order DMs. Report to your commander instead.", 403,
    );
  const blocked = await db.query(
    `WITH RECURSIVE ancestors(id) AS (
       SELECT id FROM rooms WHERE id=$1 AND parent_id IS NOT NULL
       UNION
       SELECT parent.id FROM ancestors ancestor
       JOIN rooms room ON room.id=ancestor.id
       CROSS JOIN LATERAL (VALUES (room.parent_id),(${cornerOpenedFromSql('room.id')})) parent(id)
       WHERE parent.id IS NOT NULL
     ) SELECT 1 FROM ancestors WHERE id<>$1 AND id::text=lower($2)
       AND NOT ($3::boolean AND id=(SELECT parent_id FROM rooms WHERE id=$1)) LIMIT 1`,
    [sourceRoomId, targetRoomId, allowParentOrder],
  );
  if (blocked.rowCount)
    throw new CommandRefusalError(
      "Threads can't order their parent chat. Report to your commander instead.", 403,
    );
}

/**
 * One order wakes exactly one agent: a corner's worker, the other agent of an
 * agent DM, or a named/sole other agent at a Room address. An order never fans out.
 */
export async function sendOrder(
  db: SqlDatabase, command: CommandRow, agentId: string, address: string, text: AgentVoice,
  agent?: string, _afterCommit?: AfterCommit, id?: string,
) {
  const queued = await queueMessage(db, { kind: 'order', roomId: address, authorId: agentId,
    agent, text, parent: command, id,
  });
  if ('feedback' in queued) return {...queued,receipt:queued.feedback};
  return { id: queued.id, createdAt: Math.floor(new Date(queued.created_at).getTime() / 1000),
    effect: 'order', address, agent: queued.agent_id, visibility: 'private', reportsAssignment: false,
    accepted: true, executionConfirmed: false, receipt: 'Order queued privately; not confirmation of execution.' };
}

/**
 * An agent stops the running turn of an agent it commands: the turn runs its
 * own order, or it runs in a corner this agent opened. The stop reuses the
 * tagged Stop: cancel the turn's queue items (its helper sees them gone), and drop the
 * orderer's older queued orders. An order sent after this call runs next.
 */
export async function stopCommandedTurn(
  db: SqlDatabase,
  command: CommandRow,
  agentId: string,
  address: string,
  agent?: string,
) {
  const named = agent?.trim().replace(/^@/, '');
  if (agent !== undefined && !named) throw new CommandRefusalError('stop agent must name one agent', 400);
  const target = await commandAddress(db, address, agentId);
  const candidates = (await db.query<{ id: string; handle: string | null; name: string }>(
    `SELECT identity.id,beeline_workspace_handle(identity.id,member.workspace_id) handle,identity.name FROM room_access member JOIN identities identity
       ON identity.id=member.identity_id AND identity.kind='agent'
     WHERE member.room_id=$1 AND member.removed_at IS NULL AND identity.id<>$2`,
    [address, agentId])).rows;
  const matches = named
    ? candidates.filter((row) => row.id === named || row.handle?.toLowerCase() === named.toLowerCase())
    : target.worker ? candidates.filter((row) => row.id === target.worker) : candidates;
  if (named && !matches.length)
    throw new CommandRefusalError(`stop agent ${named} is not another agent member of this address`, 400);
  if (matches.length !== 1)
    throw new CommandRefusalError('stop must name exactly one agent: pass agent with its handle or id', 400);
  const worker = matches[0]!;
  await lockAgentCommandQueue(db, address, worker.id);
  const running = (await db.query<CommandRow>(
    `SELECT command.* FROM agent_turns turn
     JOIN agent_commands command ON command.room_id=turn.room_id
       AND command.agent_id=turn.agent_id AND command.turn_request_id=turn.request_id
       AND command.action='input'
     WHERE turn.room_id=$1 AND turn.agent_id=$2 AND turn.status='working'
       AND command.state='pending'
     ORDER BY turn.created_at DESC,command.created_at DESC LIMIT 1 FOR UPDATE OF command`,
    [address, worker.id])).rows[0];
  if (!running)
    return { stopped: false, address, agent: worker.id, receipt: 'No running turn to stop.' };
  const order=await commandOrder(db,running);
  const ordered=order.private_payload?.route?.from.agent===agentId || order.private_payload?.kind==='order'&&order.private_payload.authorId===agentId;
  const commandsCorner = !ordered && Boolean(target.parent_id) && Boolean((await db.query(
    `SELECT 1 FROM rooms corner WHERE id=$1 AND ${cornerCommanderIdSql('corner')}=$2`, [address, agentId])).rowCount);
  if (!ordered && !commandsCorner)
    throw new CommandRefusalError(
      'stop refused: you did not order this turn and you do not command this thread; nothing was stopped', 403);
  const dropped = await dropQueuedOrdersForStop(db, running);
  await db.query(
    `SELECT (terminal.ended).* FROM (SELECT beeline_finish_agent_command(agent_commands.id,'cancelled','stop',NULL) ended FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3
       AND action='input' AND state='pending') terminal`,
    [address, worker.id, running.turn_request_id]);
  // Approved by lunchboxfortwo: "@commander stopped @worker's running turn".
  await systemLine(db, {
    id: createHash('sha256').update(`agent-stop-line:${command.id}:${running.id}`).digest('hex'),
    roomId: address, authorId: worker.id, subject: { kind: 'agent', id: agentId, name: agentId }, verb: systemMessage("commander.stopped"),
    object: systemMessage("commander.s-running-turn", systemIdentityMention({ ...worker, kind: 'agent' })),
    ...(dropped ? { consequence: systemMessage("commander.queued-dropped", dropped, dropped === 1 ? systemMessage("commander.order") : systemMessage("commander.orders")) } : {}),
  });
  return { stopped: true, address, agent: worker.id, droppedOrders: dropped,
    receipt: 'Running turn stopped. Send a new order; it runs next.' };
}

/** Commanders come from the assignment at the question boundary and its recorded
 * parents. Humans with current access outrank agents; peer activity never does.
 * Expressions refer to the caller's question row, not to later replacement orders.
 */
export function commanderChainSql(corner: string, asker: string, askedAt: string): string {
  return `WITH RECURSIVE approved_brief AS (${cornerCommanderBriefSql(`${corner}.id`, askedAt)}), assignment_chain AS (
    SELECT seed.* FROM agent_commands seed WHERE seed.id IN (
      (SELECT assigned.id FROM agent_commands assigned
        WHERE assigned.room_id=${corner}.id AND assigned.agent_id=${asker}
          AND assigned.created_at<=${askedAt}
          AND (NOT EXISTS(SELECT 1 FROM approved_brief) OR assigned.created_at>=(SELECT created_at FROM approved_brief))
          AND (assigned.private_payload->>'kind'='order' OR assigned.reason='human_tag')
        ORDER BY assigned.created_at DESC,assigned.id DESC LIMIT 1),
      COALESCE((SELECT approval_basis->>'commanderCommandId' FROM approved_brief),
        (SELECT opened.id FROM agent_commands opened WHERE opened.room_id=${corner}.id
          AND opened.reason='corner_objective' AND NOT EXISTS(SELECT 1 FROM approved_brief)
          ORDER BY opened.created_at,opened.id LIMIT 1)))
    UNION
    SELECT parent.* FROM agent_commands parent JOIN assignment_chain child ON parent.id=child.parent_command_id
  ), commanders AS (
    SELECT COALESCE((SELECT author_id FROM approved_brief),${corner}.created_by) id
    UNION SELECT approval_basis->>'approvedBy' FROM approved_brief
    UNION SELECT assigned.private_payload->>'authorId' FROM assignment_chain assigned
      WHERE assigned.private_payload->>'kind'='order'
    UNION SELECT source.author_id FROM assignment_chain assigned
      JOIN messages source ON source.id=assigned.source_message_id AND source.system_event IS NULL
    UNION SELECT source.author_id FROM assignment_chain assigned
      JOIN messages source ON source.id=assigned.root_source_message_id AND source.system_event IS NULL
  ) SELECT member.identity_id id FROM room_access member JOIN identities identity ON identity.id=member.identity_id
    WHERE member.room_id=${corner}.id AND member.removed_at IS NULL
      AND identity.id<>'${SYSTEM_IDENTITY_ID}'
      AND identity.id IS DISTINCT FROM (SELECT ${cornerImplementerSql('chain_fact', corner)}
        FROM corner_facts chain_fact WHERE chain_fact.corner_id=${corner}.id)
      AND (identity.kind='human' OR identity.id IN (SELECT id FROM commanders))`;
}

type ReportOptions = { orderIssuer?: boolean; automatic?: boolean; wakeInCorner?: boolean; ask?: string; attachments?: PrivateCommandPayload['attachments']; idleSince?: string; afterCommit?: AfterCommit };

type ReportReceipt = { id: string; createdAt: number; delivered?: boolean; receipt?: string };
/** A worker reports in its model's words; a machine report is System-authored. */
export function reportToCommander(db: SqlDatabase, roomId: string, agentId: string, text: AgentVoice,
  command?: CommandRow, reportId?: string, options?: ReportOptions): Promise<ReportReceipt>;
export function reportToCommander(db: SqlDatabase, roomId: string, agentId: SystemAuthorId, text: Composed<'system'>,
  command?: CommandRow, reportId?: string, options?: ReportOptions): Promise<ReportReceipt>;
export async function reportToCommander(
  db: SqlDatabase, roomId: string, agentId: string, text: AgentVoice | Composed<'system'>, command?: CommandRow,
  reportId = randomBytes(32).toString('hex'), options: ReportOptions = {},
): Promise<ReportReceipt> {
  const resolved = command ? undefined : await commanderReportAddress(db, roomId);
  const address = !options.orderIssuer ? command?.report_address ??
    (command?.private_payload?.kind === 'order' ? command.private_payload.escalation : undefined) : undefined;
  const recipient = address?.identityId ?? command?.private_payload?.returnIdentityId ??
    (command?.private_payload?.kind === 'order' ? command.private_payload.authorId : undefined) ?? resolved?.recipient;
  const source = command ?? resolved?.incoming ?? { id: reportId, room_id: roomId, agent_id: agentId,
    root_source_message_id: reportId, turn_request_id: reportId } as CommandRow;
  const parent = command?.parent_command_id ? (await db.query<CommandRow>(
    'SELECT * FROM agent_commands WHERE id=$1', [command.parent_command_id])).rows[0] : resolved?.parent;
  return queueMessage(db, { kind: 'delivery', roomId: address?.roomId ?? command?.return_room_id ?? resolved?.returnRoom ?? roomId,
    recipientId: recipient, authorId: agentId, text, id: reportId,
    sourceRoomId: roomId, sourceItem: source, parent,
    attachments: options.attachments, ask: options.ask,
    automatic: options.automatic, idleSince: options.idleSince,
  } as QueuedDelivery);
}

/** Lifecycle notices select an agent audience; they do not create a human request.
 * The machine writes them, so they are System-authored. */
export async function reportAgentAttention(
  db: SqlDatabase, roomId: string, agentId: SystemAuthorId, text: Composed<'system'>, command?: CommandRow,
  reportId = randomBytes(32).toString('hex'), options: ReportOptions = {},
): Promise<void> {
  const route = await commanderReportAddress(db, roomId, command);
  // A thread's own implementer works in the thread; like a person commander, it gets no notice elsewhere.
  const agent = (await db.query(`SELECT 1 FROM identities identity JOIN rooms place ON place.id=$2 AND place.archived_at IS NULL
    WHERE identity.id=$1 AND identity.kind='agent'
      AND identity.id IS DISTINCT FROM (SELECT implementer_agent_id FROM corner_facts WHERE corner_id=$3)`,
  [route.recipient,route.returnRoom,roomId])).rowCount;
  // The notice continues the receiving commander's own task. Copy that direct
  // recorded parent tuple now; neither the model nor later activity picks it.
  const senderTask=(await db.query<CommandRow>(
    'SELECT * FROM agent_commands WHERE id=$1 AND agent_id=$2',
    [route.incoming?.parent_command_id ?? route.parent?.id,route.recipient])).rows[0];
  const replyAddress=senderTask ? (await recordedMessageRoute(db,senderTask)).from : undefined;
  if (agent) await queueMessage(db,{
    id:reportId,roomId:route.returnRoom!,agentId:route.recipient!,sourceMessageId:null,reason:'system',
    parent:command ?? route.incoming,
    privatePayload:{kind:'message',authorId:agentId,text,fromRoomId:roomId,
      route:{from:{agent:agentId,place:roomId},to:{agent:route.recipient!,place:route.returnRoom!}},
      replyAddress,automatic:true,idleSince:options.idleSince,
      attachments:options.attachments ? [...options.attachments] : undefined},
  });
}

/** Approved revisions replace the opening route without changing its provenance. */
async function cornerReportOpening(db: SqlDatabase, roomId: string) {
  const corner = (await db.query<{ created_by: string; parent_id: string; opening: CommandRow | null;
    handover: { revision: number; author_id: string; source_room_id: string; approval_basis: {
      sourceMessageId: string; commanderReturnRoomId?: string; commanderCommandId?: string;
    } } | null }>(
    `SELECT room.created_by,room.parent_id,row_to_json(opening) opening,row_to_json(handover) handover FROM rooms room
     LEFT JOIN LATERAL (${cornerOpeningSql('room.id')}) opening ON true
     LEFT JOIN LATERAL (${cornerCommanderBriefSql('room.id')}) handover ON true
     WHERE room.id=$1 AND room.parent_id IS NOT NULL`, [roomId])).rows[0];
  if (corner?.handover) {
    const revision = corner.handover;
    corner.opening = { ...corner.opening, room_id: roomId, reason: 'corner_objective',
      parent_command_id: revision.approval_basis.commanderCommandId ?? null,
      root_source_message_id: revision.approval_basis.sourceMessageId,
      private_payload: { kind: 'order', text: '', authorId: revision.author_id,
        fromRoomId: revision.approval_basis.commanderReturnRoomId ?? revision.source_room_id },
    } as CommandRow;
  }
  return corner;
}

/** The recorded return route shared by lifecycle reports and commander approvals. */
export async function commanderReportAddress(db: SqlDatabase, roomId: string, command?: CommandRow, orderIssuer = false) {
  const task=command?.message?.route || command?.private_payload?.route ? command : (await db.query<CommandRow>(
    threadTaskSql('$1'),[roomId])).rows[0];
  if (task?.message?.route || task?.private_payload?.route) {
    const route=await recordedMessageRoute(db,task!);
    return {recipient:route.from.agent,returnRoom:route.from.place,parent:task,origin:roomId,incoming:task};
  }
  const reporter = command?.agent_id;
  const corner = await cornerReportOpening(db, roomId);
  const incoming = command ?? corner?.opening ?? undefined;
  const places = [
    incoming?.private_payload?.originCornerId,
    ...(incoming?.private_payload?.kind === 'report'
      ? [incoming.private_payload.fromRoomId, roomId]
      : [roomId, incoming?.private_payload?.fromRoomId]),
  ].filter((place): place is string => typeof place === 'string');
  const origin = (
    await db.query<{ id: string }>(
      `SELECT id FROM rooms WHERE id=ANY($1::uuid[]) AND parent_id IS NOT NULL
     ORDER BY array_position($1::uuid[],id) LIMIT 1`,
      [places],
    )
  ).rows[0]?.id;
  let humanOpening = corner && !corner.opening ? corner : undefined;
  let openingRoot: string | undefined;
  if (corner && !(orderIssuer && command?.private_payload?.kind === 'order')) {
    // Orders accepted before the handover keep their original issuer and return address. New
    // lifecycle reports and assignments use the approved commander instead.
    const beforeHandover = corner.handover && command?.private_payload?.kind === 'order' &&
      (await db.query(`SELECT 1 FROM corner_brief_revisions revision JOIN agent_commands assigned ON assigned.id=$2
        WHERE revision.corner_id=$1 AND revision.revision=$3 AND revision.created_at>assigned.created_at
          AND revision.revision>1 ORDER BY revision.revision DESC LIMIT 1`,
      [roomId, command.id, corner.handover.revision])).rowCount;
    command = beforeHandover ? await commandOrder(db, command!) : corner.opening ?? undefined;
    // The opener inspecting its own corner escalates through the order from
    // which it opened it. A nested worker still reports only one step up.
    if (command && reporter && command.private_payload?.authorId === reporter) {
      const opening = command;
      command = opening.parent_command_id
        ? (await db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1', [opening.parent_command_id])).rows[0]
        : undefined;
      const openedFrom = opening.private_payload!.fromRoomId ?? command?.room_id;
      const sourceCorner = openedFrom ? await cornerReportOpening(db, openedFrom) : undefined;
      if (sourceCorner && openedFrom !== roomId) {
        humanOpening = !sourceCorner.opening ? sourceCorner : undefined;
        command = sourceCorner.opening ?? undefined;
      } else {
        openingRoot = opening.root_source_message_id;
        if (command) command = await commandOrder(db, command);
      }
    }
  } else if (command) command = await commandOrder(db, command);
  let recipient: string | undefined;
  let returnRoom: string | undefined;
  let parent = command;
  if (command?.private_payload?.kind === 'order') {
    recipient = command.private_payload.authorId;
    returnRoom = command.private_payload.fromRoomId;
    if (command.parent_command_id)
      parent = (
        await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE id=$1`, [
          command.parent_command_id,
        ])
      ).rows[0];
    // Legacy opening orders can omit fromRoomId; their recorded parent still
    // names the opening surface. Never consult a later order for this route.
    returnRoom ??= command.parent_command_id ? parent?.room_id : undefined;
  } else if (command?.reason === 'schedule' && command.source_message_id) {
    // The occurrence retains its owner after a one-shot schedule is deleted.
    // A system scheduler authors the wake, but never commands the worker.
    const source = (await db.query<{ recipient: string | null; room_id: string }>(
      `SELECT COALESCE(NULLIF(source.card->>'ownerId',$2),root.author_id,
          CASE WHEN author.kind='human' AND NOT author.hidden_from_roster THEN source.author_id END,worker.owner_id) recipient,
          source.room_id
       FROM messages source JOIN identities author ON author.id=source.author_id
       LEFT JOIN agents worker ON worker.agent_id=$2
       LEFT JOIN messages root ON root.id=$3 AND root.system_event IS NULL AND root.deleted_at IS NULL
         AND EXISTS(SELECT 1 FROM identities person WHERE person.id=root.author_id
           AND person.kind='human' AND NOT person.hidden_from_roster)
         AND EXISTS(SELECT 1 FROM rooms root_room JOIN rooms execution
           ON execution.workspace_id=root_room.workspace_id WHERE root_room.id=root.room_id AND execution.id=$4)
       WHERE source.id=$1 AND source.card->'trigger'->>'scheduleId' IS NOT NULL`,
      [command.source_message_id, command.agent_id, command.root_source_message_id, roomId],
    )).rows[0];
    recipient = source?.recipient ?? undefined;
    returnRoom = source?.room_id;
  } else if (command?.source_message_id) {
    const source = (
      await db.query<{ author_id: string; room_id: string }>(
        // System wakes carry facts, not an order from the system identity.
        // Without a message source, retain the corner's recorded opening route.
        `SELECT author_id,room_id FROM messages WHERE id=$1 AND system_event IS NULL`,
        [command.source_message_id],
      )
    ).rows[0];
    recipient = source?.author_id;
    returnRoom = source?.room_id;
  }
  // Joined MCP calls retain the human order as their root message. That
  // opening root also survives a missing parent; a report wake may recover
  // its recorded root, but never selects a different recipient from chatter.
  if ((!recipient || !returnRoom) && (openingRoot || command?.private_payload?.kind === 'report')) {
    const source = (await db.query<{ author_id: string; room_id: string }>(
      `SELECT source.author_id,source.room_id FROM messages source
       JOIN identities author ON author.id=source.author_id AND author.kind='human'
       JOIN rooms source_room ON source_room.id=source.room_id
       JOIN rooms execution ON execution.id=$2 AND execution.workspace_id=source_room.workspace_id
       WHERE source.id=$1 AND source.presentation='message' AND source.system_event IS NULL
         AND source.deleted_at IS NULL`, [openingRoot ?? command?.root_source_message_id, roomId])).rows[0];
    recipient = source?.author_id;
    returnRoom = source?.room_id;
  }
  if ((!recipient || !returnRoom) && humanOpening) {
    recipient = humanOpening.created_by;
    returnRoom = humanOpening.parent_id;
  }
  // Follow only the recorded opening ancestry. Keep the original commander;
  // moving a report never grants a different recipient access to its payload.
  if (returnRoom) {
    const live = (await db.query<{ id: string }>(
      `WITH RECURSIVE ancestry AS (
         SELECT room.id,room.archived_at,0 hop,ARRAY[room.id] path FROM rooms room WHERE room.id=$1
         UNION ALL
         SELECT ancestor.id,ancestor.archived_at,child.hop+1,child.path||ancestor.id
         FROM ancestry child JOIN rooms room ON room.id=child.id
         JOIN rooms ancestor ON ancestor.id=COALESCE(${cornerOpenedFromSql('room.id')},room.parent_id)
         WHERE NOT ancestor.id=ANY(child.path)
       ) SELECT ancestry.id FROM ancestry
       WHERE ancestry.archived_at IS NULL
       ORDER BY hop LIMIT 1`, [returnRoom],
    )).rows[0];
    returnRoom = live?.id;
  }
  // Approved briefs can supply routing provenance without representing a
  // queue item. Only an actual item can parent the next queued report.
  const queueParent = parent?.id ? parent : incoming?.id ? incoming : undefined;
  return { recipient, returnRoom, parent: queueParent, origin, incoming };
}


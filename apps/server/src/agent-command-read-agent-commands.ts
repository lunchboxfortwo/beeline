import { connectorHostAcceptedSql } from './rooms-mcp-delivery.js';
import { legacyMessageBody } from './messaging-cutover.js';
import { publicMentionCommandSql } from './owed-mentions.js';
import type { AgentCommand,RoomInboxResult } from '@beeline/api-contract/daemon';
import { OPERATOR_OWNER_ID } from '@beeline/api-contract/daemon';
import { isResumeKind } from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';
import { CommandRow,checkFailureLogBody,createAgentCommand,reportedHeadBody } from './agent-command.js';
import { advanceCorner } from './corner-lifecycle.js';
import { cornerLifecycleSql } from './corner-github-cache.js';
import { currentIdleReportSql } from './corner-idle.js';
import type { SqlDatabase } from './database.js';
import { savedScheduleCommand } from './scheduled-command-authority.js';

type ReviewRollup = Pick<CornerLifecycleView, 'checks' | 'checksSummary'>;

export function queuedWakeBody(item: CommandRow & { review_rollup?: ReviewRollup | null }, body: string): string {
  const rollup = item.review_rollup;
  if (!rollup) return legacyMessageBody(item, body);
  const kind = item.message?.systemEvent?.kind;
  if (kind === 'check-passed' || kind === 'check-failed') {
    // Replace the check announcement while retaining the prior reviewer note.
    const newline = body.indexOf('\n');
    body = newline < 0 ? '' : body.slice(newline + 1);
  }
  const checks = rollup.checksSummary?.checks ?? [];
  return [body, `Checks: ${rollup.checksSummary?.status ?? rollup.checks}`,
    ...checks.map(check => `- ${check.name}: ${check.status}`)].filter(Boolean).join('\n');
}

/** One durable queue read, shared by helper push and connected-app delivery. */
export async function readAgentQueueRows(db:SqlDatabase,agentId:string,options: { roomId?: string; pairedWithMentions?: boolean } = {}) {
  // Idle notices describe one episode, unlike accepted human work. Retire an
  // obsolete episode through the terminal owner before delivering the queue.
  // An automatic review wake not yet started is obsolete once its head is no
  // longer the thread head or that head is approved.
  // Public tags and DMs with a mention record are delivered by message ID.
  // The queued command still owns the request and resolves its reply route.
  const wakeSource = options.pairedWithMentions ? `AND NOT (${publicMentionCommandSql('item')}
      AND EXISTS(SELECT 1 FROM rooms_mcp_mentions mention
        WHERE mention.member_id=item.agent_id AND mention.room_id=item.room_id
          AND mention.message_id=item.source_message_id))` : '';
  return db.query<CommandRow & { parent_room_id: string | null; room_name: string | null;
    return_room_name: string | null; offline_seconds: number | null; operator_agent:boolean;
    selected_model: string | null; selected_effort: string | null; fast_mode: boolean | null;
    review_rollup: ReviewRollup | null }>(
    `WITH queued AS MATERIALIZED (
       SELECT * FROM agent_commands WHERE agent_id=$1 AND ($2::text IS NULL OR room_id::text=$2) AND state='pending'
     ), obsolete AS MATERIALIZED (
       SELECT item.id,'complete' outcome,NULL reason,NULL result_id
       FROM queued item WHERE item.private_payload->>'authorId'='${SYSTEM_IDENTITY_ID}'
         AND item.private_payload->>'automatic'='true' AND item.private_payload->>'idleSince' IS NOT NULL
         AND NOT ${currentIdleReportSql('item')}
       UNION ALL
       SELECT item.id,'cancelled','stale_review_head',NULL FROM queued item
       WHERE ${staleReviewWakeSql('item')}
       UNION ALL
       SELECT item.id,'complete',NULL,report.id FROM queued item
       JOIN LATERAL (
         SELECT message.id FROM messages message
         WHERE item.reason='schedule' AND message.room_id=item.room_id AND message.author_id=item.agent_id
           AND message.deleted_at IS NULL
           AND (message.id=item.result_message_id OR
             (message.request_id=item.turn_request_id AND
               (message.card ? 'reportStatus' OR message.card->>'kind'='reply')))
         ORDER BY message.created_at DESC,message.id DESC LIMIT 1
       ) report ON true
     ), retired AS MATERIALIZED (
       SELECT obsolete.id FROM obsolete LEFT JOIN LATERAL
         beeline_finish_agent_command(obsolete.id,obsolete.outcome,obsolete.reason,obsolete.result_id) ended ON true
     ) SELECT item.*,room.parent_id parent_room_id,room.name room_name,return_room.name return_room_name,
       agent.owner_id='${OPERATOR_OWNER_ID}' operator_agent,
       agent.selected_model,agent.selected_effort,agent.fast_mode,
       CASE WHEN review.corner_id IS NOT NULL THEN jsonb_build_object(
         'checks',review.lifecycle->'checks','checksSummary',review.lifecycle->'checksSummary') END review_rollup,
       CASE WHEN item.created_at<=connection.connected_at THEN
         EXTRACT(EPOCH FROM connection.connected_at-connection.offline_since)::double precision END offline_seconds
     FROM queued item
     LEFT JOIN rooms room ON room.id=item.room_id
     LEFT JOIN rooms return_room ON return_room.id=COALESCE(item.return_room_id,item.room_id)
     LEFT JOIN agent_connections connection ON connection.agent_id=item.agent_id
     LEFT JOIN agents agent ON agent.agent_id=item.agent_id
     LEFT JOIN corner_github_cache review ON item.reason='corner_review_dispatch' AND review.corner_id=item.room_id
       AND review.lifecycle->'pr'->>'headSha'=item.review_context->>'headSha'
       AND review.lifecycle->'pr'->'number'=item.review_context->'pullRequest'
     WHERE NOT EXISTS(SELECT 1 FROM retired WHERE retired.id=item.id)
       AND NOT ${connectorHostAcceptedSql('item')}
       ${wakeSource}
     ORDER BY item.inbox_sequence,item.created_at,item.id`, [agentId, options.roomId ?? null]);
 }

/** A pending automatic review wake whose turn never started, for a head, PR or
 * brief revision that is no longer the thread's, or for a head with the reviewer's PASS. */
export function staleReviewWakeSql(item: string): string {
  const corner = `COALESCE((${item}.review_context->>'cornerId')::uuid,${item}.room_id)`;
  const pr = `${cornerLifecycleSql(corner)}->'pr'`;
  return `(${item}.reason IN ('corner_review_dispatch','subscribed_event')
    AND ${item}.review_context->>'headSha' IS NOT NULL AND ${item}.review_context->>'purpose' IS NULL
    AND NOT EXISTS(SELECT 1 FROM agent_turns started WHERE started.agent_id=${item}.agent_id
      AND started.request_id=${item}.turn_request_id)
    AND (${item}.review_context->>'headSha' IS DISTINCT FROM ${pr}->>'headSha'
      OR ${item}.review_context->'pullRequest' IS DISTINCT FROM ${pr}->'number'
      OR (${item}.review_context->>'briefRevision')::int IS DISTINCT FROM
        COALESCE((SELECT max(revision) FROM corner_brief_revisions WHERE corner_id=${corner}),0)
      OR EXISTS(SELECT 1 FROM corner_merge_approvals approval WHERE approval.corner_id=${corner}
        AND approval.head_sha=${item}.review_context->>'headSha'
        AND approval.pull_request_number=(${item}.review_context->>'pullRequest')::int)))`;
}

/** Every current pending item in one agent's queue, in append order.
 * Membership belongs to insertion and publication; accepted requests stay owed. */
export async function readAgentCommands(
  db: SqlDatabase,
  agentId: string,
  roomId?: string,
): Promise<{ commandProtocol: 2; commands: AgentCommand[] }> {
  const rows = await readAgentQueueRows(db,agentId,{roomId});
  // Loaded here: a static import closes a module cycle through the migrations.
  const { daemonCorners } = await import('./daemon/corner-reads.js');
  const threads = new Map(await Promise.all(
    [...new Set(rows.rows.map(item => item.parent_room_id ?? item.room_id))]
      .map(async placeId => [placeId, await daemonCorners({ database: db }, placeId, agentId, true)] as const),
  ));
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
      const scheduleId = item.wake_context?.scheduleId ?? source.systemEvent?.scheduleId;
      return {
        ...(item.offline_seconds != null ? { offlineSeconds: Math.max(0, item.offline_seconds) } : {}),
        ...(item.selected_model || item.selected_effort || item.fast_mode != null ? { modelSelection: {
          ...(item.selected_model ? { model: item.selected_model } : {}),
          ...(item.selected_effort ? { effort: item.selected_effort } : {}),
          ...(item.fast_mode != null ? { fastMode: item.fast_mode } : {}),
        } } : {}),
        threads: threads.get(item.parent_room_id ?? item.room_id),
        id: item.id, roomId: item.room_id, returnRoomId: item.return_room_id ?? item.room_id,
        ...(item.room_name ? { roomName: item.room_name } : {}),
        ...(item.return_room_name ? { returnRoomName: item.return_room_name } : {}),
        ...(item.parent_room_id ? {parentRoomId:item.parent_room_id} : {}),
        agentId: item.agent_id, createdAt, sourceMessageId: source.id,
        from: source.route?.from ?? item.private_payload?.route?.from ?? {agent:source.authorId,
          place:item.private_payload?.fromRoomId ?? item.room_id},
        ...(item.operator_agent ? {operatorAgent:true} : {}),
        turnRequestId: item.turn_request_id, action: item.action,
        reason: item.reason === 'report' && item.private_payload?.automatic ? 'attention_report' : item.reason,
        ...(item.private_payload?.messageAsk ? {ask:item.private_payload.messageAsk} : {}),
        rootCommandId: item.root_command_id, rootSourceMessageId: item.root_source_message_id,
        ...(item.parent_command_id ? {parentCommandId:item.parent_command_id} : {}),
        agentDepth: item.agent_depth, ...(source.type === 'private' ? {private:true} : {}),
        ...(scheduleId ? {scheduleId} : {}),
        source: { ...source, createdAt, body: queuedWakeBody(item, source.body) + (item.review_rollup ? '' : checkFailureLogBody(source.systemEvent ?? null)) + reportedHeadBody(source.systemEvent ?? null) },
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
    if (!parent && input.kind === 'subscription-fired') {
      const definition = (await db.query<{ requester_command_id: string | null }>(
        `SELECT subscription.requester_command_id FROM messages source
         JOIN agent_subscriptions subscription ON subscription.id::text=source.system_event->>'subscriptionId'
         WHERE source.id=$1 AND source.room_id=$2 AND subscription.room_id=$2
           AND subscription.agent_id=$3 AND subscription.paused_at IS NULL`,
        [input.sourceMessageId, input.roomId, agentId],
      )).rows[0];
      parent = await savedScheduleCommand(db, definition?.requester_command_id, input.roomId, agentId);
    }
    await createAgentCommand(db, {
      roomId: input.roomId,
      agentId,
      sourceMessageId: input.sourceMessageId,
      workflowAssignment: input.assignmentTargets?.includes(agentId),
      reason: resume ? 'resume' : input.kind === 'schedule-ran' ? 'schedule' : input.kind === 'computer-session-activity' ? 'computer_activity' : 'subscribed_event',
      ...(parent ? { parent, retainDepth: resume || input.kind === 'subscription-fired', resume,
        // A person's grant decision supplies its own sender and return place.
        ...(input.kind === 'grant-decided' || input.kind === 'subscription-fired' ? { inheritPrivatePayload: false } : {}) } : {}),
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

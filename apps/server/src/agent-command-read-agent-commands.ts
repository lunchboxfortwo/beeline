import { cornerObjectiveSql } from './corner-objective.js';
import { voiceDateContext } from './voice-reply.js';
import { subscriptionPromptBody } from './agent-subscriptions.js';
import { boundReplyExcerpt, REPLY_EXCERPT_MAX_LENGTH } from '@beeline/api-contract/daemon';
import type { AgentCommand, RoomInboxResult } from '@beeline/api-contract/daemon';
import { isResumeKind } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { advanceCorner } from './corner-lifecycle.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { CommandRow, checkFailureLogBody, reportedHeadBody } from './agent-command.js';
import { MergeCard, WorkflowWakeCard, mergeCardDetail, workflowWakeDetail, squireDecisionDetail } from './agent-command-route-agent-result.js';
import { createAgentCommand } from './agent-command.js';



/** Every pending item in one agent's queue, across the places where it is a
 * current member, oldest first. Reading never spends an item. */
export async function readAgentCommands(
  db: SqlDatabase,
  agentId: string,
  roomId?: string,
): Promise<{ commandProtocol: 2; commands: AgentCommand[] }> {
  const rows = await db.query<
    CommandRow & {
      text: string;
      delivered_context: string | null;
      voice_origin: boolean;
      receipt_hint: string | null;
      author_id: string;
      attachments: RoomInboxResult['items'][number]['attachments'];
      system_event: RoomInboxResult['items'][number]['systemEvent'];
      presentation: string;
      reply_to_message_id: string | null;
      reply_to_author_id: string | null;
      reply_to_author_name: string | null;
      reply_to_excerpt: string | null;
      merge_card: MergeCard | null;
      wake_card_type: string | null;
      wake_card: WorkflowWakeCard | null;
      workflow_state: string | null;
      workflow_outcomes: Record<string, string> | null;
      workflow_status: string | null;
      watched_corner_id: string;
      watched_corner_name: string;
      watched_merge_commit: string | null;
      parent_room_id: string | null;
      created_at: Date;
    }
  >(
    `WITH delivery AS (
     SELECT c.*,command_corner.parent_id parent_room_id,EXISTS(SELECT 1 FROM voice_orders voice WHERE voice.source_message_id=c.source_message_id AND voice.agent_id=c.agent_id) voice_origin,c.recovery_context delivered_context,CASE WHEN c.reason='corner_objective' THEN ${cornerObjectiveSql('command_corner')} WHEN c.reason='free_agent_checkin' THEN c.wake_context->>'checkinPrompt' ELSE m.text END text,CASE WHEN m.card_type='daemon-fact' AND m.card->>'type'='corner-complete' THEN m.card END merge_card,CASE WHEN workflow_latest.card IS NOT NULL THEN workflow_version.markdown::jsonb->'handoffs'->(workflow_latest.card->>'toState')->>'hint' WHEN m.room_id=c.room_id THEN COALESCE(m.card->>'receiptHint',choice_message.card->>'receiptHint') END receipt_hint,m.author_id,m.attachments,m.system_event,m.presentation,m.reply_to_message_id,reply_parent.author_id reply_to_author_id,reply_author.name reply_to_author_name,left(reply_parent.text,${REPLY_EXCERPT_MAX_LENGTH + 1}) reply_to_excerpt,CASE WHEN m.room_id=c.room_id AND m.card->>'runId' IS NOT NULL THEN m.card_type WHEN resume_source.room_id=c.room_id AND resume_source.card->>'runId' IS NOT NULL THEN resume_source.card_type WHEN m.room_id=c.room_id THEN m.card_type END wake_card_type,CASE WHEN m.room_id=c.room_id AND m.card->>'runId' IS NOT NULL THEN m.card WHEN resume_source.room_id=c.room_id AND resume_source.card->>'runId' IS NOT NULL THEN resume_source.card WHEN m.room_id=c.room_id THEN m.card END wake_card,workflow_latest.card->>'toState' workflow_state,NULLIF(workflow_start.card->>'runStatus','live') workflow_status,workflow_version.markdown::jsonb->'handoffs'->(workflow_latest.card->>'toState')->'on' workflow_outcomes,watched_corner.id watched_corner_id,watched_corner.name watched_corner_name,watched_fact.lifecycle->'pr'->>'mergeCommitSha' watched_merge_commit FROM agent_commands c LEFT JOIN messages m ON m.id=c.source_message_id LEFT JOIN rooms command_corner ON command_corner.id=c.room_id
 LEFT JOIN messages reply_parent ON reply_parent.id=m.reply_to_message_id
 LEFT JOIN identities reply_author ON reply_author.id=reply_parent.author_id
 LEFT JOIN rooms watched_corner ON watched_corner.id=m.room_id AND c.reason='watched_corner'
 LEFT JOIN corner_github_cache watched_fact ON watched_fact.corner_id=watched_corner.id
 LEFT JOIN agent_commands resume_parent ON resume_parent.id=c.parent_command_id
 LEFT JOIN messages resume_source ON resume_source.id=resume_parent.source_message_id
 LEFT JOIN room_choices choice ON choice.id::text=m.card->>'choiceId' AND choice.room_id=c.room_id
 LEFT JOIN messages choice_message ON choice_message.id=choice.message_id
 LEFT JOIN LATERAL (
   SELECT latest.card FROM messages latest
   WHERE latest.room_id=c.room_id AND latest.card_type='workflow-handoff'
     AND latest.card->>'runId'=COALESCE(m.card->>'runId',choice_message.card->>'runId',resume_source.card->>'runId')
   ORDER BY (latest.card->>'seq')::int DESC NULLS LAST,latest.created_at DESC,latest.id DESC LIMIT 1
 ) workflow_latest ON true
 LEFT JOIN messages workflow_start ON workflow_start.id=workflow_latest.card->>'runId' AND workflow_start.room_id=c.room_id
 LEFT JOIN rooms workflow_room ON workflow_room.id=c.room_id
 LEFT JOIN workspace_skills workflow_skill ON workflow_skill.workspace_id=workflow_room.workspace_id
   AND workflow_skill.slug=workflow_latest.card->>'workflowSlug' AND workflow_skill.kind='workflow'
 LEFT JOIN workspace_skill_versions workflow_version ON workflow_version.skill_id=workflow_skill.id
   AND workflow_version.version=(workflow_latest.card->>'workflowVersion')::int
 WHERE c.agent_id=$2 AND ($1::uuid IS NULL OR c.room_id=$1) AND c.state='pending'
   AND command_corner.archived_at IS NULL
   AND EXISTS(SELECT 1 FROM memberships member WHERE member.room_id=COALESCE(command_corner.parent_id,command_corner.id)
     AND member.identity_id=c.agent_id AND member.removed_at IS NULL)
     ) SELECT delivery.* FROM delivery
     ORDER BY delivery.created_at,delivery.id`,
    [roomId ?? null, agentId],
  );
  return {
    commandProtocol: 2,
    commands: rows.rows.filter(r => r.id).map((r) => ({
      id: r.id,
      roomId: r.room_id,
      returnRoomId: r.return_room_id ?? r.room_id,
      ...(r.parent_room_id ? { parentRoomId: r.parent_room_id } : {}),
      createdAt: Math.floor(r.created_at.getTime() / 1000),
      agentId: r.agent_id,
      sourceMessageId: r.private_payload ? r.id : r.source_message_id ?? r.id,
      turnRequestId: r.turn_request_id,
      action: r.action,
      reason: r.reason,
      ...(r.private_payload ? { private: true } : {}),
      ...(r.system_event?.scheduleId ? { scheduleId: r.system_event.scheduleId } : {}),
      rootCommandId: r.root_command_id,
      ...(r.parent_command_id ? { parentCommandId: r.parent_command_id } : {}),
      rootSourceMessageId: r.root_source_message_id,
      agentDepth: r.agent_depth,
      source: {
        id: r.private_payload ? r.id : r.source_message_id ?? r.id,
        authorId: r.private_payload?.authorId ?? (r.reason === 'free_agent_checkin' ? SYSTEM_IDENTITY_ID : r.author_id),
        body: (r.delivered_context ? `${r.delivered_context}\n` : '') + (r.private_payload?.text ?? (r.reason === 'watched_corner' ? `Watched corner ${r.watched_corner_name} (${r.watched_corner_id}): ${r.system_event?.kind}${r.system_event?.kind === 'merged' && r.watched_merge_commit ? ` · merge commit ${r.watched_merge_commit}` : ''}\n` : '') + subscriptionPromptBody(r.text, r.system_event ?? null)) + (r.voice_origin ? '\n' + voiceDateContext(Date.now()) + ' Never start your reply with your name.\nThis input came from a live voice call. Answer the latest message and fold in earlier relevant speech from the current conversation in one response; do not answer each chunk separately. Start your report with a spoken answer sized to the question: one line for a status, a few sentences for a real answer, at most about 150 words. Then a blank line, then the full report.' : '') + checkFailureLogBody(r.system_event ?? null) + reportedHeadBody(r.system_event ?? null) + mergeCardDetail(r.merge_card) + workflowWakeDetail(r.wake_card_type, r.wake_card, r.workflow_state, r.workflow_outcomes, r.workflow_status) + squireDecisionDetail(r.wake_card_type, r.wake_card) + (r.receipt_hint ? `\nReceipt hint for this state: ${r.receipt_hint}. Attach an optional receipt when you call handoff.` : ''),
        attachments: r.private_payload?.attachments ?? r.attachments ?? [],
        createdAt: Math.floor(r.created_at.getTime() / 1000),
        type: r.private_payload ? 'private' : r.reason === 'free_agent_checkin' ? 'system' : r.presentation,
        systemEvent: r.system_event,
        ...(r.reply_to_message_id ? { replyToMessageId: r.reply_to_message_id } : {}),
        ...(r.reply_to_author_id ? { replyToAuthorId: r.reply_to_author_id } : {}),
        ...(r.reply_to_author_name ? { replyToAuthorName: r.reply_to_author_name } : {}),
        ...(r.reply_to_excerpt !== null ? { replyToExcerpt: boundReplyExcerpt(r.reply_to_excerpt) } : {}),
      },
    })),
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
  if (input.kind === 'computer-session-activity') {
    // Serialize producers per share. A claimed update stays immutable; all
    // further actions accumulate in a single pending update for that share.
    const activity = (await db.query<{ session_id: string; text: string }>(
      `SELECT session.id session_id,message.text FROM messages message
       JOIN computer_sessions session ON session.id=message.system_event->'payload'->>'sessionId'
       WHERE message.id=$1 AND session.room_id=$2 AND session.status='live'
       FOR UPDATE OF session`, [input.sourceMessageId, input.roomId],
    )).rows[0];
    if (!activity) return;
    for (const agentId of new Set(input.targets)) {
      const pending = (await db.query<CommandRow>(
        `SELECT command.* FROM agent_commands command
         JOIN messages source ON source.id=command.source_message_id
         WHERE command.room_id=$1 AND command.agent_id=$2 AND command.state='pending'
           AND command.reason='computer_activity'
           AND source.system_event->'payload'->>'sessionId'=$3
         FOR UPDATE OF command`, [input.roomId, agentId, activity.session_id],
      )).rows[0];
      if (pending) {
        await db.query(
          `UPDATE agent_commands SET source_message_id=$2,
             recovery_context=right(COALESCE(recovery_context || E'\\n','') || $3,16000)
           WHERE id=$1 AND state='pending'`, [pending.id, input.sourceMessageId, activity.text],
        );
      } else {
        const command = await createAgentCommand(db, {
          roomId: input.roomId, agentId, sourceMessageId: input.sourceMessageId, reason: 'computer_activity',
        });
        if (command) await db.query(`UPDATE agent_commands SET recovery_context=$2 WHERE id=$1`,
          [command.id, activity.text]);
      }
    }
    return;
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
      reason: resume ? 'resume' : input.kind === 'schedule-ran' ? 'schedule' : 'subscribed_event',
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

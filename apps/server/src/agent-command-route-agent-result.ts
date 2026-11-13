import { lockAgentCommandQueue } from './agent-command-queue.js';
import { endAgentTurn } from './agent-turn-end.js';
import { ExpectedRefusalError } from './command-refusal.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { recordMcpMention, recordMcpMemberWebhook } from './rooms-mcp-members.js';
import { commandOrder, reportToCommander } from './commander.js';
import { workflowOutputBindingCtes } from './workflow-step-output.js';
import { createHash } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { resolveCurrentMemberMentions, typedMentionHandles, isChannelMentionToken } from './message-mentions.js';
import { CORNER_LIFECYCLE_CARD_TYPE } from './room-choice.js';
import { CommandRow, nextAgentDepth } from './agent-command.js';
import { createAgentCommand } from './agent-command.js';



export async function routeAgentResult(
  db: SqlDatabase,
  parent: CommandRow | undefined,
  sourceId: string,
  speaker?: { roomId: string; agentId: string; initialAgentDepth?: 1 },
) {
  const addressedRoomId = speaker?.roomId ?? parent?.room_id;
  const agentId = speaker?.agentId ?? parent?.agent_id;
  const woken: string[] = [];
  const notWoken: { handle: string; reason: string }[] = [];
  if (!addressedRoomId || !agentId) return { woken, notWoken };
  const source = (await db.query<{ text: string; room_id: string }>(
    `SELECT text,room_id FROM messages WHERE id=$1 AND room_id=$2 AND author_id=$3
       AND presentation='message' AND deleted_at IS NULL`,
    [sourceId, addressedRoomId, agentId],
  )).rows[0];
  if (!source) return { woken, notWoken };
  const roomId = source.room_id;
  const mentions = await resolveCurrentMemberMentions(db, roomId, source.text, parent && parent.room_id !== roomId ? undefined : agentId);
  for (const handle of typedMentionHandles(source.text)) {
    if (isChannelMentionToken(handle)) continue;
    if (!mentions.some(mention => mention.handle === handle))
      notWoken.push({ handle, reason: 'not another current member or not an unambiguous handle' });
  }
  for (const mention of mentions) {
    if (mention.kind !== 'agent') {
      notWoken.push({ handle: mention.handle, reason: 'person tagged; no agent turn' });
      continue;
    }
    if (mention.mcpMember) {
      // An external member's tag is delivery, not another helper command.
      // Preserve it and its webhook even when the helper chain is exhausted.
      await recordMcpMention(db, mention.id, roomId, sourceId);
      if (mention.mcpCallbackUrl) {
        await recordMcpMemberWebhook(db, mention.id, mention.mcpCallbackUrl, roomId, sourceId, source.text);
        woken.push(mention.handle);
      } else {
        const delivery = (await db.query<{ live: boolean; recent_poll: boolean }>(`SELECT
          connection.last_used_at>now()-interval '2 minutes' AS recent_poll,
          EXISTS(SELECT 1 FROM rooms_mcp_event_subscriptions subscription
            JOIN rooms_mcp_event_deliveries delivery ON delivery.subscription_id=subscription.id AND delivery.message_id=$2
            WHERE subscription.member_id=member.member_id AND (subscription.expires_at IS NULL OR subscription.expires_at>now())) AS live
          FROM rooms_mcp_members member
          JOIN rooms_mcp_connections connection ON connection.client_id=member.client_id
            AND connection.identity_id=member.owner_id AND connection.revoked_at IS NULL
          WHERE member.member_id=$1`,
        [mention.id, sourceId])).rows;
        if (delivery.some(connection => connection.live)) woken.push(mention.handle);
        else notWoken.push({ handle: mention.handle, reason: delivery.some(connection => connection.recent_poll)
          ? 'delivered; its poller picks it up' : 'no live wake route; sees it on next list_mentions' });
      }
      continue;
    }
    // Tags are conversation, never a delegation or an implementer change.
    const dispatch = (db: SqlDatabase) => createAgentCommand(db, {
      roomId,
      agentId: mention.id,
      sourceMessageId: sourceId,
      parent,
      reason: 'agent_tag',
      inheritPrivatePayload: false,
    });
    // An external member contributes the first hop without owning a command.
    // Commit that depth with the helper wake so a claim cannot see depth zero.
    const dispatched = speaker?.initialAgentDepth && !parent
      ? await db.transaction(async (tx) => {
        const command = await dispatch(tx);
        if (command) await tx.query('UPDATE agent_commands SET agent_depth=$2 WHERE id=$1',
          [command.id, speaker.initialAgentDepth]);
        return command;
      })
      : await dispatch(db);
    if (dispatched?.state === 'pending') woken.push(mention.handle);
    else notWoken.push({ handle: mention.handle, reason: dispatched?.state === 'complete'
      ? 'own output does not start another turn' : parent && nextAgentDepth(parent.agent_depth) === undefined
      ? 'agent tag chain depth limit reached' : 'agent or place is no longer available' });
  }
  return { woken, notWoken };
}


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


export type WakeDropLog = { drops: Record<string, unknown>[] };


export function logStaleWakeDrops(drops: WakeDropLog['drops'] | undefined): void {
  for (const drop of drops ?? []) console.info(JSON.stringify(drop));
}


/** A connected app answers its orders through the queue: the order it names,
 * or its oldest pending order (this Room first). */
export async function selectMcpOrder(db: SqlDatabase, agentId: string, target: string,
  commandId?: string): Promise<CommandRow | undefined> {
  const waiting = (await db.query<CommandRow>(
    `SELECT command.* FROM agent_commands command
     JOIN rooms room ON room.id=command.room_id AND room.archived_at IS NULL
     JOIN room_access member ON member.room_id=room.id AND member.identity_id=$1 AND member.removed_at IS NULL
     WHERE command.agent_id=$1 AND command.action='input' AND command.state='pending'
       AND command.private_payload->>'kind'='order'
       AND ($3::text IS NULL OR (command.id=$3 AND command.room_id=$2))
     ORDER BY (command.room_id=$2) DESC,command.created_at,command.id`,
    [agentId, target, commandId ?? null])).rows;
  if (!commandId && !waiting.some(row => row.room_id === target) && waiting.length > 1)
    throw new ExpectedRefusalError(`ambiguous report; pass commandId from the order: ${waiting.map(row => `${row.id} at ${row.room_id}`).join(', ')}`);
  return waiting[0];
}


/** Inbox dismissal answers queued non-orders silently; orders still require a report. */
export async function dismissAgentCommandWakes(db: SqlDatabase, roomId: string, agentId: string,
  commandId?: string): Promise<number> {
  return db.transaction(async db => {
    await lockAgentCommandQueue(db, roomId, agentId);
    const waiting = (await db.query<CommandRow>(`SELECT command.* FROM agent_commands command
      JOIN rooms room ON room.id=command.room_id AND room.archived_at IS NULL
      JOIN room_access member ON member.room_id=room.id AND member.identity_id=command.agent_id AND member.removed_at IS NULL
      WHERE command.room_id=$1 AND command.agent_id=$2 AND command.action='input' AND command.reason<>'mcp_call'
        AND ($3::text IS NULL OR command.id=$3)
        AND ($3::text IS NOT NULL OR COALESCE(command.private_payload->>'kind','')<>'order')
        AND command.state='pending'
      ORDER BY command.created_at,command.id FOR UPDATE OF command`, [roomId,agentId,commandId ?? null])).rows;
    if (waiting.some(command => command.private_payload?.kind === 'order'))
      throw new ExpectedRefusalError('that wake is an order; answer it with report');
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
  if (!row) throw new Error('command output authority rejected: no command row');
  if (row.state === 'cancelled') throw new Error('command turn cancelled');
  return row;
}


export type MergeCard = {
  cornerId?: string;
  name?: string;
  pullRequest?: { number?: number; url?: string; mergeCommitSha?: string };
};


/**
 * A parent-Room merge card's sentence names only the pull request title, so an
 * agent woken by a `merged` subscription reads which corner and pull request
 * landed from the card itself.
 */
export function mergeCardDetail(card: MergeCard | null): string {
  if (!card) return '';
  const corner = card.cornerId
    ? `corner ${card.name ? `${card.name} (${card.cornerId})` : card.cornerId}`
    : '';
  const pr = card.pullRequest;
  const pullRequest =
    pr?.number || pr?.url
      ? ['pull request', pr.number ? `#${pr.number}` : '', pr.url ?? ''].filter(Boolean).join(' ')
      : '';
  const commit = pr?.mergeCommitSha ? `merge commit ${pr.mergeCommitSha}` : '';
  const detail = [corner, pullRequest, commit].filter(Boolean).join(' · ');
  return detail ? `\n${detail}` : '';
}


export type WorkflowWakeCard = {
  runId?: string;
  workflowSlug?: string;
  note?: string;
  seq?: number;
  /** A gate answer's transition card carries the person's note in its contents. */
  contents?: { note?: unknown };
};


/**
 * A Squire decision wake names the exact approval, tool and status, so the
 * woken agent calls that tool's resume step instead of asking again.
 */
export function squireDecisionDetail(cardType: string | null, card: WorkflowWakeCard | null): string {
  if (cardType !== 'squire-approval-decision' || !card) return '';
  const { approvalId, tool, status } = card as { approvalId?: unknown; tool?: unknown; status?: unknown };
  if (typeof approvalId !== 'string' || typeof tool !== 'string' || typeof status !== 'string') return '';
  const next = status === 'approved'
    ? `Call ${tool} with action "resume" and approval_id "${approvalId}" now, then continue the work that needed it.`
    : 'Do not call its resume step.';
  return `\nSquire approval ${approvalId} for ${tool}: ${status}. ${next}`;
}


/**
 * A wake from a saved workflow run (a `workflow-handoff` card, or a gate's
 * choice/poll card once answered — see `postWorkflowGate`) states the run id
 * and workflow name plainly, so a woken agent treats its own wake as proof a
 * run already exists rather than reaching for `start_workflow` again. The
 * corner's lifecycle bookkeeping (`corner-workflow-handoff`) is excluded:
 * every corner turn would otherwise carry this line for no reason, since a
 * corner is never started through `start_workflow`. A gate answer's optional
 * note is quoted ahead of it.
 */
export function workflowWakeDetail(
  cardType: string | null,
  card: WorkflowWakeCard | null,
  state: string | null,
  outcomes: Record<string, string> | null,
  status: string | null,
): string {
  if (!card?.runId || !card.workflowSlug || cardType === CORNER_LIFECYCLE_CARD_TYPE) return '';
  const answerNote = card.note ?? (typeof card.contents?.note === 'string' ? card.contents.note : undefined);
  const note = answerNote ? `\nTheir note with the answer: ${JSON.stringify(answerNote)}` : '';
  const allowed = status ? 'none' : Object.entries(outcomes ?? {})
    .map(([outcome, target]) => `${outcome} -> ${target}`).join(', ') || 'none';
  // A dispatch card's seq is the attempt this wake is for; a later card makes it stale.
  const attempt = cardType === 'workflow-handoff' && !status
    ? `\nThis wake is attempt ${card.seq}: pass "attempt": ${card.seq} to app_tool’s beeline:workflow advance action. Discover its schema with app_tool(app="beeline:workflow") before acting. If you cannot do this step, hand off outcome "blocked" with contents {"reason": "..."} and it moves to the next agent on the role.`
    : '';
  return `${note}\nYou are in run ${card.runId} of ${card.workflowSlug}. Continue this run; do not start a new one.` +
    (state ? `\nCurrent state: ${state}${status ? ` (${status})` : ''}. Allowed outcomes: ${allowed}. Read the pinned contract and requirements with app_tool(app="beeline:workflow", tool="read", args={runId}).` : '') +
    attempt;
}

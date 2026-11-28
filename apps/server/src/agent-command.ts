import { wakeBlockAnswer } from './implementer-blocks.js';
import { finalizeAgentInvocation } from './agent-invocation.js';
import { legacyCommandPayload } from './messaging-cutover.js';
import { parseAgentAccessPolicy,senderMayAddressAgent } from '@beeline/api-contract/agent-access';
import { attachQueuedContext } from './agent-command-context.js';
import { initializeThreadImplementer } from './corner-lifecycle.js';
import { sendMessage } from './agent-messaging.js';
import { deliveredMessageRoute, recordedMessageRoute, replyableWake } from './message-route.js';
import { ensureSystemIdentity } from './system-line.js';
import type { AgentCommand,AgentCommandAction,RoomInboxResult,MessageRoute,MessageAsk } from '@beeline/api-contract/daemon';
import { boundReplyExcerpt,isInformationalReply,isBackgroundCommand,wall } from '@beeline/api-contract/daemon';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { createHash,randomBytes } from 'node:crypto';
import { parseTaggedAgentLifecycleCommand,routeTaggedLifecycleCommand } from './agent-command-create-agent-command.js';
import { queuedWorkflowWakeDetail,squireDecisionDetail,type WorkflowWakeCard } from './agent-input-context.js';
import { repairAgentPost } from './agent-post-text.js';
import { subscriptionPromptBody } from './agent-subscriptions.js';
import { endAgentTurn, PERSON_STOP_REASON } from './agent-turn-end.js';
import { holdFinalAfterReply,recordAnswerActivity } from './answer-activity.js';
import { CornerAccessDatabase } from './corner-access-database.js';
import { cornerLifecycleSql } from './corner-github-cache.js';
import { currentIdleReportSql } from './corner-idle.js';
import { greenReviewRequestSql,reviewChecksSql } from './corner-lifecycle-values.js';
import { cornerOpeningSql } from './corner-opening.js';
import { cornerReviewerSql } from './corner-reviewer.js';
import { cornerImplementerSql } from './corner-worker.js';
import type { SqlDatabase } from './database.js';
import { recordStarPromptReply } from './github-star-prompt.js';
import { observeQueuedAnswer } from './signin-funnel.js';
import { hasSystemReportMention,isChannelMentionToken,typedMentionHandles } from './message-mentions.js';
import { mcpCommandWakeSql } from './rooms-mcp-events.js';
import { recordMcpMemberWebhook,queuedMentionKind,recordQueuedMention,noteOfflineConnectors } from './rooms-mcp-members.js';
import { cleanVoiceReply } from './voice-reply.js';
import { assertMemberTranscript,modelText,systemText,type AgentVoice,type Composed,type MemberText,type SystemAuthorId } from './message-origin.js';
import { peerReplyWakeInput,type PeerReplyWakeOutput } from './peer-reply-wake.js';
type Attachment = NonNullable<PrivateCommandPayload['attachments']>[number];
/** Sanitizing keeps the text's declared origin. */
const pgText=<Text extends string>(value:Text)=>value.replace(/[\u0000\uD800-\uDFFF]/gu,'\uFFFD') as Text;
const json=(value:unknown)=>JSON.stringify(value,(_key,part)=>typeof part==='string'?pgText(part):part);
/**
 * One queue per agent: source + explicit targets -> eligibility -> pending item
 * (same transaction) -> complete once its answer is posted to return_room_id,
 * or cancelled by Stop. A helper that drops leaves the item pending and gets
 * it again on its next registration. Transcript visibility never grants
 * execution authority.
 */
export const AGENT_COMMAND_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_commands (
 id text PRIMARY KEY,
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 agent_id text NOT NULL REFERENCES identities(id),
 source_message_id text NOT NULL REFERENCES messages(id),
 turn_request_id text NOT NULL,
 action text NOT NULL CHECK(action IN ('input','resume','stop','restart')),
 reason text NOT NULL,
 root_command_id text NOT NULL,
 parent_command_id text,
 root_source_message_id text NOT NULL,
 agent_depth integer NOT NULL CHECK(agent_depth >= 0),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','complete','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
  result_message_id text
);
ALTER TABLE agent_commands DROP CONSTRAINT IF EXISTS agent_commands_room_id_source_message_id_agent_id_action_key;
ALTER TABLE agent_commands ALTER COLUMN source_message_id DROP NOT NULL;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS private_payload jsonb;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS posted_reply_id text;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS reply_tool_message_id text;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS message jsonb;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS report_address jsonb;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS answer_attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
-- Retired: a production-only column that held only its '[]' default (2026-11-02).
ALTER TABLE corner_watches ADD COLUMN IF NOT EXISTS incoming_command_id text REFERENCES agent_commands(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS corner_watches_incoming_command_idx ON corner_watches(incoming_command_id);
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS avatar_job boolean NOT NULL DEFAULT false;
DROP INDEX IF EXISTS agent_commands_one_avatar_job;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS hiccup_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS lifecycle_before text;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS review_context jsonb;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS wake_context jsonb;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS report_outcome text;
-- A private answer can be another agent's durable queue item rather than a
-- transcript message. Retain its receipt id through the same terminal write.
ALTER TABLE agent_commands DROP CONSTRAINT IF EXISTS agent_commands_result_message_id_fkey;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS restart_confirmed_at timestamptz;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS cancellation_reason text;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS recovery_context text;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS wake_after timestamptz;
-- Inert for the prior server during this rolling release; drop next release.
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS startup_wake_after timestamptz;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS coalesced_context text;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS coalesced_attachments jsonb;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS inbox_sequence bigint GENERATED BY DEFAULT AS IDENTITY;
CREATE INDEX IF NOT EXISTS agent_commands_delayed_wakes ON agent_commands(wake_after) WHERE state='pending' AND wake_after IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_commands_coalesced_into ON agent_commands(cancellation_reason) WHERE cancellation_reason IS NOT NULL;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS created_offline boolean;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS startup_operation_id text;
ALTER TABLE agent_commands DROP CONSTRAINT IF EXISTS agent_commands_action_check;
ALTER TABLE agent_commands ADD CONSTRAINT agent_commands_action_check CHECK(action IN ('input','resume','stop','restart'));
CREATE INDEX IF NOT EXISTS agent_commands_parent_order ON agent_commands(parent_command_id)
 WHERE reason='order' AND parent_command_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_commands_pending_delivery ON agent_commands(agent_id,inbox_sequence,created_at,id)
 WHERE state='pending';
CREATE INDEX IF NOT EXISTS agent_commands_delivery ON agent_commands(agent_id,room_id,state,created_at);
CREATE INDEX IF NOT EXISTS agent_commands_turn ON agent_commands(room_id,agent_id,turn_request_id);
CREATE INDEX IF NOT EXISTS agent_commands_corner_opening ON agent_commands(room_id) WHERE reason='corner_objective';
-- source_message_id/result_message_id reference messages(id) with no index,
-- so deleting a message (e.g. a room or workspace cascade) made Postgres
-- sequentially scan all of agent_commands for the FK check, once per deleted
-- message -- the cause of a workspace delete hanging past the app pool's
-- statement_timeout.
CREATE INDEX IF NOT EXISTS agent_commands_source_message_idx ON agent_commands(source_message_id);
CREATE INDEX IF NOT EXISTS agent_commands_result_message_idx ON agent_commands(result_message_id)
  WHERE result_message_id IS NOT NULL;
ALTER TABLE agent_grants ADD COLUMN IF NOT EXISTS command_id text;
ALTER TABLE agent_pending_attachments ADD COLUMN IF NOT EXISTS request_id text;
-- Retire synthetic working turns. Pending commands are projected directly.
DROP TRIGGER IF EXISTS show_dispatched_agent_work ON agent_commands;
DROP FUNCTION IF EXISTS show_dispatched_agent_work();
-- Where the answer goes, fixed when the item is queued.
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS return_room_id uuid;
ALTER TABLE agent_commands DROP CONSTRAINT IF EXISTS agent_commands_agent_depth_check;
ALTER TABLE agent_commands ADD CONSTRAINT agent_commands_agent_depth_check CHECK(agent_depth >= 0);
-- The queue has no claim, lease or generation. Unfinished work goes back to
-- pending; resume and stop controls are no longer queued.
DROP TRIGGER IF EXISTS beeline_classify_claim_kind ON agent_commands;
DROP TRIGGER IF EXISTS beeline_bind_command_generation ON agent_commands;
DROP TRIGGER IF EXISTS beeline_fence_ended_command_claim ON agent_commands;
DROP TRIGGER IF EXISTS beeline_fence_unknown_model_generation ON agent_commands;
-- Helper activation snapshots were read only by claims.
DO $$ DECLARE source text; BEGIN
 FOREACH source IN ARRAY ARRAY['workspaces','agents','identities','memberships','rooms','agent_grants','workspace_apps',
   'workspace_connectors','corner_facts','corner_brief_revisions','corner_merge_holds','corner_merge_approvals','free_agents'] LOOP
   EXECUTE format('DROP TRIGGER IF EXISTS beeline_activation_source ON %I',source);
 END LOOP;
END $$;
ALTER TABLE agent_commands DROP CONSTRAINT IF EXISTS agent_commands_turn_owner_pair;
ALTER TABLE agent_commands DROP CONSTRAINT IF EXISTS agent_commands_execution_kind;
-- Retained storage is inert in this queue implementation. Removal belongs to
-- a later contract release after the preceding serving/rollback images drain.
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS generation_id text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS execution_kind text,
  ADD COLUMN IF NOT EXISTS turn_owner_connection_id text,
  ADD COLUMN IF NOT EXISTS turn_owner_epoch bigint;
ALTER TABLE agent_pending_attachments ADD COLUMN IF NOT EXISTS generation_id text;
-- Delegation checks its issuing agent at commit without locking a second
-- recipient membership while another agent owns that queue's fence.
CREATE OR REPLACE FUNCTION beeline_commit_delegated_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.private_payload->>'kind' IS DISTINCT FROM 'order' OR NEW.parent_command_id IS NULL THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM agent_commands current_order WHERE current_order.id=NEW.id AND current_order.state='pending')
    AND EXISTS(SELECT 1 FROM agent_commands source WHERE source.id=NEW.parent_command_id
      AND source.agent_id=NEW.private_payload->>'authorId')
    AND NOT EXISTS(SELECT 1 FROM rooms room JOIN memberships member
      ON member.room_id=COALESCE(room.parent_id,room.id)
        AND member.identity_id=NEW.private_payload->>'authorId' AND member.removed_at IS NULL
      WHERE room.id=NEW.room_id) THEN
    RAISE EXCEPTION 'access denied: delegated order source membership changed before commit' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END; $$;
DROP TRIGGER IF EXISTS beeline_commit_delegated_order ON agent_commands;
CREATE CONSTRAINT TRIGGER beeline_commit_delegated_order AFTER INSERT ON agent_commands
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION beeline_commit_delegated_order();
UPDATE agent_commands SET state='pending' WHERE state='claimed';
-- Keep an existing request identity stable across a serving-image overlap.
-- A connected helper can still be acting on that request during migration.
-- New items already use their command id; source ids remain provenance.
-- A legacy resume can share its source and request with its parent. Preserve
-- its message before removing that uniqueness collision; each item then owns
-- a separate request id and can receive its own answer after the upgrade.
UPDATE agent_commands command SET private_payload=COALESCE(command.private_payload,
    jsonb_build_object('kind','lifecycle','text',source.text,'authorId',source.author_id,
      'fromRoomId',source.room_id::text,'attachments',source.attachments)),source_message_id=NULL
  FROM messages source WHERE command.state='pending' AND command.action='resume'
    AND source.id=command.source_message_id AND EXISTS(SELECT 1 FROM agent_commands other
      WHERE other.room_id=command.room_id AND other.source_message_id=command.source_message_id
        AND other.agent_id=command.agent_id AND other.action='input');
UPDATE agent_commands SET action='input',turn_request_id=id WHERE state='pending' AND action='resume';
-- Older private wakes predate an explicit return address. Their recorded
-- human root preserves the original chat across nested corner handoffs.
UPDATE agent_commands command SET return_room_id=source.room_id
  FROM messages source JOIN identities author ON author.id=source.author_id AND author.kind='human'
  WHERE command.state='pending' AND command.private_payload->>'kind' IN ('report','lifecycle')
    AND source.id=command.root_source_message_id AND source.system_event IS NULL
    AND command.return_room_id IS NULL;
UPDATE agent_commands SET return_room_id=CASE WHEN private_payload->>'kind'='order'
    AND private_payload->>'fromRoomId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN (private_payload->>'fromRoomId')::uuid ELSE room_id END
  WHERE state='pending' AND return_room_id IS NULL;
UPDATE agent_commands item SET message=(SELECT jsonb_build_object(
  'id',COALESCE(item.source_message_id,item.id),'authorId',COALESCE(item.private_payload->>'authorId',source.author_id),
  'body',COALESCE(item.private_payload->>'text',source.text,item.reason),
  'attachments',COALESCE(item.private_payload->'attachments',source.attachments,'[]'::jsonb),
  'type',CASE WHEN item.private_payload IS NOT NULL THEN 'private' ELSE COALESCE(source.presentation,'system') END,
  'systemEvent',source.system_event,'createdAt',EXTRACT(EPOCH FROM item.created_at))
  FROM (SELECT 1) anchor LEFT JOIN messages source ON source.id=item.source_message_id)
WHERE item.message IS NULL;
UPDATE agent_commands command SET answer_attachments=attachments.body
FROM (SELECT room_id,agent_id,request_id,jsonb_agg(jsonb_build_object(
  'url',url,'name',name,'mimeType',mime_type,'size',size) ORDER BY created_at,id) body
  FROM agent_pending_attachments GROUP BY room_id,agent_id,request_id) attachments
WHERE command.room_id=attachments.room_id AND command.agent_id=attachments.agent_id
  AND command.turn_request_id=attachments.request_id AND command.state='pending' AND command.answer_attachments='[]'::jsonb;
`;
/** Transport data only: orders and reports never become transcript messages. */
/** A private payload's text names its origin: an agent's (or person's) own
 * words, or System text under the System identity. */
type PayloadVoice = { text: MemberText; authorId: string } | { text: Composed<'system'>; authorId: SystemAuthorId };
export type PrivateCommandPayload = PayloadVoice & {
  /** Explicit message protocol: immutable sender and destination, without ancestry routing. */
  route?: MessageRoute;
  messageAsk?: MessageAsk;
  inReplyTo?: string;
  /** Explicit return address for workflow owners and legacy message delivery. */
  replyAddress?: MessageRoute['from'];
  /** Stable tool-call key on the corner's opening order. */
  openKey?: string;
  /** Backlog task IDs promoted by this thread opening, for idempotent retry matching. */
  workItems?: readonly string[];
  ask?: string;
  objective?: string;
  automatic?: boolean;
  /** Status supplied by the explicit report operation; ordinary answers have none. */
  reportStatus?: 'blocked' | 'needs-decision' | 'done' | 'failed';
  idleSince?: string; selfWake?: boolean; // selfWake: a self-message turn in its own thread; it cannot queue another.
  /** Agent whose work a server-authored report describes; prevents self-wakes. */
  sourceAgentId?: string;
  fromRoomId: string;
  /** Recipient captured with the return chat; later handovers cannot move this answer. */
  returnIdentityId?: string;
  /** Frozen corner escalation route, distinct from an explicit order issuer. */
  escalation?: { identityId: string; roomId: string };
  kind: 'order' | 'report' | 'lifecycle' | 'message' | 'reply';
  attachments?: RoomInboxResult['items'][number]['attachments'];
  /** This item already delivered an explicit report. */
  reported?: boolean;
  reportedOutcome?: string;
  /** Origin of a forwarded report, for the existing human attention index. */
  originCornerId?: string;
  /** The explicit public post this command's current generation made. */
  publicPostId?: string;
};
export type CommandRow = {
  created_at: Date;
  id: string;
  room_id: string;
  agent_id: string;
  source_message_id: string | null;
  private_payload: PrivateCommandPayload | null;
  posted_reply_id?: string | null;
  reply_tool_message_id?: string | null;
  message?: AgentCommand['source'] | null;
  report_address?: { roomId: string; identityId: string } | null;
  answer_attachments?: PrivateCommandPayload['attachments'];
  turn_request_id: string;
  action: AgentCommandAction;
  reason: string;
  root_command_id: string;
  parent_command_id: string | null;
  root_source_message_id: string;
  agent_depth: number;
  state: 'pending' | 'complete' | 'cancelled';
  /** Where the answer goes. */
  return_room_id: string | null;
  result_message_id: string | null;
  lifecycle_before: string | null;
  review_context?: Record<string, unknown> | null;
  wake_context?: { briefRevision?: number; scheduleReplyFrom?: MessageRoute['from'] } | null;
  recovery_context: string | null;
};
/**
 * Reasons that ask a reviewer to look at a pull request head.
 * `createAgentCommand` inserts every one of them, so the refusal below is the
 * only decision that can stop a verdicted head from being delivered again.
 */
export const REVIEWER_DISPATCH_REASONS = [
  'corner_review_dispatch',
  'subscribed_event',
  'agent_tag',
  'order',
  'report',
] as const;
/** Review dispatch and verdict reports carry the assigned head. */
export function reviewerDispatchCarriesHead(
  reason: string,
  sourceKind: string | undefined,
  reviewContext: Record<string, unknown> | undefined,
): boolean {
  if (reason === 'corner_review_dispatch') return true;
  if (reason === 'subscribed_event' && sourceKind === 'check-passed') return true;
  if (!reviewContext) return false;
  return reason === 'report' && reviewContext.purpose === 'verdict';
}
/** Only a pending green-head request on the current brief revision suppresses another automatic review request. */
export async function hasPendingCornerReview(db: SqlDatabase, roomId: string, agentId: string,
  headSha: string, pullRequest?: number | null): Promise<boolean> {
  return (await db.query(`SELECT 1 FROM agent_commands command
    JOIN rooms corner ON corner.id=command.room_id JOIN rooms parent ON parent.id=corner.parent_id
    WHERE command.room_id=$1 AND command.agent_id=$2 AND command.agent_id=${cornerReviewerSql()}
      AND command.state='pending' AND ${greenReviewRequestSql('command')}
      AND command.review_context->>'headSha'=$3
      AND command.review_context->'pullRequest'=COALESCE($4::jsonb,
        (SELECT lifecycle->'pr'->'number' FROM corner_github_cache WHERE corner_id=$1)) AND (command.review_context->>'briefRevision')::int IS NOT DISTINCT FROM COALESCE((SELECT max(revision) FROM corner_brief_revisions WHERE corner_id=$1),0) LIMIT 1`,
    [roomId,agentId,headSha,pullRequest == null ? null : json(pullRequest)])).rowCount > 0;
}
export { turnRootMessageSql } from './message-route.js';
export function nextAgentDepth(parentDepth: number): number {
  return parentDepth + 1;
}
/** Exact-target eligibility shared by dispatch, the machine snapshot and delivery, including reports. */
export function currentCornerCommandTargetSql(command: string): string {
  const corner = `COALESCE((${command}.review_context->>'cornerId')::uuid,${command}.room_id)`;
  const cache = cornerLifecycleSql(corner);
  return `((${command}.review_context IS NULL OR (
    ${command}.review_context->>'headSha' IS NOT DISTINCT FROM ${cache}->'pr'->>'headSha'
    AND ${command}.review_context->'pullRequest' IS NOT DISTINCT FROM ${cache}->'pr'->'number'
    AND (${command}.review_context->>'briefRevision')::int IS NOT DISTINCT FROM
      COALESCE((SELECT max(revision) FROM corner_brief_revisions WHERE corner_id=${corner}),0)))
    AND NOT (${command}.state='pending' AND ${command}.review_context IS NOT NULL
      AND ${command}.review_context->>'purpose' IS NULL
      AND ${command}.reason IN ('corner_review_dispatch','subscribed_event') AND ${command}.agent_id IS DISTINCT FROM (
        SELECT ${cornerReviewerSql('target', 'target_parent')} FROM rooms target
        JOIN rooms target_parent ON target_parent.id=target.parent_id WHERE target.id=${corner}))
    AND NOT EXISTS(SELECT 1 FROM messages target_source WHERE target_source.id=${command}.source_message_id
      AND ${command}.reason IN ('corner_check','corner_merge_conflict','corner_review_dispatch','subscribed_event')
      AND target_source.system_event->'object'->>'headSha' IS NOT NULL
      AND target_source.system_event->'object'->>'headSha' IS DISTINCT FROM ${cache}->'pr'->>'headSha'))`;
}
/** An explicit app call gets its own queue item, without notifying a helper;
 * the historical requester provenance remain the app-call contract. */
export async function createMcpAgentCommand(db: SqlDatabase, input: {
  roomId: string; agentId: string;
  parent?: Pick<CommandRow, 'root_command_id' | 'root_source_message_id' | 'agent_depth'>;
  requesterMessageId?: string;
}): Promise<string> {
  const command = await queueMessage(db, { ...input, sourceMessageId: null, reason: 'mcp_call',
    parent: input.parent as CommandRow | undefined,
    scheduledHumanCommandMessageId: input.requesterMessageId });
  return command!.id;
}
export type AgentCommandInput = {
    roomId: string;
    agentId: string;
    sourceMessageId: string | null;
    /** Server-resolved human authority for a saved scheduled task. */
    scheduledHumanCommandMessageId?: string;
    privatePayload?: PrivateCommandPayload;
    id?: string;
    reason: string;
    action?: AgentCommandAction;
    /** A wake that continues the parent's turn (an approval or connector answer). */
    resume?: boolean;
    parent?: CommandRow;
    /** Report evidence belongs to the reporting turn, while parent retains the return chain. */
    reportSource?: CommandRow;
    /** Lifecycle transfer/resumption retains the chain; only agent delegation increments. */
    retainDepth?: boolean;
    /** Conversation tags retain chain depth without inheriting assignment privacy. */
    inheritPrivatePayload?: boolean;
    avatarJob?: boolean;
    /** Explicit workflow assignee, excluding ordinary event subscribers. */
    workflowAssignment?: boolean;
    /** A line appended to a lifecycle wake's text, fixed at dispatch. */
    wakeNote?: string;
  };
export { isTaggedLoginText,parseTaggedAgentLifecycleCommand,TAGGED_AGENT_LIFECYCLE_COMMANDS } from './agent-command-create-agent-command.js';
export type { TaggedAgentLifecycleCommand } from './agent-command-create-agent-command.js';
export { dropQueuedOrdersForStop,lockAgentCommandQueue } from './agent-command-queue.js';
export { commandInbox,queueCornerMergeConflict,readAgentCommands,reconcileCornerMergeBlockers,routeSystemCommand } from './agent-command-read-agent-commands.js';
export { reconcileConfiguredCornerReviewers } from './agent-command-reconcile-configured-corner-reviewers.js';
export { authorizeCommandOutput,CORNER_AGENT_UNREACHABLE_CARD_TYPE,CORNER_CHECKS_BLOCKED_CARD_TYPE,CORNER_MERGE_YES_CARD_TYPE,CORNER_REVIEW_DEADLOCK_CARD_TYPE,dismissAgentCommandWakes,selectMcpMessage } from './agent-command-route-agent-result.js';
export { queueMessage as createAgentCommand };
/** Transport adapters supply data; this is the only conversational write entry. */
export type QueuedPost = {
  /** A member posts under its own name: a person's words or its agent's model text. */
  kind: 'post'; roomId: string; authorId: string; text: MemberText; id?: string;
  replyTo?: string; attachments?: readonly Attachment[]; requestId?: string; commandRoomId?: string;
  sourceClient?: { id: string; name: string }; tags?: unknown; presentation?: 'message' | 'card'; cardType?: string;
  parent?: CommandRow; card?: unknown; agentIds?: readonly string[];
  /** Only the answer exit supplies a recorded audience outside the execution chat. */
  audienceId?: string;
  origin?:MessageRoute['from'];
  stopped?: boolean;
  /** Internal only: lets a self-closing turn publish its own closing answer after archiving its thread. */
  allowArchivedPost?: boolean;
};
export type QueuedDelivery = {
  kind: 'delivery'; roomId: string; recipientId?: string; id: string;
  sourceRoomId: string; sourceItem: CommandRow; parent?: CommandRow; stopped?: boolean;
  attachments?: readonly Attachment[]; ask?: string; replyTo?: string;
  automatic?: boolean; idleSince?: string;
} & { authorId: string; text: AgentVoice };
export type QueuedOrder = {
  /** Only an agent orders, in its model's words. */
  kind: 'order'; roomId: string; authorId: string; agent?: string; text: AgentVoice;
  parent?: CommandRow; id?: string;
};
type Member = { id: string; kind: 'human' | 'agent'; handle: string | null; name: string;
  callback: string | null; client_id: string | null; client_name: string | null; mcp: boolean; starter: string | null; owner_id: string | null; access_policy: unknown };
type Chat = { id: string; parent_id: string | null; archived: boolean; direct_participants: string[] | null;
  workflow_owner_id:string|null;
  worker: string | null; source_member: boolean; source_archived: boolean; source_parent_id: string | null;
  opening_root: { author_id: string; room_id: string } | null; members: Member[]; opening: CommandRow | null;
  brief_revision: number | null;
  source: { text: string; author_id: string; room_id: string; system_event: AgentCommand['source']['systemEvent']; attachments?: readonly Attachment[]; presentation?: string; reply_to_message_id?: string | null; card_type?: string; card?: WorkflowWakeCard } | null;
  parent_source: { author_id: string; room_id: string } | null;
  review: {agentId:string;headSha:string;pullRequest:number;briefRevision:number;checks:unknown;cornerId:string} | null };
export type QueuedPostReceipt = { id: string; createdAt: number; commands: CommandRow[]; woken: string[];
  notWoken: { handle: string; reason: string }[]; stopped: boolean; stored: boolean; visible: boolean; receipt: string };
type DeliveryReceipt = {
  commandId?: string; messageId?: string; createdAt?: number; queued: boolean; published: boolean;
  receipt: string; woken?: string[]; notWoken?: {handle:string;reason:string}[];
};
type OrderFeedback = { id:string; createdAt:number; feedback:string };type DeliveryInput = AgentCommandInput & { audienceId?: string; stopped?: boolean; allowArchivedOrigin?: boolean };
export function queueMessage(db: SqlDatabase, input: QueuedPost): Promise<QueuedPostReceipt>;
export function queueMessage(db: SqlDatabase, input: QueuedDelivery): Promise<DeliveryReceipt>;
export function queueMessage(db: SqlDatabase, input: QueuedOrder): Promise<CommandRow | OrderFeedback>;
export function queueMessage(db: SqlDatabase, input: DeliveryInput): Promise<CommandRow | undefined>;
export async function queueMessage(database: SqlDatabase, raw: QueuedPost | QueuedOrder | QueuedDelivery | DeliveryInput): Promise<QueuedPostReceipt | CommandRow | OrderFeedback | DeliveryReceipt | undefined> {
  if ('kind' in raw && (raw.kind === 'post' || raw.kind === 'delivery')) {
    assertMemberTranscript(raw.authorId, raw.kind === 'post' ? raw.presentation : undefined);
  }
  // PostgreSQL text/jsonb cannot represent NUL or isolated UTF-16 surrogates.
  raw={...raw,roomId:raw.roomId.toLowerCase()};
  const input = 'text' in raw ? { ...raw, text: pgText<typeof raw.text>(raw.text) } as typeof raw : raw.privatePayload
    ? { ...raw, privatePayload: { ...raw.privatePayload, text: pgText(raw.privatePayload.text) } } : raw;
  const db = new CornerAccessDatabase(database);
  return db.transaction(async db => {
    const post = 'kind' in input && input.kind === 'post';
    const order = 'kind' in input && input.kind === 'order';
    const delivery = 'kind' in input && input.kind === 'delivery';
    const command = !post && !order && !delivery ? input as DeliveryInput : undefined;
    const parent = input.parent;
    const origin=post ? input.origin : command?.privatePayload?.route?.from;
    const chat = (await db.query<Chat>(
      `WITH audience AS MATERIALIZED (
         SELECT member.identity_id id,identity.kind,identity.name,
           beeline_workspace_handle(identity.id,member.workspace_id) handle,
           COALESCE(app.callback_url,client.callback_url) callback,client.id client_id,client.name client_name,app.member_id IS NOT NULL mcp,
           starter.starter_role starter,worker.owner_id,worker.access_policy
         FROM rooms room JOIN memberships member ON member.room_id=COALESCE(room.parent_id,room.id)
           AND member.removed_at IS NULL
         JOIN identities identity ON identity.id=member.identity_id
         LEFT JOIN agents worker ON worker.agent_id=identity.id
         LEFT JOIN rooms_mcp_members app ON app.member_id=identity.id
         LEFT JOIN rooms_mcp_clients client ON client.id=app.client_id
         LEFT JOIN free_agents starter ON starter.agent_id=identity.id AND starter.removed_at IS NULL
         WHERE room.id::text=$1 FOR SHARE OF room,member
       ) SELECT room.id,room.parent_id,room.archived_at IS NOT NULL archived,
         room.direct_participants,
         ($4::text IS NULL OR $5='${SYSTEM_IDENTITY_ID}' OR EXISTS(SELECT 1 FROM rooms source JOIN memberships source_member
           ON source_member.room_id=COALESCE(source.parent_id,source.id)
           AND source_member.identity_id=$5 AND source_member.removed_at IS NULL
           WHERE source.id::text=$4)) source_member,
         COALESCE((SELECT archived_at IS NOT NULL FROM rooms WHERE id::text=$4),false) source_archived,
         (SELECT parent_id FROM rooms WHERE id::text=$4) source_parent_id,
         ${cornerImplementerSql('fact', 'room')} worker,
         (SELECT jsonb_build_object('agentId',${cornerReviewerSql('room','review_parent')},'cornerId',room.id,
           'headSha',gh.lifecycle->'pr'->>'headSha','pullRequest',gh.lifecycle->'pr'->'number',
           'briefRevision',COALESCE((SELECT max(revision) FROM corner_brief_revisions WHERE corner_id=room.id),0),
           'checks',${reviewChecksSql.replaceAll('lifecycle','gh.lifecycle')})
          FROM corner_github_cache gh JOIN rooms review_parent ON review_parent.id=room.parent_id
          WHERE gh.corner_id=room.id) review,
         COALESCE((SELECT jsonb_agg(audience) FROM audience),'[]'::jsonb) members,
         to_jsonb(initial) opening,
         (SELECT owner.id FROM messages workflow JOIN messages start ON start.id=workflow.card->>'runId'
           AND start.room_id=workflow.room_id JOIN identities owner ON owner.id=start.card->>'ownerId'
           AND owner.kind='human' WHERE workflow.id=$2 AND workflow.card_type='workflow-handoff') workflow_owner_id,
         (SELECT jsonb_build_object('author_id',author_id,'room_id',room_id) FROM messages
           WHERE id=initial.root_source_message_id) opening_root,
         (SELECT max(revision) FROM corner_brief_revisions WHERE corner_id=room.id) brief_revision,
         (SELECT jsonb_build_object('text',text,'author_id',author_id,'room_id',room_id,'system_event',system_event,'attachments',attachments,'presentation',presentation,'reply_to_message_id',reply_to_message_id,'card_type',card_type,'card',card)
           FROM messages WHERE id=$2) source,
         (SELECT jsonb_build_object('author_id',author_id,'room_id',room_id) FROM messages WHERE id=$3) parent_source
       FROM rooms room LEFT JOIN corner_facts fact ON fact.corner_id=room.id
       LEFT JOIN LATERAL (${cornerOpeningSql('room.id')}) initial ON true WHERE room.id::text=$1`,
      [input.roomId, command?.sourceMessageId ?? null,
        parent?.source_message_id ?? parent?.root_source_message_id ?? command?.reportSource?.root_source_message_id ?? command?.scheduledHumanCommandMessageId ?? null,
        delivery ? input.sourceRoomId : origin?.place ?? null, delivery ? input.authorId : origin?.agent ?? null],
    )).rows[0];
    const audience = chat?.members ?? [];
    const actor = delivery ? input.recipientId ?? input.authorId : post ? input.audienceId ?? input.authorId : order ? input.authorId
      : command?.audienceId ?? command?.privatePayload?.route?.from.agent ?? (command?.privatePayload?.kind === 'order' ? command.privatePayload.authorId
        : chat?.source?.room_id === input.roomId && !chat.source.system_event ? chat.source.author_id : undefined);
    const recipient = command?.agentId;
    const named = order ? input.agent?.trim().replace(/^@/, '').toLowerCase() : undefined;
    const candidates = order ? audience.filter(member => member.kind === 'agent' && (named
      ? member.id === named || member.handle?.toLowerCase() === named
      : chat?.parent_id ? member.id === chat.worker : member.id !== input.authorId)) : [];
    if (!chat || !chat.source_member || order && named && !candidates.length || actor && actor !== SYSTEM_IDENTITY_ID && !audience.some(member => member.id === actor) ||
        recipient && !audience.some(member => member.id === recipient && member.kind === 'agent'))
      refuseMessageMembership(delivery ? 'commander is no longer a member of the return address' : undefined);
    if (post && chat.direct_participants?.includes(SYSTEM_IDENTITY_ID))
      throw wall('credentials', 'this is a read-only system thread; only @system may post here (access denied)');
    const archivedDestination = chat.archived && !(post && input.allowArchivedPost);
    const archivedSource = (delivery || origin) && chat.source_archived && !command?.allowArchivedOrigin;
    if (archivedDestination || archivedSource || 'stopped' in input && input.stopped)
      refuseStoppedMessage(Boolean(archivedDestination || archivedSource));
    if (delivery) {
      const target = audience.find(member => member.id === input.recipientId);
      if (target?.kind === 'agent') {
        // Cutover only: old helper reports retain their queued wake/return plumbing.
        const queued = await insertAgentCommand(db, { id: input.id, roomId: chat.id, agentId: target.id,
          sourceMessageId: null, reason: 'report', parent: input.parent, reportSource: input.sourceItem,
          scheduledHumanCommandMessageId: input.sourceItem.root_source_message_id, retainDepth: true,
          privatePayload: { kind: 'report', ...({ text: input.text, authorId: input.authorId } as PayloadVoice), fromRoomId: input.sourceRoomId,
            ask: input.ask, sourceAgentId:input.sourceItem.agent_id, automatic: input.automatic, idleSince: input.idleSince,
            originCornerId: chat.source_parent_id ? input.sourceRoomId : input.sourceItem.private_payload?.originCornerId, attachments: input.attachments ? [...input.attachments] : undefined },
        }, chat);
        return { commandId: queued!.id, createdAt: new Date(queued!.created_at).getTime() / 1000, queued: true, published: false, receipt: 'Report queued privately.' };
      }
      const saved = await postMessage(db, { kind: 'post', roomId: chat.id, authorId: input.authorId,
        audienceId: input.recipientId, id: input.id, text: input.text, attachments: input.attachments,
        requestId: input.sourceItem.turn_request_id, parent: input.sourceItem, replyTo: input.replyTo,
        card: input.ask ? {ask:input.ask} : undefined,
      }, chat);
      return { messageId: saved.stored ? saved.id : undefined, createdAt: saved.stored ? saved.createdAt : undefined,
        queued: false, published: saved.stored, receipt: saved.receipt, woken:saved.woken, notWoken:saved.notWoken };
    }
    if (post) return postMessage(db, input, chat);
    if (order) {
      if (candidates.length !== 1) return { id:parent?.id ?? hash(`order-feedback:${chat.id}:${input.authorId}`),
        createdAt:Math.floor(Date.now()/1000),
        feedback:`name which agent this order is for: ${audience.filter(member=>member.kind==='agent')
          .map(member=>`@${member.handle ?? member.id}`).sort().join(', ')}` };
      return (await insertAgentCommand(db, { roomId: input.roomId, agentId: candidates[0]!.id,
        id: input.id,
        sourceMessageId: null, reason: 'order', parent,
        privatePayload: { kind: 'order', text: input.text, authorId: input.authorId, fromRoomId: parent?.room_id ?? input.roomId },
      }, chat))!;
    }
    return insertAgentCommand(db, command!, chat);
  });
}
async function postMessage(db: SqlDatabase, input: QueuedPost, chat: Chat): Promise<QueuedPostReceipt> {
  assertMemberTranscript(input.authorId, input.presentation);
  const author = chat.members.find(member => member.id === input.authorId);
  input = author?.kind === 'agent' ? { ...input, text: modelText(repairAgentPost(input.text).text) } : input;
  if (author?.kind === 'agent' && !input.text.trim() && !input.attachments?.length) return {
    id:input.id ?? hash(`empty-reply:${chat.id}:${input.authorId}:${input.requestId ?? ''}`),
    createdAt:Math.floor(Date.now()/1000),commands:[],woken:[],notWoken:[],stopped:false,stored:false,visible:false,
    receipt:'The reply has no public text; the request is still queued.',
  };
  const attachments = json(input.attachments ?? []);
  const original = input.id ? pgText(input.id) : randomBytes(32).toString('hex');
  const existing = (await db.query<{ id: string; author_id: string; room_id: string; text: string; attachments: unknown }>(
    'SELECT id,author_id,room_id,text,attachments FROM messages WHERE id=$1', [original],
  )).rows[0];
  const id = existing && (existing.author_id !== input.authorId || existing.room_id !== input.roomId ||
      existing.text !== input.text || json(existing.attachments) !== attachments)
    ? hash(`message:${original}:${input.authorId}:${input.roomId}:${input.text}:${attachments}`) : original;
  const saved = (await db.query<{ id: string; created_at: Date; reply_to_message_id:string|null }>(
     `INSERT INTO messages(id,room_id,author_id,text,attachments,source_client,presentation,request_id,card,reply_to_message_id,root_message_id,legacy_event,card_type,agent_model)
     SELECT $1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9::jsonb,parent.id,COALESCE(parent.root_message_id,parent.id),$11::jsonb,$12,
       (SELECT selected_model FROM agents WHERE agent_id=$3)
     FROM (SELECT 1) source LEFT JOIN messages parent ON parent.id=$10 AND (parent.room_id=$2 OR parent.id=$13 AND parent.room_id=$14) AND parent.deleted_at IS NULL
     ON CONFLICT(id) DO NOTHING RETURNING id,created_at,reply_to_message_id`,
    [id, chat.id, input.authorId, input.text, attachments, input.sourceClient ? json(input.sourceClient) : author?.client_id ? json({id:author.client_id,name:author.client_name}) : null,
      input.presentation ?? 'message', input.requestId ?? null, input.card ? json(input.card) : null, input.replyTo ?? null, input.tags ? json(input.tags) : null,input.cardType ?? null,
      input.parent?.message?.id ?? input.parent?.id ?? null,input.origin?.place ?? null],
  )).rows[0] ?? (await db.query<{ id:string; created_at:Date; reply_to_message_id:string|null }>(
    'SELECT id,created_at,reply_to_message_id FROM messages WHERE id=$1',[id])).rows[0]!;
  // A reply tool records the committed answer for this request. Progress in
  // another place and private agent reports do not spend its return obligation.
  if (input.requestId && input.text.trim() && input.presentation !== 'card') await db.query(
    `UPDATE agent_commands command SET posted_reply_id=COALESCE(command.posted_reply_id,$4)
     WHERE agent_id=$1 AND turn_request_id=$2 AND ($3::text IS NULL OR room_id::text=$3) AND state='pending'
       AND return_room_id=$5 AND (command.private_payload IS NULL OR
         command.private_payload->>'returnIdentityId'=ANY($6::text[]))`,
    [input.authorId,input.requestId,input.commandRoomId ?? null,id,chat.id,
      chat.members.filter(member=>member.kind==='human').map(member=>member.id)]);
  if (input.requestId && input.attachments?.length) await db.query(
    `UPDATE agent_commands command SET answer_attachments=COALESCE((SELECT jsonb_agg(part)
       FROM jsonb_array_elements(command.answer_attachments) part WHERE NOT (part->>'url'=ANY($4::text[]))),'[]'::jsonb)
     WHERE command.agent_id=$1 AND command.turn_request_id=$2 AND ($3::text IS NULL OR command.room_id::text=$3)`,
    [input.authorId,input.requestId,input.commandRoomId ?? null,input.attachments.map(file=>file.url)]);
  const human = author?.kind === 'human';
  if (human) await db.query(
    `INSERT INTO room_read_marks(room_id,identity_id,message_created_at,message_id,updated_at)
     VALUES($1,$2,$3,$4,'epoch'::timestamptz) ON CONFLICT(room_id,identity_id) DO UPDATE SET
       message_created_at=EXCLUDED.message_created_at,message_id=EXCLUDED.message_id
       WHERE (EXCLUDED.message_created_at,EXCLUDED.message_id)>(room_read_marks.message_created_at,room_read_marks.message_id)`,
    [chat.id, input.authorId, saved.created_at, id]);
  const blockAnswer = human ? await wakeBlockAnswer(db,saved.id,chat.id,input.authorId) : undefined;
  const handles = [...typedMentionHandles(input.text)];
  const stops = human ? chat.members.filter(member => member.kind === 'agent' &&
    parseTaggedAgentLifecycleCommand(input.text, member.handle) === 'stop') : [];
  if (stops.length) await db.query(
    `SELECT ended.id FROM agent_commands item CROSS JOIN LATERAL
       beeline_finish_agent_command(item.id,'cancelled','${PERSON_STOP_REASON}',NULL) ended
     WHERE item.room_id=$1 AND item.agent_id=ANY($2::text[]) AND item.state='pending'`,
    [chat.id, stops.map(member => member.id)]);
  const channel = handles.some(isChannelMentionToken);
  const explicit = chat.members.filter(member => channel || handles.some(handle => member.handle?.toLowerCase() === handle.toLowerCase()));
  const agents = chat.members.filter(member => member.kind === 'agent');
  const solo = !chat.direct_participants && !chat.parent_id && chat.members.filter(member => member.kind === 'human').length === 1 &&
    (agents.length === 1 ? agents[0] : agents.length === 2 && agents.some(member => member.starter === 'luna')
      ? agents.find(member => member.starter === 'beebee') : undefined);
  const commands: CommandRow[] = blockAnswer ? [blockAnswer] : [], woken: string[] = blockAnswer ? [blockAnswer.agent_id] : [];
  const lifecycle = human && !stops.length && input.presentation !== 'card' && await routeTaggedLifecycleCommand(db,
    { room_id: chat.id, author_id: input.authorId, text: input.text, tagged_ids: explicit.filter(member => member.kind === 'agent' && !member.mcp).map(member => member.id) }, id,
    async (command, retry) => {
      const source = retry?.message;
      const item = await insertAgentCommand(db, command, { ...chat, source: source ? {
        text: source.body, author_id: source.authorId, room_id: chat.id,
        system_event: source.systemEvent, attachments: source.attachments, presentation: source.type,
      } : { text: input.text, author_id: input.authorId, room_id: chat.id, system_event: undefined } });
      if (item && item.action !== 'restart') commands.push(item);
      return item;
    });
  const targets = (input.presentation === 'card' || stops.length || lifecycle ? [] : input.agentIds ? chat.members.filter(member => input.agentIds!.includes(member.id)) : [...new Map([
    // Only a person's tag wakes an agent; an agent reaches another agent through message().
    ...(human ? explicit : []),
    ...(human && !hasSystemReportMention(input.text) && chat.direct_participants ? agents.filter(member=>chat.direct_participants!.includes(member.id)) : []),
    ...(human && !explicit.length && solo ? [solo] : []),
  ].filter(member => member.kind === 'agent' && member.id !== input.authorId && member.id !== SYSTEM_IDENTITY_ID).map(member => [member.id, member])).values()]).filter(member => member.id!==blockAnswer?.agent_id).filter(member => !human || member.access_policy == null ||
    senderMayAddressAgent(parseAgentAccessPolicy(member.access_policy), input.authorId, member.owner_id ?? undefined));
  const avatarJob = human && /^(?:@[^\s]+\s+)?\/draw-avatar(?:\s|$)/i.test(input.text.trim());
  // The owner's creator/allowlist setting decides which people address a hosted agent; others are not its targets.
  for (const member of human ? await noteOfflineConnectors(db, targets) : targets) {
    const item = await insertAgentCommand(db, { roomId: chat.id, agentId: member.id, sourceMessageId: id,
      reason: human ? chat.direct_participants ? 'direct_message' : 'human_tag' : 'agent_tag', parent: input.parent,
      inheritPrivatePayload: false,
      avatarJob,
    }, { ...chat, source: { text: input.text, author_id: input.authorId, room_id: chat.id, system_event: undefined, attachments: input.attachments, presentation: 'message',reply_to_message_id:saved.reply_to_message_id } });
    if (item) commands.push(item);
    woken.push(member.handle ?? member.id);
  }
  return { id, createdAt: Math.floor(new Date(saved.created_at).getTime() / 1000), commands, woken, stopped: stops.length > 0,
    notWoken: handles.filter(handle => !isChannelMentionToken(handle) && !explicit.some(member => member.handle === handle))
      .map(handle => ({ handle, reason: 'not a current member' })),
    stored: true, visible: true, receipt: 'Message stored and visible.' + (author?.kind === 'agent' && !woken.length ? ' No agents woken.' : '') };
}
/** Appending is private to the entry above; it never checks membership again. */
async function insertAgentCommand(db: SqlDatabase, input: AgentCommandInput, chat: Chat): Promise<CommandRow | undefined> {
  const sender = chat.members.find(member => member.id === (input.privatePayload?.authorId ?? chat.source?.author_id));
  const target = chat.members.find(member => member.id === input.agentId);
  let cancelled = false; if (input.reason === 'mcp_call' && input.parent?.id) {
    const claimed = (await db.query<{ state: string }>(`SELECT command.state FROM agent_commands command WHERE command.id=$1
      AND EXISTS(SELECT 1 FROM rooms_mcp_members member WHERE member.member_id=command.agent_id) FOR UPDATE OF command`, [input.parent.id])).rows[0];
    cancelled = claimed?.state === 'cancelled';
  }
  if (cancelled || sender?.kind === 'human' && input.reason !== 'tagged_lifecycle_restart' && input.reason !== 'tagged_lifecycle_retry' && target?.access_policy != null &&
    !senderMayAddressAgent(parseAgentAccessPolicy(target.access_policy), sender.id, target.owner_id ?? undefined))
    throw wall('access', cancelled ? 'command turn cancelled' : 'the agent owner’s creator-only or people-allowlist policy does not allow this sender to address the agent');
  if (input.avatarJob && sender?.kind === 'human' && target?.access_policy != null && target.owner_id !== sender.id)
    throw wall('membership', 'only the agent owner may generate its avatar (access denied)');
  const id = input.id ?? (input.sourceMessageId
    ? hash(`queue:${chat.id}:${input.agentId}:${input.sourceMessageId}:${input.reason}`)
    : randomBytes(32).toString('hex'));
  const lifecycle = input.reason.startsWith('corner_') || input.reason === 'subscribed_event' && Boolean(chat.opening);
  const parent = input.parent ?? (lifecycle ? chat.opening ?? undefined : undefined);
  const opening = input.reason === 'corner_objective' ? input.privatePayload : chat.opening?.private_payload;
  const escalationIdentity = opening?.authorId;
  const escalationRoom = opening?.fromRoomId;
  const sourceText = chat.source?.text;
  const reply = chat.source?.reply_to_message_id ? (await db.query<{ author_id: string; name: string; text: string }>(
    `SELECT parent.author_id,author.name,left(parent.text,16001) text FROM messages parent
     JOIN identities author ON author.id=parent.author_id WHERE parent.id=$1 AND parent.room_id=$2`,
    [chat.source.reply_to_message_id,chat.source.room_id])).rows[0] : undefined;
  const scheduleOwner = (chat.source?.card as { ownerId?: unknown } | null)?.ownerId;
  const workflowOwner=chat.workflow_owner_id ?? (input.reason==='resume' && parent?.message?.systemEvent?.kind==='workflow-handoff'
    ? parent.message.route?.from.agent : undefined);
  // The saved requester supplies delivery; the timer remains the command's source.
  const scheduleReply = input.reason === 'schedule' && parent?.action === 'input' && parent.state !== 'cancelled'
    && parent.reason !== 'schedule' && parent.reason !== 'mcp_call' ? replyableWake(parent) : undefined;
  const scheduledReturn = input.reason === 'schedule' ? {
    kind: 'lifecycle' as const, authorId: chat.source?.author_id ?? SYSTEM_IDENTITY_ID,
    text: sourceText ?? input.reason, fromRoomId: chat.id,
    returnIdentityId: typeof scheduleOwner === 'string' && scheduleOwner !== input.agentId ? scheduleOwner
      : chat.parent_source?.author_id ?? (!chat.source?.system_event ? chat.source?.author_id : undefined)
        ?? chat.members.find(member => member.id === input.agentId)?.owner_id ?? undefined,
  } : undefined;
  // Inherited payloads copy stored rows; their origin was declared when written.
  let payload: PrivateCommandPayload | undefined = input.privatePayload ?? (scheduledReturn as PrivateCommandPayload | undefined) ?? (parent?.private_payload && input.inheritPrivatePayload !== false
    ? { ...parent.private_payload, kind: 'lifecycle', reported: undefined, text: sourceText ?? parent.private_payload.text } as PrivateCommandPayload
    : undefined);
  if (lifecycle && input.reason!=='corner_objective' && !workflowOwner) {
    const reviser=input.reason==='corner_brief_revision' ? input.parent : undefined, from={agent:input.privatePayload?.authorId ?? reviser?.agent_id
      ?? (chat.source?.system_event ? SYSTEM_IDENTITY_ID : chat.source?.author_id) ?? SYSTEM_IDENTITY_ID,place:input.privatePayload?.fromRoomId ?? reviser?.room_id ?? chat.source?.room_id ?? chat.id};
    payload={...payload,kind:'lifecycle',authorId:from.agent,
      text:input.privatePayload?.text ?? systemText(sourceText ?? input.reason),fromRoomId:from.place,
      route:{from,to:{agent:input.agentId,place:chat.id}},
      ...(input.reason==='corner_brief_revision' ? {replyAddress:undefined} : {}),
    } as PrivateCommandPayload;
  }
  const scheduleSender=scheduledReturn ? {agent:scheduledReturn.returnIdentityId ?? SYSTEM_IDENTITY_ID,place:chat.id} : undefined;
  if (scheduleSender?.agent===SYSTEM_IDENTITY_ID) await ensureSystemIdentity(db);
  const parentReturn=parent?.private_payload?.returnIdentityId ??
    (parent?.private_payload?.kind==='order'?parent.private_payload.authorId:undefined);
  // An event wake queued in a corner answers in that corner, as does the same agent's continuation
  // of it; only an explicit report reaches the commander. Orders and brief revisions (from their reviser) keep their route.
  const continuesCornerWake = parent?.agent_id === input.agentId && parent.return_room_id === chat.id && !parentReturn;
  const cornerWake = Boolean(chat.parent_id) && (lifecycle || continuesCornerWake)
    && payload?.kind !== 'order' && input.reason !== 'corner_brief_revision';
  // A wake note is delivery context beside the payload's own text (not new speech).
  if (payload) payload = { ...payload,
    text: payload.text + (input.wakeNote ? `\n${input.wakeNote}` : ''),
    ...(chat.parent_id && payload.kind === 'order' && escalationIdentity && escalationRoom
      ? { escalation: { identityId: escalationIdentity, roomId: escalationRoom } } : {}),
    returnIdentityId: payload.replyAddress?.agent ?? payload.route?.from.agent ?? (cornerWake ? undefined : payload.returnIdentityId ?? (payload.kind === 'order' ? payload.authorId
      : (parent?.agent_id === input.agentId && parentReturn!==input.agentId ? parentReturn : undefined) ?? chat.parent_source?.author_id)),
  } as PrivateCommandPayload;
  const returnRoom = workflowOwner ? chat.id : payload?.replyAddress?.place ?? payload?.route?.from.place ?? (input.reason === 'schedule' || cornerWake ? chat.id : payload?.kind === 'order' ? payload.fromRoomId : payload || lifecycle
    ? (parent?.agent_id === input.agentId ? parent.return_room_id : undefined) ?? chat.parent_source?.room_id ?? parent?.return_room_id ?? chat.id : chat.id);
  const reviewSource = input.reason === 'report' ? input.reportSource ?? input.parent : input.parent;
  const selectedReview=chat.review?.agentId===input.agentId && chat.review.headSha &&
    ['corner_review_dispatch','subscribed_event','agent_tag','order','message'].includes(input.reason) ? chat.review : undefined;
  const review = selectedReview ? {cornerId:selectedReview.cornerId,headSha:selectedReview.headSha,
    pullRequest:selectedReview.pullRequest,briefRevision:selectedReview.briefRevision,checks:selectedReview.checks,
    ...(reviewSource?.review_context && ['order','message'].includes(input.reason)?{purpose:'repair'}:{})}
    : input.reason==='corner_review_needed' && chat.review ? {...chat.review,purpose:'repair'}
    : reviewSource?.review_context && reviewSource.review_context.purpose !== 'repair' ? { ...reviewSource.review_context,
    purpose: input.reason === 'report' ? 'verdict' : 'repair' } : null;
  const commander = opening?.authorId;
  const openingOrigin = chat.opening_root ?? chat.parent_source;
  const reportAddress = chat.parent_id && commander ? commander === input.agentId && escalationRoom === chat.id && openingOrigin
    ? { identityId: openingOrigin.author_id, roomId: openingOrigin.room_id }
    : { identityId: commander, roomId: escalationRoom ?? chat.id } : null;
  // The workflow engine records its human owner as the assignment sender.
  // A resume keeps that same stored sender; later card actors do not transfer it.
  const privateMessage = Boolean(payload) && input.reason !== 'schedule';
  const workflowDetail = await queuedWorkflowWakeDetail(db,chat.id,chat.source,input.sourceMessageId,
    input.resume || input.reason === 'resume' ? parent?.source_message_id : undefined);
  const mention = queuedMentionKind(chat.id, input.reason, chat.source, target);
  const wake = mcpCommandWakeSql(19, mention === 'connector' && !privateMessage);
  let saved = (await db.query<CommandRow>(
    `WITH inserted AS (INSERT INTO agent_commands(id,room_id,agent_id,source_message_id,turn_request_id,action,reason,
       root_command_id,parent_command_id,root_source_message_id,agent_depth,avatar_job,private_payload,state,return_room_id,review_context,wake_context,report_address,message)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,'pending',$14,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb)
     ON CONFLICT DO NOTHING RETURNING *),${wake.cte}
     SELECT inserted.* FROM inserted ${wake.join}`,
    [id, chat.id, input.agentId, input.sourceMessageId, id,
      input.action ?? 'input', input.reason, parent?.root_command_id ?? id, parent?.id ?? null,
      parent?.root_source_message_id ?? input.scheduledHumanCommandMessageId ?? input.sourceMessageId ?? id,
      parent ? input.retainDepth || lifecycle || input.resume ? parent.agent_depth : parent.agent_depth + 1 : 0,
      input.avatarJob ?? false, payload ? json(payload) : null, returnRoom, review ? json(review) : null, input.reason === 'corner_brief_revision' ?
        json({briefRevision: chat.brief_revision ?? 0}) : scheduleReply ? json({scheduleReplyFrom: scheduleReply.from}) : null,
      reportAddress ? json(reportAddress) : null,
      json({ id: scheduleReply?.id ?? (privateMessage ? id : input.sourceMessageId ?? id),
        // Cutover only: legacy helper writes keep their existing routing plumbing.
        route:scheduleSender ? {from:scheduleSender,to:{agent:input.agentId,place:chat.id}} : workflowOwner ? {from:{agent:workflowOwner,place:chat.id},to:{agent:input.agentId,place:chat.id}} :
          input.reason==='mcp_call' && parent?.agent_id===input.agentId && parent.message?.route ? parent.message.route :
          legacyCommandPayload(payload) ? undefined : payload?.route ??
          {from:{agent:workflowOwner ?? payload?.authorId ?? chat.source?.author_id ?? SYSTEM_IDENTITY_ID,
            place:payload?.fromRoomId ?? chat.source?.room_id ?? chat.id},to:{agent:input.agentId,place:chat.id}},
        replyAddress:workflowOwner ? {agent:workflowOwner,place:chat.id} :
          input.reason==='mcp_call' && parent?.agent_id===input.agentId && parent.message?.route ? parent.message.replyAddress :
          payload?.replyAddress ?? (!payload?.route && (payload?.authorId ?? chat.source?.author_id)===SYSTEM_IDENTITY_ID
            ? (payload?.returnIdentityId ? {agent:payload.returnIdentityId,place:returnRoom} : undefined) : undefined),
        authorId: scheduleSender?.agent ?? workflowOwner ?? payload?.authorId ?? chat.source?.author_id ?? SYSTEM_IDENTITY_ID,
        body: (payload?.text ?? subscriptionPromptBody(sourceText ?? input.reason, chat.source?.system_event ?? null)) +
          squireDecisionDetail(chat.source?.card_type ?? null,chat.source?.card ?? null) +
          workflowDetail +
          (!payload && input.wakeNote ? `\n${input.wakeNote}` : ''),
        attachments: payload?.attachments ?? chat.source?.attachments ?? [],
        type: privateMessage ? 'private' : chat.source?.presentation ?? 'system',
        systemEvent: chat.source?.system_event,replyToMessageId:chat.source?.reply_to_message_id ?? undefined,
        ...(reply ? {replyToAuthorId:reply.author_id,replyToAuthorName:reply.name,replyToExcerpt:boundReplyExcerpt(reply.text)} : {}) }),...wake.params,
    ],
  )).rows[0] ?? (await db.query<CommandRow>(
    'SELECT * FROM agent_commands WHERE id=$1',[id],
  )).rows[0];
  if (saved) saved = await attachQueuedContext(db, saved, chat.members);
  if (saved && chat.parent_id && ['corner_objective','human_tag'].includes(input.reason))
    await initializeThreadImplementer(db, chat.id);
  if (saved && mention && input.sourceMessageId) await recordQueuedMention(db,mention,input.agentId,chat.id,input.sourceMessageId);
  const webhookSource = mention === 'connector' && !privateMessage ? input.sourceMessageId : null;
  if (saved && input.reason !== 'mcp_call' && target?.mcp && target.callback) await recordMcpMemberWebhook(db, target.id, target.callback, chat.id, webhookSource ?? saved.id,
    webhookSource ? sourceText ?? '' : `${payload?.kind === 'order' ? 'Order' : 'Wake'} (${input.reason}): ${payload?.text ?? sourceText ?? ''}`);
  return saved;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function refuseStoppedMessage(archived: boolean): never {
  throw wall('stop', archived ? {message:'address is archived',status:409} : 'command turn cancelled');
}
/** Every message adapter shares the queue owner's existing membership refusal. */
export function refuseMessageMembership(message='address requires current membership'):never {
  throw wall('membership',message);
}
type AnswerReceipt = Partial<Pick<QueuedPostReceipt, 'id' | 'createdAt' | 'receipt' | 'woken' | 'notWoken' | 'stored' | 'visible'>> & {
  commandId?: string; messageId?: string; completed: boolean; published: boolean; superseded?: boolean;
  delivered?: boolean; answered?: boolean; queued?: boolean; deliveryCommandId?: string; destination?: MessageRoute['to'];
};

export async function wakePeerMessageSender(db: SqlDatabase, item: CommandRow, output: PeerReplyWakeOutput): Promise<CommandRow | undefined> {
  const wake = await peerReplyWakeInput(db, item, output);
  return wake ? queueMessage(db, wake) : undefined;
}

/** The only queue-answer exit. Publication and completion share its transaction. */
export async function answerQueuedMessage(database: SqlDatabase, agentId: string, input: {
  roomId: string; requestId?: string; text: string;
  messageAsk?: MessageAsk; explicitReply?: boolean; publicPost?: boolean;
  steps?: unknown; messageId?: string; replyToMessageId?: string;
  queuedRequestIds?: readonly string[];
  batchCommandIds?: readonly string[];
  harnessEnded?: boolean;
  /** Publish this text even after a same-place reply (a review verdict, for example). */
  keepFinal?: boolean;
  silentCompletion?: boolean;
  invocation?: import('@beeline/api-contract/daemon').AgentInvocation;
  invocationId?: string;
  outputFiles?: Attachment[];
  sharedReplyId?: string;
}): Promise<AnswerReceipt> {
  if (input.harnessEnded && input.invocation && !input.explicitReply) return finalizeAgentInvocation(database,agentId,input.roomId,input.invocation,
    db => answerQueuedMessage(db,agentId,{...input,invocation:undefined,invocationId:input.invocation!.id,messageId:hash(`local-final:${input.invocation!.requestId}:${input.invocation!.id}`)}));
  if (input.queuedRequestIds?.length) return database.transaction(async db => {
    const ids = [...new Set([input.requestId, ...(input.queuedRequestIds ?? [])].filter((id): id is string => Boolean(id)))];
    const items = (await db.query<CommandRow>(`SELECT * FROM agent_commands
      WHERE agent_id=$1 AND room_id=$2 AND id=ANY($3::text[])
      ORDER BY inbox_sequence,id FOR UPDATE`, [agentId,input.roomId,ids])).rows;
    const attachments = items.flatMap(item => item.answer_attachments ?? []);
    const files = [...new Map(attachments.map(file => [file.url,file])).values()];
    const outputId = input.messageId ?? hash(`local-final:${input.requestId ?? ids[0]}`);
    let sharedReplyId: string | undefined;
    let result: Awaited<ReturnType<typeof answerQueuedMessage>> | undefined;
    let unanswered = false;
    for (const item of items) {
      const saved = await answerQueuedMessage(db,agentId,{
        ...input,queuedRequestIds:undefined,batchCommandIds:ids,requestId:item.id,
        sharedReplyId,
        outputFiles:files, messageId:outputId,
      });
      result ??= saved;
      if (!saved.completed) unanswered = true;
      if (!input.explicitReply && saved.published && saved.messageId === outputId) {
        sharedReplyId = saved.id;
        result = saved;
      }
    }
    const saved = result ?? await answerQueuedMessage(db,agentId,{...input,queuedRequestIds:undefined});
    return unanswered ? { ...saved, completed: false, answered: false } : saved;
  });
  let completedNow = false;
  let suppressedFinal = false;
  const published = await database.transaction<AnswerReceipt>(async db => {
    const item = (await db.query<CommandRow & { public_reply_id: string | null;
      name: string; stop_requested_at: Date | null; public_reply_at: Date | null; room_archived: boolean; self_closed: boolean }>(
      `SELECT item.*,identity.name,posted.id public_reply_id,posted.created_at public_reply_at,
         room.archived_at IS NOT NULL room_archived,
         EXISTS(SELECT 1 FROM agent_invocations inv WHERE inv.self_closed AND (inv.command_id=item.id OR item.id=ANY(inv.batched_command_ids))
           AND ($4::text IS NOT NULL AND inv.invocation_id=$4 OR $4::text IS NULL AND item.state='pending' AND NOT inv.ended)) self_closed
       FROM agent_commands item JOIN identities identity ON identity.id=item.agent_id
       JOIN rooms room ON room.id=item.room_id
       LEFT JOIN messages posted ON posted.id=COALESCE(item.result_message_id,item.posted_reply_id) AND posted.deleted_at IS NULL
         AND posted.author_id=item.agent_id
       WHERE item.agent_id=$1 AND item.room_id::text=$2 AND item.id=$3 FOR UPDATE OF item`,
      [agentId, input.roomId, input.requestId ?? null, input.invocationId ?? input.invocation?.id ?? null],
    )).rows[0];
    if (item?.state === 'pending' && item.private_payload?.automatic && item.private_payload.idleSince
      && item.private_payload.authorId === SYSTEM_IDENTITY_ID
      && !(await db.query(`SELECT 1 FROM agent_commands item WHERE item.id=$1 AND ${currentIdleReportSql('item')}`, [item.id])).rowCount) {
      completedNow = true;
      await endAgentTurn(db, item, 'complete');
      return { commandId: item.id, completed: true, published: false };
    }
    const payload = item?.private_payload;
    const messageText = repairAgentPost(item?.reason === 'voice_order' ? cleanVoiceReply(input.text,item.name) : input.text).text.trim();
    if (item?.state === 'cancelled') refuseStoppedMessage(false);
    if (item) {
      const receipt = {commandId: item.id, completed: item.state === 'complete', published: Boolean(item.public_reply_id),
        ...(item.public_reply_id ? {id:item.public_reply_id,messageId:item.public_reply_id,createdAt:Math.floor(new Date(item.public_reply_at!).getTime()/1000),
          stored:true,visible:true,delivered:true} : {})};
      if (!input.explicitReply) {
        const files = input.outputFiles ?? item.answer_attachments ?? [];
        if (item.stop_requested_at || item.state === 'complete' && !item.result_message_id && (payload?.automatic || isBackgroundCommand(item.reason))) return receipt;
        if (!input.publicPost && !messageText && !files.length && !input.sharedReplyId) {
          if (item.state === 'complete') return receipt;
          if (item.room_archived && item.self_closed) {
            const prior = (await db.query<{ id: string; text: string; attachments: Attachment[] }>(
              `SELECT id,text,attachments FROM messages
               WHERE room_id=$1 AND author_id=$2 AND deleted_at IS NULL AND presentation='message'
                 AND (id=$3 OR request_id=$4)
               ORDER BY created_at DESC,id DESC LIMIT 1`,
              [item.room_id, agentId, item.public_reply_id ?? '', item.turn_request_id],
            )).rows[0];
            const ended = await endAgentTurn(db, item, 'complete', null, prior?.id ?? item.public_reply_id ?? undefined);
            if (ended) await wakePeerMessageSender(db, item, {
              kind: 'answer', outputId: prior?.id ?? `closed:${item.id}`, text: prior?.text ?? 'Closed the thread.',
              attachments: prior?.attachments, batchCommandIds: input.batchCommandIds, invocationId: input.invocationId ?? input.invocation?.id,
            });
            completedNow = true;
            return { ...receipt, ...(prior ? { id: prior.id, messageId: prior.id, published: true, stored: true, visible: true, delivered: true } : {}), completed: true };
          }
          const silentSchedule = item.reason === 'schedule' && input.harnessEnded === true &&
            input.silentCompletion === true && Boolean(input.invocationId);
          if (!silentSchedule && !item.public_reply_id && !payload?.automatic && !isBackgroundCommand(item.reason) && !isInformationalReply(item.reason,payload?.messageAsk)) {
            if (input.harnessEnded) await db.query('SELECT * FROM beeline_interrupt_agent_turn($1,$2,$3,NULL,NULL)',[agentId,item.room_id,item.turn_request_id]);
            return {...receipt, answered:false};
          }
          await endAgentTurn(db,item,'complete',null,item.public_reply_id ?? undefined);
          completedNow = true;
          return {...receipt, completed: true};
        }
        const outputId = input.messageId ?? hash(`local-final:${item.id}`);
        const previous = !input.sharedReplyId && item.state === 'complete' ? (await db.query<{ id: string; created_at: Date; deleted_at: Date | null }>(
          'SELECT id,created_at,deleted_at FROM messages WHERE id=$1 AND room_id=$2 AND author_id=$3', [outputId,item.room_id,agentId])).rows[0] : undefined;
        if (previous) return { ...receipt, id: previous.id, messageId: previous.id, published: true,
          createdAt: Math.floor(new Date(previous.created_at).getTime() / 1000), delivered: true, stored: true, visible: !previous.deleted_at };
        // The agent already replied in this place during the turn. Its closing
        // text goes to the turn's activity, not into the chat a second time.
        // A native reply leaves the command pending, so the reply completes it.
        const replyId = item.reply_tool_message_id;
        if (input.harnessEnded && !input.keepFinal && !input.publicPost && !input.sharedReplyId && !files.length && replyId) {
          const reply = await holdFinalAfterReply(db, {id: hash(`suppressed-final:${item.id}:${outputId}`), replyId,
            roomId: item.room_id, agentId, requestId: item.turn_request_id, text: messageText, steps: input.steps});
          if (reply) {
            if (item.state !== 'complete') await endAgentTurn(db, item, 'complete', null, reply.id);
            suppressedFinal = true;
            completedNow = true;
            return { ...receipt, id: reply.id, messageId: reply.id, createdAt: Math.floor(new Date(reply.created_at).getTime() / 1000),
              completed: true, published: true, delivered: true, stored: true, visible: true };
          }
        }
        const existing = input.sharedReplyId;
        const saved = existing ? {id: existing, stored: true, visible: true} : await queueMessage(db,{
          kind:'post',roomId:item.room_id,authorId:agentId,text:modelText(messageText),agentIds:[],
          id:outputId,parent:item,requestId:item.turn_request_id,commandRoomId:item.room_id,attachments:files,
          allowArchivedPost: item.room_archived && item.self_closed,
          // Native closing output quotes the recorded wake. An addressed post can choose its quote.
          replyTo:(input.publicPost ? input.replyToMessageId : undefined) ?? item.source_message_id ?? item.id,
        });
        if (!saved.stored) {
          const {receipt: warning, woken, notWoken} = saved as QueuedPostReceipt;
          return {...receipt, stored: false, visible: false, answered: false, receipt:warning, woken, notWoken};
        }
        if (existing && item.state === 'complete')
          return {...receipt, id:existing, messageId:existing, published:true, stored:true, visible:true, delivered:true};
        if (input.sharedReplyId && files.length) await db.query("UPDATE agent_commands SET answer_attachments='[]' WHERE id=$1",[item.id]);
        const ended = await endAgentTurn(db,item,'complete',null,saved.id);
        if (ended) await wakePeerMessageSender(db,item,{kind:'answer',outputId:saved.id,text:messageText,attachments:files,batchCommandIds:input.batchCommandIds,invocationId:input.invocationId ?? input.invocation?.id});
        completedNow = true;
        return {...saved, commandId:item.id, messageId:saved.id, completed:true, published:true, delivered:true};
      }
      const scheduleReply = item.reason === 'schedule' ? replyableWake(item) : undefined;
      if (!scheduleReply && (item.message?.authorId === SYSTEM_IDENTITY_ID || payload?.authorId === SYSTEM_IDENTITY_ID ||
        (await deliveredMessageRoute(db,item)).from.agent === SYSTEM_IDENTITY_ID))
        refuseMessageMembership('Quote a message that woke this turn.');
      const to = (await recordedMessageRoute(db,item)).from;
      if (to.agent === SYSTEM_IDENTITY_ID) refuseMessageMembership('Quote a message that woke this turn.');
      if ((await db.query('SELECT 1 FROM rooms WHERE id=$1 AND archived_at IS NOT NULL',[to.place])).rowCount) {
        refuseMessageMembership('return address archived');
      }
      if (!messageText && !input.messageAsk)
        return {commandId:item.id,completed:false,published:false,answered:false,
          queued:false,stored:false,visible:false,destination:to};
      const from = {agent:agentId,place:item.room_id};
      const id = hash(`answer:${item.id}:${to.place}:${to.agent}:${messageText}:${JSON.stringify(input.messageAsk ?? null)}`);
      const saved = await sendMessage(db,{route:{from,to},text:messageText,ask:input.messageAsk,id,parent:item,replyTo:scheduleReply?.id ?? item.source_message_id ?? item.id});
      if (!saved.stored || !saved.messageId)
        return {...saved, commandId:item.id, completed:false, published:false, answered:false};
      await db.query('UPDATE agent_commands SET reply_tool_message_id=$2 WHERE id=$1',[item.id,saved.messageId]);
      if (item.state === 'complete') await db.query('UPDATE agent_commands SET result_message_id=$2 WHERE id=$1',[item.id,saved.messageId]);
      else await endAgentTurn(db,item,'complete',null,saved.messageId);
      completedNow = true;
      return {...saved, deliveryCommandId:'commandId' in saved ? saved.commandId : undefined, commandId:item.id, completed:true, published:true, delivered:true};
    }
    const saved = await queueMessage(db,{kind:'post',roomId:input.roomId,authorId:agentId,
      text:modelText(messageText),agentIds:[],id:input.messageId ?? hash(`local-final:${agentId}:${input.roomId}:${input.requestId ?? ''}`),
      requestId:input.requestId,replyTo:input.replyToMessageId,attachments:input.outputFiles});
    completedNow = saved.stored;
    const {id,createdAt,stored,visible,receipt,woken,notWoken} = saved;
    return { ...(stored ? {id,messageId:id,createdAt} : {}), stored, visible, receipt, woken, notWoken,
      completed:false,published:stored,delivered:stored };
  });
  // Optional history and cleanup cannot hold the committed publication receipt.
  const messageId = published.messageId;
  if (completedNow) {
    const after=()=>Promise.all([
        ...(messageId && !suppressedFinal ? [
          observeQueuedAnswer(database,messageId,agentId).catch(error=>console.warn('[answer] optional onboarding observation omitted:',error)),
          recordStarPromptReply(database,{roomId:input.roomId,agentId,requestId:input.requestId ?? '',messageId})
            .catch(error=>console.warn('[answer] optional star reply counter omitted:',error)),
          recordAnswerActivity(database,agentId,messageId,input).catch(error=>console.warn('[answer] optional activity omitted:',error)),
        ] : []),
        database.query(`SELECT beeline_record_agent_answer(id,false,NULL) FROM agent_commands
          WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3`,[input.roomId,agentId,input.requestId ?? null])
          .catch(error=>console.warn('[answer] optional turn status omitted:',error)),
        database.query('DELETE FROM agent_pending_attachments WHERE room_id=$1 AND agent_id=$2 AND request_id=$3',
          [input.roomId,agentId,input.requestId ?? null]).catch(error=>console.warn('[answer] optional media cleanup omitted:',error)),
      ]).then(()=>undefined);
    const background=CornerAccessDatabase.physical(database).backgroundWork;
    if (background) background.run(after); else void after();
  }
  return published;
}

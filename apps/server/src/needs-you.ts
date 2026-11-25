import { permissionDeciderSql } from './permission-decider.js';
import { humanReportCornerSql } from './corner-waiting-report.js';
import { messageColumns } from './message-columns.js';
import { squireApprovalAction, workflowGateOptionLabel } from '@beeline/api-contract/phone';
import { approvalAsk } from './tray-approval-ask.js';
import {
  AGENT_SIGN_IN_SERVICE_LABELS,
  plainAsk,
  shortenAsk,
  CHOICE_CARD_TYPE,
  type AgentSignInHarness,
  type AttachmentReference,
  type NeedsYouApprovalKind,
  type NeedsYouApprovalView,
  type NeedsYouActionView,
  type NeedsYouItemView,
  type RoomViewIdentity,
} from '@beeline/api-contract/phone';
import { AGENT_GRANT_VERBS, commandGrantAction, grantPresentation, connectionInstallName, isCommandGrantScript, type AgentGrantKind, type CommandGrantScript } from '@beeline/api-contract/agent-grants';
import type { SqlDatabase } from './database.js';

/**
 * The "Needs you" tray, owned here and nowhere else.
 *
 * Needs you holds an exact personal tag from another person, a question-builder
 * ask assigned to them (`work_questions`), a blocked or needs-decision report
 * addressed to them as
 * commander (`card.reportToId`), and a pending approval card they can decide
 * (`approvalBranches`), shown as text (`NeedsYouApprovalView`). Agent mentions
 * and untargeted wording never qualify.
 *
 * Open report/person-tag records are written with the message; reads join
 * only the viewer’s uncleared marks. A record leaves, keeping its
 * `cleared_reason`, only on an event, in that event's transaction: its source
 * thread closes, the same agent sends that person a newer report from that
 * thread, the person answers it (a quote reply or a card answer), the asking agent closes it (`closeAgentAsk`), the message is
 * removed, or the person clears it. Nothing leaves on a timer. An approval
 * leaves when cleared, decided, expired or closed; opening it does not clear it.
 */
/** Why a record left the list; the agent's close tool takes the first three. */
export const AGENT_ASK_CLOSE_REASONS = ['answered', 'withdrawn', 'superseded'] as const;
export type AgentAskCloseReason = (typeof AGENT_ASK_CLOSE_REASONS)[number];
/** Card expiry in epoch milliseconds; indexed by `messages_needs_you_expiry_idx`. */
export function cardExpiresAtSql(card = 'card'): string {
  return `(CASE WHEN ${card}->>'expiresAt' ~ '^[0-9]{1,15}$' THEN (${card}->>'expiresAt')::bigint END)`;
}
/** The approval cards whose only exit is their `expiresAt`. */
export const EXPIRING_CARD_TYPES = `card_type IN ('squire-approval','agent-sign-in')`;
/** Squire approvals reach their owner (legacy DM cards name none); sign-in cards reach their owner. */
export function expiringCardForSql(m: string, identity: string): string {
  return `(${m}.${EXPIRING_CARD_TYPES} AND ${m}.deleted_at IS NULL
    AND ((${m}.card_type='squire-approval' AND (${m}.card->'owner'->>'pubkey' IS NULL
      OR ${m}.card->'owner'->>'pubkey'=${identity})) OR ${m}.card->>'ownerId'=${identity}))`;
}
/** Now, in the epoch milliseconds `cardExpiresAtSql` returns. */
const NOW_MS = `(extract(epoch FROM now())*1000)::bigint`;

export function askSql(cardExpr: string): string {
  return `COALESCE((${cardExpr})->>'reportStatus' IN ('blocked','needs-decision'),false)`;
}

/** Message `m` (or the bare row) is a live report; `messages_needs_you_report_status_idx` indexes it. */
export function askingMessageSql(m?: string): string {
  const column = (name: string) => (m ? `${m}.${name}` : name);
  return `${column('presentation')}='message' AND ${column('deleted_at')} IS NULL
    AND ${askSql(column('card'))}`;
}

function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => plainAsk(line).split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * Prefer a complete question, then the first sentence of an actionable report.
 */
export function needsYouSentence(text: string): string {
  const all = sentences(text).map(plainAsk).filter(Boolean);
  const question = all.find(sentence => sentence.endsWith('?'));
  if (question) return question;
  return all[0] ?? plainAsk(text);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove the tags that addressed the reader: every cell was addressed to them,
 * so repeating their own handle in each row says nothing. Other people's
 * handles stay — "ask @hoots to…" still needs them.
 */
export function withoutReaderTags(sentence: string, readerHandle: string | null): string {
  const handles = ['channel', ...(readerHandle ? [readerHandle.trim().replace(/^@/, '')] : [])]
    .filter(Boolean)
    .map(escapeRegExp);
  const tag = new RegExp(
    `(^|[^\\p{L}\\p{N}_.-])@(?:${handles.join('|')})(?=[.-]*(?:$|[^\\p{L}\\p{N}_.-]))`,
    'giu',
  );
  const stripped = sentence
    .replace(tag, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[\s,.;:—–-]+/u, '')
    .trim();
  return stripped || sentence.trim();
}

/** The whole row text for one tagged message, as the reader sees it. */
export function needsYouRowText(message: string, readerHandle: string | null, ask?: string): string {
  return shortenAsk(withoutReaderTags(ask || needsYouSentence(message), readerHandle));
}

type GrantCardEntry = { machine?: string; grantId?: string; kind?: AgentGrantKind; target?: string; appName?: string; action?: string; reason?: string; purpose?: string; touches?: string; capabilities?: string; script?: CommandGrantScript };

/** The raw card fields the approval rows read; every kind's card is a subset. */
type ApprovalCard = {
  question?: string;
  brief?: string;
  ask?: string;
  agent?: { name?: string; pubkey?: string };
  requester?: { name?: string; pubkey?: string };
  grants?: GrantCardEntry[];
  repository?: string;
  tool?: string;
  purpose?: string;
  approvalPurpose?: string;
  action?: string;
  intent?: 'add' | 'switch' | 'reconnect';
  title?: string;
  detail?: string;
  linkKind?: 'approval' | 'passkey' | 'vouch';
  prompt?: string;
  options?: { optionId?: string; label?: string }[];
  choiceId?: string;
  runId?: string;
  permissionId?: string;
  requestId?: string;
  approvalUrl?: string;
  connectorName?: string;
  reason?: string;
  agentName?: string;
  source?: string;
  harness?: AgentSignInHarness;
  name?: string;
  facts?: unknown;
};

type Row = {
  message_id: string;
  room_id: string;
  room_name: string;
  room_kind: 'room' | 'corner' | 'direct';
  parent_room_name: string | null;
  text: string;
  card: ApprovalCard | null;
  attachments: unknown;
  approval_kind: NeedsYouApprovalKind | null;
  approval_expires_at: Date | null;
  pending_grant_ids: string[] | null;
  actor_name: string | null;
  created_at: Date;
  author_id: string | null;
  author_kind: 'human' | 'agent' | null;
  author_name: string | null;
  author_handle: string | null;
  author_avatar: string | null;
  author_face: string | null;
};

const ROW_COLUMNS = `
  m.id message_id,m.room_id,m.text,m.card,m.attachments,m.created_at,mark.cleared_at,
  CASE WHEN room.direct_participants IS NOT NULL THEN COALESCE((
      SELECT peer.name FROM room_access peer_member
      JOIN identities peer ON peer.id=peer_member.identity_id
      WHERE peer_member.room_id=room.id AND peer_member.identity_id<>$2
        AND peer_member.removed_at IS NULL
      ORDER BY peer_member.joined_at LIMIT 1
    ),room.name) ELSE room.name END room_name,
  CASE WHEN room.direct_participants IS NOT NULL THEN 'direct'
    WHEN room.parent_id IS NOT NULL THEN 'corner' ELSE 'room' END room_kind,
  (SELECT parent.name FROM rooms parent WHERE parent.id=room.parent_id) parent_room_name,
  author.id author_id,author.kind author_kind,author.name author_name,
  beeline_workspace_handle(author.id,room.workspace_id) author_handle,author.avatar author_avatar,author.face_id author_face`;

/** The viewer is a current member of the Workspace. */
export function viewerMemberSql(workspaceId: string, viewerId: string): string {
  return `EXISTS (SELECT 1 FROM memberships workspace_member
  WHERE workspace_member.workspace_id=${workspaceId} AND workspace_member.room_id IS NULL
    AND workspace_member.identity_id=${viewerId} AND workspace_member.removed_at IS NULL)`;
}
const VIEWER_MEMBER = viewerMemberSql('$1', '$2');

const viewerRoomsSql = (columns='room.*',scoped=false)=>`
  viewer_rooms AS (
    SELECT ${columns} FROM room_access room_member
    JOIN rooms room ON room.id=room_member.room_id
    WHERE room_member.identity_id=$2 AND room_member.removed_at IS NULL
      AND room.workspace_id=$1 AND room.archived_at IS NULL
      ${scoped?'AND room.id=ANY($3::uuid[])':''}
      AND ${VIEWER_MEMBER}
  )`;
const VIEWER_ROOMS=viewerRoomsSql();

/** The legacy report rule, used once to backfill the open-item records. */
export function questionForSql(viewerId: string): string {
  return `${askingMessageSql('m')} AND m.author_id<>${viewerId}
    AND m.card->>'reportToId'=${viewerId} AND mark.cleared_at IS NULL
    AND NOT (${needsYouAnsweredSql('m', viewerId)})`;
}

export function questionRecipientSql(message: string, viewerId: string): string {
  return `(EXISTS (SELECT 1 FROM work_questions question JOIN work_items work ON work.id=question.message_id
    WHERE question.message_id=${message}.id AND work.assignee_id=${viewerId})
    OR (NOT EXISTS (SELECT 1 FROM work_questions question JOIN work_items work ON work.id=question.message_id WHERE question.message_id=${message}.id)
      AND EXISTS (SELECT 1 FROM room_choices choice WHERE choice.message_id=${message}.id AND choice.mode='question')
      AND CASE jsonb_array_length(COALESCE(${message}.card->'mentionIds','[]'::jsonb))
        WHEN 0 THEN ${message}.card->'requester'->>'pubkey'=${viewerId}
        ELSE COALESCE(${message}.card->'mentionIds','[]'::jsonb) ? ${viewerId} END))`;
}

/** One answer rule for write-time clearing and the legacy backfill. */
export function needsYouAnsweredSql(message: string, viewerId: string): string {
  const question = `(EXISTS (SELECT 1 FROM work_questions question WHERE question.message_id=${message}.id)
    OR EXISTS (SELECT 1 FROM room_choices choice WHERE choice.message_id=${message}.id AND choice.mode='question'))`;
  return `(EXISTS (
    SELECT 1 FROM messages reply
    WHERE reply.reply_to_message_id=ANY(CASE WHEN ${message}.block_corner_id IS NOT NULL OR ${message}.block_parent_id IS NOT NULL
      THEN block_reply_items(${message}.id) ELSE ARRAY[${message}.id] END)
      AND (reply.author_id=${viewerId} OR (${question}
        AND EXISTS (SELECT 1 FROM needs_you_marks recipient WHERE recipient.message_id=${message}.id
          AND recipient.identity_id=reply.author_id)))
      AND (reply.presentation='message' OR ((${message}.block_corner_id IS NOT NULL OR ${message}.block_parent_id IS NOT NULL)
        AND reply.card_type='agent-command')) AND reply.system_event IS NULL AND reply.deleted_at IS NULL
      AND reply.created_at>COALESCE(${message}.block_reasked_at,${message}.created_at)
  ) OR (${question} AND EXISTS (SELECT 1 FROM needs_you_marks answered
    WHERE answered.message_id=${message}.id AND answered.cleared_at IS NOT NULL AND answered.cleared_reason='answered'
      AND (${message}.block_reasked_at IS NULL OR answered.cleared_at>${message}.block_reasked_at)))
    OR EXISTS (SELECT 1 FROM room_choices choice WHERE choice.message_id=${message}.id
    AND choice.mode='question' AND choice.status='answered'
    AND (${message}.block_reasked_at IS NULL OR EXISTS (SELECT 1 FROM room_choice_votes vote
      WHERE vote.choice_id=choice.id AND vote.updated_at>${message}.block_reasked_at))))`;
}

/** The thread id `humanReportCornerSql` names, or NULL when it is not a uuid. */
function reportThreadIdSql(message: string): string {
  const thread = humanReportCornerSql(message);
  return `(CASE WHEN ${thread} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (${thread})::uuid END)`;
}

/** The asking message's source thread is archived. */
function sourceClosedSql(message: string): string {
  return `EXISTS (SELECT 1 FROM rooms source WHERE (source.id=${reportThreadIdSql(message)} OR source.id=${message}.room_id)
    AND source.archived_at IS NOT NULL)`;
}

/** A report from an agent, whatever its status. */
export function agentReportSql(message: string): string {
  return `(${message}.presentation='message' AND ${message}.deleted_at IS NULL AND ${message}.card->>'reportToId' IS NOT NULL
    AND ${message}.card->>'reportStatus' IN ('blocked','needs-decision','done','failed'))`;
}

/**
 * `newer` replaces `message` for `viewerId`: the same agent's later report to
 * them from the same thread. A chat or DM is not a thread, so separate asks
 * raised there stand on their own.
 */
export function supersedesSql(newer: string, message: string, viewerId: string): string {
  return `(${newer}.author_id=${message}.author_id AND ${newer}.card->>'reportToId'=${viewerId}
    AND (${newer}.created_at,${newer}.id)>(${message}.created_at,${message}.id)
    AND reply_block_root(${newer}.reply_to_message_id) IS DISTINCT FROM ${message}.id
    AND ${agentReportSql(newer)} AND ${humanReportCornerSql(newer)}=${humanReportCornerSql(message)}
    AND EXISTS (SELECT 1 FROM rooms thread WHERE thread.id=${reportThreadIdSql(message)} AND thread.parent_id IS NOT NULL))`;
}

/**
 * Why an open record has already left, or NULL. The write-time triggers apply
 * the same rules as their events commit; the Tasks read applies them to rows
 * written before those triggers existed.
 */
export function settledMarkReasonSql(message: string, viewerId: string): string {
  return `CASE WHEN ${message}.ask_closed_reason IS NOT NULL THEN ${message}.ask_closed_reason
    WHEN ${sourceClosedSql(message)} THEN 'source-closed'
    WHEN EXISTS (SELECT 1 FROM messages newer WHERE ${supersedesSql('newer', message, viewerId)}) THEN 'superseded'
    WHEN ${needsYouAnsweredSql(message, viewerId)} THEN 'answered'
    WHEN EXISTS (SELECT 1 FROM room_choices choice WHERE choice.message_id=${message}.id
      AND choice.mode='question' AND choice.status IN ('skipped','closed')) THEN 'withdrawn' END`;
}

/** Open records leave only on an event; none expires. */
const QUESTION_WHERE = `mark.cleared_at IS NULL AND m.deleted_at IS NULL
  AND ((m.presentation='message'
    AND NOT EXISTS (SELECT 1 FROM work_questions question WHERE question.message_id=m.id)
    AND NOT EXISTS (SELECT 1 FROM room_choices choice WHERE choice.message_id=m.id AND choice.mode='question'))
    OR ${questionRecipientSql('m', 'mark.identity_id')}
    OR (m.block_reasked_at IS NOT NULL AND m.card->>'reportToId'=mark.identity_id))`;

/** Clear every current question. */
export async function clearNeedsYouQuestions(
  database: SqlDatabase,
  workspaceId: string,
  viewerId: string,
): Promise<void> {
  await database.query(
    `WITH ${VIEWER_ROOMS}
     UPDATE needs_you_marks mark SET cleared_at=now(),cleared_reason='manual',
       reminder_dismissed_at=COALESCE(mark.reminder_dismissed_at,now())
     FROM messages m JOIN viewer_rooms room ON room.id=m.room_id
     WHERE mark.identity_id=$2 AND mark.workspace_id=$1 AND mark.message_id=m.id
       AND ${QUESTION_WHERE}`,
    [workspaceId, viewerId],
  );
}

/** The viewer ($2) manages the Workspace ($1). */
const VIEWER_MANAGES_WORKSPACE = `EXISTS (
  SELECT 1 FROM memberships manager
  WHERE manager.workspace_id=$1 AND manager.room_id IS NULL AND manager.identity_id=$2
    AND manager.removed_at IS NULL AND manager.role IN ('owner','admin'))`;

type CandidateProjection='cells'|'count'|'order';
const candidateColumns=(projection:CandidateProjection)=>projection==='cells'?ROW_COLUMNS:
  'm.id message_id,m.card,mark.cleared_at'+(projection==='order'?',m.created_at':'');
function approvalBranches(projection:CandidateProjection):readonly string[]{
const columns=candidateColumns(projection);
const APPROVAL_FROM = (
  kind: NeedsYouApprovalKind,
  expiresAt = 'NULL::timestamptz',
  actorName = 'NULL::text',
) => `
  SELECT ${columns},'${kind}' approval_kind,${expiresAt} approval_expires_at,
    NULL::text[] pending_grant_ids,${projection==='cells'?actorName:'NULL::text'} actor_name
  FROM viewer_rooms room`;

const APPROVAL_JOINS = `
  ${projection==='cells'?'LEFT JOIN identities author ON author.id=m.author_id':''}
  LEFT JOIN needs_you_marks mark ON mark.identity_id=$2 AND mark.message_id=m.id`;

/**
 * One branch per approval kind, each driven from that kind's pending rows and
 * filtered by the rule the decide operation itself enforces, so the tray
 * never offers a card the viewer cannot decide. Sign-in and Squire cards
 * are read through `messages_needs_you_approval_idx`; Squire's stored expiry
 * bounds their life even if a decision never arrives.
 */
return [
  // Free-text asks use ordinary reply/choice actions.
  `SELECT ${columns},'choice' approval_kind,NULL::timestamptz approval_expires_at,
     NULL::text[] pending_grant_ids,NULL::text actor_name
   FROM viewer_rooms room
   JOIN work_questions work_question ON work_question.room_id=room.id
   JOIN work_items work ON work.id=work_question.message_id AND work.assignee_id=$2
   JOIN messages m ON m.id=work_question.message_id AND m.card_type IS DISTINCT FROM '${CHOICE_CARD_TYPE}'
   ${APPROVAL_JOINS}
   WHERE m.deleted_at IS NULL AND mark.message_id IS NOT NULL AND mark.cleared_at IS NULL
     AND (${settledMarkReasonSql('m', '$2')}) IS NULL`,
  // Driven from the few pending grants rather than from the transcript, so
  // an old undecided card costs nothing to find. The decider rule is
  // `requireGrantAuthority`'s: the agent's owner for a personal resource, a
  // Workspace owner/admin for a repository.
  `SELECT ${columns},'grant' approval_kind,NULL::timestamptz approval_expires_at,
     ARRAY(SELECT entry->>'grantId' FROM jsonb_array_elements(m.card->'grants') entry
       WHERE entry->>'grantId' IN (SELECT grant_id FROM decidable)) pending_grant_ids,
     NULL::text actor_name
   FROM viewer_rooms room
   JOIN messages m ON m.room_id=room.id AND m.card_type='grant-request'
   ${APPROVAL_JOINS}
   WHERE EXISTS (SELECT 1 FROM decidable) AND m.deleted_at IS NULL
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(m.card->'grants') entry
       WHERE entry->>'grantId' IN (SELECT grant_id FROM decidable)
     )`,
  // `decidePermission`: the spending agent's owner for Squire spending;
  // otherwise the person the agent asked, or a Workspace manager.
  // Deciding posts a second card; only the original one still says pending.
  `${APPROVAL_FROM('write-access')}
   JOIN permission_authority permission ON permission.room_id=room.id
     AND permission.status='pending'
   CROSS JOIN LATERAL (
     SELECT ${messageColumns('m')} FROM messages m WHERE m.room_id=room.id AND m.card_type='permission'
       AND m.card->>'permissionId'=permission.permission_id AND m.card->>'status'='pending'
       AND m.deleted_at IS NULL OFFSET 0
   ) m
   ${APPROVAL_JOINS}
   WHERE ${permissionDeciderSql('permission', 'm.card', '$1', '$2')}`,
  // An open question addressed to the viewer: tagged, or asked of its
  // requester when it tags nobody (`addressedToPersonSql`'s reading).
  `${APPROVAL_FROM('choice', 'choice.closes_at')}
   JOIN room_choices choice ON choice.room_id=room.id AND choice.status='open'
     AND choice.mode='question' AND (choice.closes_at IS NULL OR choice.closes_at>now())
   JOIN messages m ON m.id=choice.message_id AND m.room_id=room.id AND m.card_type='${CHOICE_CARD_TYPE}'
   ${APPROVAL_JOINS}
   WHERE m.deleted_at IS NULL AND mark.message_id IS NOT NULL AND mark.cleared_at IS NULL
     AND (${settledMarkReasonSql('m', '$2')}) IS NULL
     AND ${questionRecipientSql('m', '$2')}`,
  // `acceptConnectorOffer`: the addressee, or a Workspace manager except for
  // a wallet, which only its addressee may accept.
  `${APPROVAL_FROM('connector')}
   JOIN connector_offers offer ON offer.room_id=room.id AND offer.status='pending'
   JOIN messages m ON m.id=offer.message_id AND m.room_id=room.id
   ${APPROVAL_JOINS}
   WHERE m.deleted_at IS NULL
     AND (offer.addressee_id=$2
       OR (offer.connector_type<>'wallet' AND ${VIEWER_MANAGES_WORKSPACE}))`,
  // A sign-in only its owner can finish, while it still waits on them.
  `${APPROVAL_FROM(
     'sign-in',
     `to_timestamp(${cardExpiresAtSql('m.card')}/1000.0)`,
     `(SELECT signing_in.name FROM identities signing_in WHERE signing_in.id=m.card->>'agentId')`,
   )}
   JOIN messages m ON m.room_id=room.id
     AND m.card_type IN ('agent-sign-in','app-sign-in')
   ${APPROVAL_JOINS}
   WHERE m.deleted_at IS NULL AND m.card->>'ownerId'=$2
     AND CASE m.card_type
       WHEN 'agent-sign-in' THEN CASE WHEN ${expiringCardForSql('m', '$2')}
         AND m.card->>'status' IN ('starting','pending') THEN
         (${cardExpiresAtSql('m.card')} IS NULL OR ${cardExpiresAtSql('m.card')}>${NOW_MS}) ELSE false END
       ELSE m.card->>'status'='pending'
     END`,
  // A Trusty Squire approval at its call site or in the owner's @System DM. Squire decides it;
  // the decision (or Squire's expiry) lands in the Room the paused turn ran in.
  `${APPROVAL_FROM('squire', `to_timestamp(${cardExpiresAtSql('m.card')}/1000.0)`)}
   JOIN messages m ON m.room_id=room.id AND m.card_type='squire-approval'
   ${APPROVAL_JOINS}
   WHERE ${expiringCardForSql('m', '$2')} AND m.card->>'approvalId' IS NOT NULL
     AND COALESCE(m.card->>'status','pending') NOT IN ('approved','denied','expired')
     AND ${cardExpiresAtSql('m.card')}>${NOW_MS}
     AND NOT EXISTS (
       SELECT 1 FROM messages decision JOIN rooms decision_room ON decision_room.id=decision.room_id
       WHERE decision_room.workspace_id=$1
         AND decision.card_type='squire-approval-decision'
         AND decision.card->>'approvalId'=m.card->>'approvalId'
         AND decision.card->>'agentId'=m.card->'agent'->>'pubkey'
     )`,
];
}

/**
 * Whether `identityExpr` may decide the grant row `grant`: the agent's owner
 * for a personal resource, a Workspace owner/admin for a repository (the
 * `requireGrantAuthority` rule).
 */
export function grantDecidedBySql(grant: string, identityExpr: string): string {
  return `CASE WHEN ${grant}.kind IN ('repository','shared_asset') THEN EXISTS (
      SELECT 1 FROM memberships manager
      WHERE manager.workspace_id=${grant}.workspace_id AND manager.room_id IS NULL
        AND manager.identity_id=${identityExpr} AND manager.removed_at IS NULL
        AND (manager.role IN ('owner','admin') OR
          (${grant}.kind='shared_asset' AND EXISTS (
            SELECT 1 FROM agents a WHERE a.agent_id=${grant}.agent_id
              AND a.owner_id=${identityExpr}))))
    WHEN ${grant}.kind='mcp' AND ${grant}.target LIKE 'connection-install:%'
      AND ${grant}.app_id IS NOT NULL THEN EXISTS (
      SELECT 1 FROM workspace_apps app WHERE app.id=${grant}.app_id
        AND app.owner_identity_id=${identityExpr})
    ELSE EXISTS (
      SELECT 1 FROM agents grant_agent
      WHERE grant_agent.agent_id=${grant}.agent_id AND grant_agent.owner_id=${identityExpr})
    END`;
}

const questionBranch=(projection:CandidateProjection)=>`
  SELECT ${candidateColumns(projection)},NULL::text approval_kind,NULL::timestamptz approval_expires_at,
    NULL::text[] pending_grant_ids,NULL::text actor_name
  FROM open_marks mark
  JOIN messages m ON m.id=mark.message_id
  JOIN viewer_rooms room ON room.id=m.room_id
  ${projection==='cells'?'LEFT JOIN identities author ON author.id=m.author_id':''}
  WHERE ${QUESTION_WHERE} AND (m.presentation='message' OR (m.block_reasked_at IS NOT NULL AND m.card_type='${CHOICE_CARD_TYPE}' AND m.card->>'status'='answered'))
    AND (NOT EXISTS (SELECT 1 FROM work_questions question WHERE question.message_id=m.id) OR (m.block_reasked_at IS NOT NULL AND m.card_type='${CHOICE_CARD_TYPE}' AND m.card->>'status'='answered'))
`;

/** The same authorized candidates drive the tray and its badge. */
const needsYouCandidates=(projection:CandidateProjection,scoped=false)=>`WITH ${viewerRoomsSql(projection==='cells'?'room.*':'room.id',scoped)},
  ${projection==='cells'&&!scoped?`retired_marks AS (
    UPDATE needs_you_marks mark SET cleared_at=now(),cleared_reason=${settledMarkReasonSql('m', 'mark.identity_id')}
    FROM messages m WHERE mark.message_id=m.id AND mark.identity_id=$2 AND mark.workspace_id=$1
      AND mark.cleared_at IS NULL AND ${VIEWER_MEMBER}
      AND (${settledMarkReasonSql('m', 'mark.identity_id')}) IS NOT NULL
    RETURNING mark.message_id
  ),`:''}
  open_marks AS MATERIALIZED (
    SELECT mark.* FROM needs_you_marks mark JOIN messages m ON m.id=mark.message_id
    WHERE mark.identity_id=$2 AND mark.workspace_id=$1 AND mark.cleared_at IS NULL
      AND (${settledMarkReasonSql('m', 'mark.identity_id')}) IS NULL
  ),
  decidable AS (
    SELECT grant_row.id::text grant_id FROM agent_grants grant_row
    WHERE grant_row.workspace_id=$1 AND grant_row.status='pending' AND grant_row.superseded_at IS NULL
      AND ${grantDecidedBySql('grant_row', '$2')}
  ),
  candidates AS (
    SELECT questions.* FROM (${questionBranch(projection)}) questions
    UNION ALL
    ${approvalBranches(projection).join('\n    UNION ALL\n')}
  )`;
const NEEDS_YOU_CANDIDATES=needsYouCandidates('cells');
const NEEDS_YOU_COUNT_CANDIDATES=needsYouCandidates('count');
/** Match approvalView's subject and tray dismissal rules before counting or painting. */
const VISIBLE_CANDIDATE = `(approval_kind IS NULL OR cleared_at IS NULL) AND CASE approval_kind
  WHEN 'grant' THEN EXISTS (
    SELECT 1 FROM (
      SELECT entry FROM jsonb_array_elements(COALESCE(card->'grants','[]'::jsonb))
        WITH ORDINALITY AS grant_entry(entry, position)
      WHERE entry->>'grantId'=ANY(pending_grant_ids)
      ORDER BY position LIMIT 1
    ) first_grant
    WHERE NULLIF(first_grant.entry->>'kind','') IS NOT NULL
      AND NULLIF(first_grant.entry->>'target','') IS NOT NULL)
  WHEN 'write-access' THEN NULLIF(btrim(CASE WHEN card->>'purpose'='squire-spending'
    THEN card->>'tool' ELSE card->>'repository' END),'') IS NOT NULL
  WHEN 'choice' THEN NULLIF(btrim(card->>'prompt'),'') IS NOT NULL
  WHEN 'connector' THEN NULLIF(btrim(card->>'connectorName'),'') IS NOT NULL
  WHEN 'sign-in' THEN CASE WHEN card->>'harness' IS NOT NULL
    THEN card->>'harness' IN (${Object.keys(AGENT_SIGN_IN_SERVICE_LABELS)
      .map((value) => `'${value}'`)
      .join(',')})
    ELSE NULLIF(btrim(card->>'name'),'') IS NOT NULL END
  WHEN 'squire' THEN NULLIF(btrim(card->>'title'),'') IS NOT NULL
  ELSE true END`;

/** Count all eligible questions and approvals without building cell DTOs. */
export async function countNeedsYouItems(
  database: SqlDatabase,
  workspaceId: string,
  viewerId: string,
): Promise<{ count: number; nextExpiry?: number }> {
  const result = await database.query<{ count: string; next_expiry: number | null; authorized: boolean }>(
    `${NEEDS_YOU_COUNT_CANDIDATES}
     SELECT count(*)::text count,
       min(extract(epoch FROM approval_expires_at)*1000)::double precision next_expiry,${VIEWER_MEMBER} authorized
     FROM candidates WHERE ${VISIBLE_CANDIDATE}`,
    [workspaceId, viewerId],
  );
  if (!result.rows[0]?.authorized) throw new Error('workspace membership required');
  const row=result.rows[0]!;
  return {count:Number(row.count),...(row.next_expiry!==null?{nextExpiry:row.next_expiry}:{})};
}

/** The existing aggregate count boundary returns only the complete server
 * order, never unaffected Room cell bodies. Cells are read by exact scope. */
export async function readNeedsYouOrder(database:SqlDatabase,workspaceId:string,viewerId:string){
  const result=await database.query<{ids:string[];authorized:boolean}>(
    `${needsYouCandidates('order')}
     SELECT COALESCE(array_agg(message_id ORDER BY (approval_kind IS NULL),
       floor(extract(epoch FROM approval_expires_at)) NULLS LAST,
       floor(extract(epoch FROM created_at)*1000),message_id COLLATE "C"),'{}'::text[]) ids,
       ${VIEWER_MEMBER} authorized FROM candidates WHERE ${VISIBLE_CANDIDATE}`,[workspaceId,viewerId]);
  const row=result.rows[0];
  if(!row?.authorized)throw new Error('workspace membership required');
  return {count:row.ids.length,order:row.ids};
}

/** Complete rows, persisting legacy retirement. */
export async function needsYouItems(database: SqlDatabase, workspaceId: string, viewerId: string, toIdentity: (row: {
    id: string;
    kind: 'human' | 'agent';
    name: string;
    handle: string | null;
    avatar: string | null;
    face_id: string | null;
  }) => RoomViewIdentity,
  roomIds?:readonly string[],
  /** Resolves a relative attachment URL for the card's image. */
  publicOrigin = '',
): Promise<{ items: NeedsYouItemView[]; nextExpiry?: number }> {
  const result = await database.query<Row & {
    viewer_handle: string | null;
    authorized: boolean;
  }>(
    `${roomIds?needsYouCandidates('cells',true):NEEDS_YOU_CANDIDATES},
     visible AS MATERIALIZED (SELECT candidates.* FROM candidates WHERE ${VISIBLE_CANDIDATE})
     SELECT visible.*,viewer.handle viewer_handle,access.authorized
     FROM (SELECT ${VIEWER_MEMBER} authorized) access
     LEFT JOIN visible ON true
     LEFT JOIN identities viewer ON viewer.id=$2`,
    roomIds?[workspaceId, viewerId, roomIds]:[workspaceId, viewerId], 'phone-tray-needs-0',
  );
  if (!result.rows[0]?.authorized) throw new Error('workspace membership required');
  const built = result.rows.filter((row) => row.message_id).flatMap((row) => {
    const view = row.approval_kind ? approvalView(row, viewerId) : undefined;
    const image = view ? askingImage(row.attachments, publicOrigin) : undefined;
    const approval = view && image ? { ...view, image } : view;
    if (row.approval_kind && !approval) return [];
    const expiresAt = row.approval_kind && row.approval_expires_at
      ? Math.floor(row.approval_expires_at.getTime() / 1000)
      : undefined;
    return [{ row, approval, expiresAt }];
  });
  // Approvals before questions; within each, the soonest to expire, then the oldest.
  built.sort(
    (left, right) =>
      Number(!left.approval) - Number(!right.approval) ||
      (left.expiresAt ?? Infinity) - (right.expiresAt ?? Infinity) ||
      left.row.created_at.getTime() - right.row.created_at.getTime() ||
      (left.row.message_id < right.row.message_id ? -1 : 1),
  );
  const approvalTypes: Record<NeedsYouApprovalKind, string> = {
    grant: 'grant-request', 'write-access': 'permission', choice: 'choice',
    connector: 'connector-offer', 'sign-in': 'app-sign-in', squire: 'squire-approval',
  };
  const items = built.map(({ row, approval, expiresAt }): NeedsYouItemView => ({
    messageId: row.message_id,
    workspaceId,
    roomId: row.room_id,
    roomName: row.room_name,
    roomKind: row.room_kind,
    ...(row.parent_room_name ? { parentRoomName: row.parent_room_name } : {}),
    text: approval
      ? approvalAsk(approval.kind === 'sign-in' && row.card?.harness ? 'agent-sign-in' : approvalTypes[approval.kind],
          approval.kind === 'grant'
            ? { ...row.card, grants: row.card?.grants?.filter(entry => entry.grantId && row.pending_grant_ids?.includes(entry.grantId)) }
            : row.card ?? {}) ?? approval.subject
      : [typeof row.card?.question === 'string' ? row.card.question : needsYouRowText(row.text, row.viewer_handle, typeof row.card?.ask === 'string' ? row.card.ask : undefined),
          ...(typeof row.card?.brief === 'string' ? [row.card.brief] : [])].join('\n\n'),
    createdAt: Math.floor(row.created_at.getTime() / 1000),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(row.author_id && row.author_kind && row.author_name
      ? {
          author: toIdentity({
            id: row.author_id,
            kind: row.author_kind,
            name: row.author_name,
            handle: row.author_handle,
            avatar: row.author_avatar,
            face_id: row.author_face,
          }),
        }
      : {}),
    ...(approval ? { approval } : {}),
  }));
  const nextExpiry=built.reduce((next,{row})=>Math.min(next,
    (row.approval_kind?row.approval_expires_at?.getTime():undefined)??Infinity),Infinity);
  return { items, ...(Number.isFinite(nextExpiry)?{nextExpiry}:{}) };
}

/** The asking message's first image, with a relative URL made absolute. */
function askingImage(attachments: unknown, publicOrigin: string): AttachmentReference | undefined {
  const absolute = (url: unknown) => typeof url === 'string' && url.startsWith('/') && publicOrigin
    ? `${publicOrigin}${url}` : url;
  for (const value of Array.isArray(attachments) ? attachments : []) {
    const attachment = value as Partial<AttachmentReference> | null;
    const url = absolute(attachment?.url);
    if (!attachment || typeof url !== 'string' || !/^https?:\/\//.test(url) ||
      typeof attachment.mimeType !== 'string' || !attachment.mimeType.startsWith('image/') ||
      typeof attachment.name !== 'string' || typeof attachment.size !== 'number') continue;
    const previewUrl = absolute(attachment.previewUrl);
    const thumbnailUrl = absolute(attachment.thumbnailUrl);
    return {
      ...attachment, url, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size,
      ...(typeof previewUrl === 'string' ? { previewUrl } : {}),
      ...(typeof thumbnailUrl === 'string' ? { thumbnailUrl } : {}),
    };
  }
  return undefined;
}

/**
 * One approval card as the tray's text row, or nothing when the card lacks
 * what the row needs. The verb carries the kind (`wants to run`,
 * `wants to open an edit corner`), so the row needs no type label.
 */
function approvalView(
  row: Pick<Row, 'approval_kind' | 'card' | 'pending_grant_ids' | 'actor_name' | 'author_name'>,
  viewerId: string,
): NeedsYouApprovalView | undefined {
  const card = row.card ?? {};
  const text = (value: string | null | undefined) =>
    value?.replace(/\s+/g, ' ').trim() || undefined;
  const actor =
    text(card.agent?.name) ??
    text(card.agentName) ??
    text(row.actor_name) ??
    text(row.author_name) ??
    'An agent';
  // The person who asked the agent, named only when that is someone else.
  const forName =
    card.requester?.pubkey && card.requester.pubkey !== viewerId
      ? text(card.requester.name)
      : undefined;
  const view = (
    kind: NeedsYouApprovalKind,
    ask: string,
    subject: string | undefined,
    literal: boolean,
    detail?: string,
    requestedFor?: string,
  ): NeedsYouApprovalView | undefined =>
    subject
      ? {
          kind,
          actor,
          ask,
          subject,
          literal,
          ...(detail ? { detail } : {}),
          ...(requestedFor ? { forName: requestedFor } : {}),
        }
      : undefined;
  switch (row.approval_kind) {
    case 'grant': {
      const pending = (card.grants ?? []).filter(
        (entry) => entry.grantId && (row.pending_grant_ids ?? []).includes(entry.grantId),
      );
      const first = pending[0];
      if (!first?.kind || !first.target) return undefined;
      const more = pending.length > 1 ? ` (and ${pending.length - 1} more)` : '';
      const appName = connectionInstallName({ kind: first.kind, target: first.target, appName: first.appName });
      const result = view(
        'grant',
        appName ? 'wants to connect' : first.kind === 'command' ? 'wants to' : `wants to ${AGENT_GRANT_VERBS[first.kind] ?? 'use'}`,
        first.kind === 'command' ? commandGrantAction(first) : appName ?? first.target,
        first.kind !== 'command' && !appName,
        text(`${first.purpose ?? first.reason ?? ''}${more}`),
        forName,
      );
      if (!result || !first.grantId) return result;
      return { ...result,
        ...grantPresentation({ ...first, kind: first.kind, target: first.target }),
        ...(isCommandGrantScript(first.script) ? { script: first.script } : {}),
        actions: first.kind === 'command' ? [
          { kind: 'grant', label: 'Always', grantId: first.grantId, decision: 'always' },
          { kind: 'grant', label: 'Once', grantId: first.grantId, decision: 'once' },
          { kind: 'grant', label: 'Deny', grantId: first.grantId, decision: 'deny' },
        ] : [
          ...(first.kind === 'shared_asset' ? [] : [{ kind: 'grant' as const, label: 'Once', grantId: first.grantId, decision: 'once' as const }]),
          { kind: 'grant', label: 'Always', grantId: first.grantId, decision: 'always' },
          { kind: 'grant', label: 'No', grantId: first.grantId, decision: 'deny' },
        ],
      };
    }
    case 'write-access': {
      const result = card.purpose === 'squire-spending'
        ? view('write-access', 'wants to spend with', 'Trusty Squire', false, text(card.reason), forName)
        : view(
            'write-access',
            'wants to open an edit corner',
            text(card.repository),
            true,
            text(card.reason),
            forName,
          );
      if (!result || !card.permissionId || !card.requestId || !card.agent?.pubkey || typeof card.repository !== 'string') return result;
      const action = { kind: 'write-access' as const, permissionId: card.permissionId,
        requestId: card.requestId, agentId: card.agent.pubkey, repository: card.repository };
      return { ...result, actions: [
        { ...action, label: card.purpose === 'squire-spending' ? 'Allow once' : 'Allow', decision: 'allow' },
        { ...action, label: 'No', decision: 'deny' },
      ] };
    }
    case 'choice': {
      // A workflow gate's outcome key (approve_all) reads as words; an ask keeps its own label.
      const optionLabel = (label: string) => card.runId ? workflowGateOptionLabel(label) : label;
      const result = view(
        'choice',
        'asks you to choose',
        text(card.prompt),
        false,
        text(
          (card.options ?? [])
            .map((option) => text(optionLabel(option.label ?? '')))
            .filter(Boolean)
            .join(' · '),
        ),
      );
      if (!result || !card.choiceId) return result;
      const actions: NeedsYouActionView[] = (card.options ?? []).flatMap(option =>
        option.optionId && option.label ? [{ kind: 'choice' as const, choiceId: card.choiceId!,
          optionId: option.optionId,
          label: optionLabel(option.label) }] : []);
      // A workflow default is already one of its explicit outcomes. Skipping
      // would apply that outcome, whereas dismissing only hides the tray row.
      if (!card.runId) actions.push({ kind: 'skip-choice', choiceId: card.choiceId, label: 'Skip' });
      return { ...result, actions };
    }
    case 'connector':
      return view(
        'connector',
        `wants to ${card.intent === 'switch' ? 'switch' : card.intent === 'reconnect' ? 'reconnect' : 'add'}`,
        text(card.connectorName),
        false,
        text(card.reason),
      );
    case 'sign-in':
      return view(
        'sign-in',
        'needs you to sign in to',
        card.harness ? AGENT_SIGN_IN_SERVICE_LABELS[card.harness] : signInService(text(card.name)),
        false,
      );
    case 'squire': {
      const result = view(
        'squire',
        'wants to',
        card.action ?? squireApprovalAction(card.tool ?? '', card.detail ?? '', card.linkKind),
        // A passkey guards a secret, which the mock sets in mono.
        card.linkKind === 'passkey',
        text(card.reason),
      );
      const facts = Array.isArray(card.facts) ? card.facts.flatMap((fact: unknown) => {
        const { label, value } = (fact ?? {}) as { label?: unknown; value?: unknown };
        return typeof label === 'string' && typeof value === 'string' ? [{ label, value }] : [];
      }) : [];
      if (result && facts.length) Object.assign(result, { facts });
      if (!result || !card.approvalUrl) return result;
      let url: URL;
      try { url = new URL(card.approvalUrl); } catch { return result; }
      if (url.protocol !== 'https:') return result;
      return { ...result, actions: [{ kind: 'external', url: url.toString(),
        label: card.linkKind === 'passkey' ? 'Use passkey' : card.linkKind === 'vouch' ? 'Vouch' : 'Approve' }] };
    }
    default:
      return undefined;
  }
}

/**
 * A sign-in card may carry a page title ("Sign in to Trusty Squire?") as its
 * name; the ask already says "sign in to", so keep only the service.
 */
export function signInService(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const service = name.replace(/^(?:sign|log)\s*in\s+(?:to|with)\s+/i, '').replace(/[\s?!.:]+$/, '').trim();
  return service || name;
}

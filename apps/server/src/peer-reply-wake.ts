import { createHash } from 'node:crypto';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { AgentCommandInput, CommandRow, PrivateCommandPayload } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { modelText, SYSTEM_AUTHOR_ID, type Composed } from './message-origin.js';
import { recordedMessageRoute } from './message-route.js';
import { ensureSystemIdentity } from './system-line.js';

type Attachment = NonNullable<PrivateCommandPayload['attachments']>[number];

export type PeerReplyWakeOutput =
  | {
      kind: 'answer';
      outputId: string;
      text: string;
      attachments?: readonly Attachment[];
      batchCommandIds?: readonly string[];
    }
  | { kind: 'failed'; outputId: string; text: Composed<'system'> };

/**
 * Build one informational `reply` wake for the sending agent when a thread turn
 * triggered by another agent's `message(type:"normal")` finishes with normal
 * turn output (or a hosted failure) and did not already send a reply, blocker,
 * or message back to that sender.
 */
export async function peerReplyWakeInput(
  db: SqlDatabase,
  item: CommandRow,
  output: PeerReplyWakeOutput,
): Promise<(AgentCommandInput & { audienceId: string }) | undefined> {
  const payload = item.private_payload;
  if (
    item.reason !== 'message' ||
    payload?.kind !== 'message' ||
    payload.reportStatus ||
    payload.automatic ||
    payload.selfWake ||
    item.review_context ||
    item.posted_reply_id
  ) {
    return undefined;
  }
  const sender = (await recordedMessageRoute(db, item)).from;
  if (
    !sender.agent ||
    !sender.place ||
    sender.agent === item.agent_id ||
    sender.agent === SYSTEM_IDENTITY_ID
  ) {
    return undefined;
  }
  const batchIds = [
    ...new Set([item.id, ...(output.kind === 'answer' ? (output.batchCommandIds ?? []) : [])]),
  ];
  const eligible = (await db.query<{ ok: boolean }>(
    `SELECT true ok
     FROM rooms origin
     JOIN rooms destination ON destination.id=$2 AND destination.archived_at IS NULL
     JOIN identities sender ON sender.id=$3 AND sender.kind='agent'
     JOIN memberships member
       ON member.room_id=COALESCE(destination.parent_id,destination.id)
       AND member.identity_id=sender.id
       AND member.removed_at IS NULL
     WHERE origin.id=$1 AND origin.parent_id IS NOT NULL AND origin.archived_at IS NULL
       AND NOT EXISTS(
         SELECT 1 FROM agent_commands child
         WHERE child.agent_id=$3
           AND child.room_id=$2
           AND child.reason IN ('reply','message')
           AND (
             child.parent_command_id=ANY($4::text[])
             OR EXISTS(
               SELECT 1 FROM agent_invocations inv
               WHERE (inv.command_id=$5 OR $5=ANY(inv.batched_command_ids))
                 AND (child.parent_command_id=inv.command_id OR child.parent_command_id=ANY(inv.batched_command_ids))
             )
           )
       )
     LIMIT 1`,
    [item.room_id, sender.place, sender.agent, batchIds, item.id],
  )).rows[0];
  if (!eligible) return undefined;
  if (output.kind === 'failed') await ensureSystemIdentity(db);
  const from = {
    agent: output.kind === 'failed' ? SYSTEM_AUTHOR_ID : item.agent_id,
    place: item.room_id,
  };
  const voice = output.kind === 'failed'
    ? { authorId: SYSTEM_AUTHOR_ID, text: output.text }
    : { authorId: item.agent_id, text: modelText(output.text || '(shared attachments)') };
  const attachments = output.kind === 'answer' && output.attachments?.length
    ? [...output.attachments]
    : undefined;
  return {
    id: createHash('sha256')
      .update(`peer-reply:${sender.place}:${sender.agent}:${output.outputId}`)
      .digest('hex'),
    roomId: sender.place,
    agentId: sender.agent,
    sourceMessageId: null,
    audienceId: sender.agent,
    reason: 'reply',
    parent: item,
    privatePayload: {
      kind: 'reply',
      ...voice,
      route: { from, to: sender },
      inReplyTo: item.id,
      fromRoomId: item.room_id,
      returnIdentityId: from.agent,
      ...(attachments ? { attachments } : {}),
    },
  };
}

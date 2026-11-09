import { mentionReplyRule } from '@beeline/api-contract/phone';
import { createHash } from 'node:crypto';
import type { SqlDatabase } from './database.js';

export function mentionRouting(memberId: string, roomId: string, messageId: string, askerHandle: string | null) {
  return { roomId, messageId, memberId, replyRule: mentionReplyRule(messageId, askerHandle),
    idempotencyKey: `mention:${memberId}:${messageId}` };
}

/** Retain cleared rows: a retry must keep the server key even after its answer committed. */
export async function mentionReplyKey(db: SqlDatabase, member: string, room: string, message?: string): Promise<string | undefined> {
  if (!message) return undefined;
  return (await db.query(`SELECT 1 FROM rooms_mcp_mentions WHERE member_id=$1 AND room_id=$2 AND message_id=$3`,
    [member, room, message])).rowCount ? `mention:${member}:${message}` : undefined;
}
export function mentionReplyId(key: string): string {
  return createHash('sha256').update(`rooms-mcp-message:${key}`).digest('hex');
}
/** One answer per tag and text: an identical retry dedupes, a different reply posts. */
export function mentionAnswerKey(key: string, text: string): string {
  return `${key}:${createHash('sha256').update(text).digest('hex')}`;
}

const serverMentionInputs = new WeakSet<object>();

/** Normalize transport metadata before the ordinary phone reply writer runs. */
export async function prepareMentionReplyInput(db: SqlDatabase, member: string,
  input: { roomId: string; parentMessageId: string; text: string; messageId?: string }): Promise<void> {
  const key = await mentionReplyKey(db, member, input.roomId, input.parentMessageId);
  if (!key) return;
  input.messageId = mentionReplyId(mentionAnswerKey(key, input.text));
  serverMentionInputs.add(input);
}

export function isMentionReplyInput(input: object): boolean {
  return serverMentionInputs.has(input);
}

/** Private, current membership-scoped reminder accompanying tool results. */
export async function owedMentions(db: SqlDatabase, member: string) {
  const rows = (await db.query<{room_id: string; message_id: string; author_handle: string | null}>(`SELECT mention.room_id,mention.message_id,author.handle author_handle
    FROM rooms_mcp_mentions mention JOIN messages m ON m.id=mention.message_id AND m.deleted_at IS NULL
    JOIN identities author ON author.id=m.author_id
    JOIN rooms r ON r.id=mention.room_id AND r.archived_at IS NULL
    WHERE mention.member_id=$1 AND mention.cleared_at IS NULL
      AND EXISTS(SELECT 1 FROM effective_memberships rm WHERE rm.room_id=r.id AND rm.identity_id=$1 AND rm.removed_at IS NULL)
      AND EXISTS(SELECT 1 FROM memberships wm WHERE wm.workspace_id=r.workspace_id AND wm.room_id IS NULL AND wm.identity_id=$1 AND wm.removed_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM messages reply WHERE reply.room_id=mention.room_id
        AND reply.author_id=$1 AND reply.reply_to_message_id=mention.message_id AND reply.deleted_at IS NULL
        AND reply.presentation='message')
    ORDER BY mention.seq LIMIT 100`, [member])).rows;
  return rows.map(row => mentionRouting(member, row.room_id, row.message_id, row.author_handle));
}
export async function clearOwedMention(db: SqlDatabase, member: string, room: string, message: string): Promise<number> {
  return (await db.query(`UPDATE rooms_mcp_mentions SET cleared_at=now()
    WHERE member_id=$1 AND room_id=$2 AND message_id=$3 AND cleared_at IS NULL`, [member, room, message])).rowCount ?? 0;
}

import { closeBlock } from './implementer-blocks.js';
import { createHash } from 'node:crypto';
import { shortenAsk } from '@beeline/api-contract/phone';
import { CommandRefusalError } from './command-refusal.js';
import type { SqlDatabase } from './database.js';
import {
  AGENT_ASK_CLOSE_REASONS,
  needsYouSentence,
  questionRecipientSql,
  settledMarkReasonSql,
  type AgentAskCloseReason,
} from './needs-you.js';

/** Lines an agent sees before the rest is counted. */
const OPEN_ASK_LINES = 5;

type OpenAsk = {
  id: string;
  created_at: Date;
  text: string;
  ask: string | null;
  room_name: string;
  handles: string[];
  recipients: string[];
};

function age(createdAt: Date, now: number): string {
  const minutes = Math.max(0, Math.floor((now - createdAt.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * The agent's asks still open on a person's Needs you list in the Room's
 * Workspace, or all accessible Workspaces for MCP initialization, oldest first.
 * `version` names the asks and their recipients, not the reminder's wording.
 */
export async function agentOpenAsks(
  db: SqlDatabase,
  agentId: string,
  roomId: string | null,
  now = Date.now(),
): Promise<{ version: string; text: string }> {
  const rows = (
    await db.query<OpenAsk>(
      `SELECT m.id,m.created_at,m.text,COALESCE(m.card->>'ask',m.card->>'prompt') ask,room.name room_name,
       array_agg(COALESCE(beeline_workspace_handle(mark.identity_id,mark.workspace_id),person.name) ORDER BY mark.identity_id) handles,
       array_agg(mark.identity_id ORDER BY mark.identity_id) recipients
     FROM needs_you_marks mark
     JOIN messages m ON m.id=mark.message_id AND m.author_id=$1
     JOIN rooms room ON room.id=m.room_id AND room.archived_at IS NULL
     JOIN identities person ON person.id=mark.identity_id
     WHERE mark.cleared_at IS NULL AND m.deleted_at IS NULL
       AND ((NOT EXISTS (SELECT 1 FROM work_questions question WHERE question.message_id=m.id)
         AND NOT EXISTS (SELECT 1 FROM room_choices choice WHERE choice.message_id=m.id AND choice.mode='question'))
         OR ${questionRecipientSql('m', 'mark.identity_id')})
       AND ($2::uuid IS NULL OR mark.workspace_id=(SELECT workspace_id FROM rooms WHERE id=$2))
       AND EXISTS (SELECT 1 FROM memberships workspace
         WHERE workspace.workspace_id=mark.workspace_id AND workspace.room_id IS NULL
           AND workspace.identity_id=$1 AND workspace.removed_at IS NULL)
       AND EXISTS (SELECT 1 FROM room_access access WHERE access.room_id=room.id
         AND access.identity_id=$1 AND access.removed_at IS NULL)
       AND (${settledMarkReasonSql('m', 'mark.identity_id')}) IS NULL
     GROUP BY m.id,room.name ORDER BY m.created_at,m.id`,
      [agentId, roomId],
    )
  ).rows;
  const version = createHash('sha256')
    .update(rows.map((row) => `${row.id}:${row.recipients.join(',')}`).join('\n'))
    .digest('hex')
    .slice(0, 16);
  if (!rows.length) return { version, text: '' };
  const more = rows.length - OPEN_ASK_LINES;
  return {
    version,
    text: [
      "Your open asks, oldest first. Each stays on the person's Tasks list until they answer it, you send them a newer report from that thread, the thread closes, or you call close_ask(id, reason):",
      ...rows
        .slice(0, OPEN_ASK_LINES)
        .map(
          (row) =>
            `- [ask id: ${row.id}] ${age(row.created_at, now)} ago in ${row.room_name}, to ${row.handles.map((handle) => `@${handle.replace(/^@/, '')}`).join(', ')}: ${shortenAsk(row.ask || needsYouSentence(row.text))}`,
        ),
      ...(more > 0 ? [`${more} more`] : []),
    ].join('\n'),
  };
}

/** The asking agent closes its own ask on every person's list, keeping the reason. */
export async function closeAgentAsk(
  db: SqlDatabase,
  agentId: string,
  input: { messageId?: unknown; reason?: unknown },
): Promise<{ closed: number }> {
  if (typeof input.messageId !== 'string' || !input.messageId)
    throw new CommandRefusalError('close_ask: id is required', 400);
  if (!AGENT_ASK_CLOSE_REASONS.includes(input.reason as AgentAskCloseReason))
    throw new CommandRefusalError(
      `close_ask: reason must be one of ${AGENT_ASK_CLOSE_REASONS.join(', ')}`,
      400,
    );
  return db.transaction(async (tx) => {
    const blockClosed = await closeBlock(tx, agentId, input.messageId as string, input.reason as string);
    if (blockClosed) await tx.query("UPDATE room_choices SET status='closed' WHERE message_id=$1 AND mode='question' AND status='open'",[input.messageId]);
    const question = await tx.query<{ ask_closed_reason: string }>(
      `UPDATE messages SET ask_closed_reason=COALESCE(ask_closed_reason,$2)
       WHERE id=$1 AND (author_id=$3 OR $4) RETURNING ask_closed_reason`,
      [input.messageId, input.reason, agentId, blockClosed],
    );
    if (!question.rowCount)
      throw new CommandRefusalError('close_ask: that id is not one of your asks', 404);
    const closed = await tx.query(
      `UPDATE needs_you_marks SET cleared_at=now(),cleared_reason=$2
       WHERE message_id=$1 AND cleared_at IS NULL`,
      [input.messageId, question.rows[0]!.ask_closed_reason],
    );
    return { closed: closed.rowCount ?? 0 };
  });
}

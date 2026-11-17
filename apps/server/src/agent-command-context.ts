import { createHash } from 'node:crypto';
import type { CommandRow } from './agent-command.js';
import { currentCornerBrief } from './corner-brief.js';
import type { SqlDatabase } from './database.js';
import { createDefaultEmbedFn, type EmbedFn } from './institutional-memory-embeddings.js';
import { getInstitutionalContext } from './institutional-memory-shadow.js';

export const INSTITUTIONAL_CONTEXT_MISSED_TEXT =
  'institutional memory did not load this turn; use search(scope:memory) before concluding anything is not stored.';

/** Freeze the old fact/profile/skill snapshot before commit publishes the queue
 * or an external wake. Private command metadata, never public message text. */
export async function attachQueuedInstitutionalContext(
  db: SqlDatabase,
  command: CommandRow,
  embed: EmbedFn = createDefaultEmbedFn(),
): Promise<CommandRow> {
  if (command.reason === 'mcp_call' || command.message?.institutionalContext !== undefined)
    return command;
  let text: string;
  // A failed optional SQL read must not leave the queue transaction aborted.
  await db.query('SAVEPOINT queued_institutional_context');
  try {
    // Avoid provider and authority reads for Workspaces with nothing saved.
    const saved = await db.query(
      `SELECT 1 FROM rooms room WHERE room.id=$1 AND (
      EXISTS(SELECT 1 FROM workspace_skills skill WHERE skill.workspace_id=room.workspace_id AND skill.state='active') OR
      EXISTS(SELECT 1 FROM institutional_memory_items item WHERE item.workspace_id=room.workspace_id AND item.state='active' AND item.deleted_at IS NULL)
    )`,
      [command.room_id],
    );
    text = saved.rowCount ? (await getInstitutionalContext(db, command, embed)).text : '';
    await db.query('RELEASE SAVEPOINT queued_institutional_context');
  } catch {
    await db.query('ROLLBACK TO SAVEPOINT queued_institutional_context');
    await db.query('RELEASE SAVEPOINT queued_institutional_context');
    text = INSTITUTIONAL_CONTEXT_MISSED_TEXT;
    console.warn(
      '[institutional-memory] queued context did not load; delivering the request with a miss notice',
    );
  }
  const message = { ...command.message!, institutionalContext: text };
  await db.query(
    `WITH updated AS (
    UPDATE agent_commands SET message=$2::jsonb WHERE id=$1 RETURNING id
  ) UPDATE rooms_mcp_event_deliveries SET body=jsonb_set(body::jsonb,'{data,institutionalContext}',to_jsonb($3::text))::text
    WHERE command_id IN (SELECT id FROM updated) AND $3::text<>''`,
    [command.id, JSON.stringify(message), text],
  );
  return { ...command, message };
}

/** The bounded recent window a fresh session receives once. */
export const CONVERSATION_WINDOW_MESSAGES = 20;
const MESSAGE_CHARS = 1_000;
type Seen = NonNullable<NonNullable<CommandRow['message']>['contextSeen']>;

/**
 * Freeze what this agent has not yet seen in this place with the command:
 * messages since its previous command here (the tip), the thread brief when its
 * revision changed and the member list when membership changed. The previous
 * command's `contextSeen` is the per (agent, place) record of what was sent. A
 * fresh session instead renders `conversationWindow`, the bounded recent
 * window, stored only when it differs from the delta.
 */
export async function attachQueuedConversation(
  db: SqlDatabase,
  command: CommandRow,
  members: readonly { id: string; kind: string; name: string; handle: string | null }[],
): Promise<CommandRow> {
  if (command.reason === 'mcp_call' || !command.message || command.message.contextSeen)
    return command;
  const previous = (
    await db.query<{ seen: Seen }>(
      `SELECT message->'contextSeen' seen FROM agent_commands WHERE agent_id=$1 AND room_id=$2 AND id<>$3
       AND message ? 'contextSeen' ORDER BY created_at DESC,id DESC LIMIT 1`,
      [command.agent_id, command.room_id, command.id],
    )
  ).rows[0]?.seen;
  const source = command.source_message_id
    ? (
        await db.query<{ created_at: Date }>('SELECT created_at FROM messages WHERE id=$1', [
          command.source_message_id,
        ])
      ).rows[0]
    : undefined;
  const window = (
    await db.query<{ id: string; created_at: Date; author_id: string; name: string; text: string }>(
      `SELECT message.id,message.created_at,message.author_id,author.name,left(message.text,$3) text FROM messages message
     JOIN identities author ON author.id=message.author_id
     WHERE message.room_id=$1 AND message.deleted_at IS NULL AND message.presentation='message' AND message.text<>''
       AND ($2::text IS NULL OR (message.created_at,message.id)<(SELECT created_at,id FROM messages WHERE id=$2))
     ORDER BY message.created_at DESC,message.id DESC LIMIT $4`,
      [command.room_id, command.source_message_id, MESSAGE_CHARS, CONVERSATION_WINDOW_MESSAGES],
    )
  ).rows.reverse();
  const self = members.find((member) => member.id === command.agent_id)?.handle;
  const memberText = [
    'Members (exact tag spellings):',
    ...[...members]
      .sort((a, b) => a.id.localeCompare(b.id))
      .filter((member) => member.id !== command.agent_id && member.handle)
      .map(
        (member) =>
          `- @${member.handle}${member.name && member.name !== member.handle ? ` — ${member.name}` : ''} (${member.kind === 'agent' ? 'agent' : 'person'})`,
      ),
    ...(self ? [`You are @${self}, a member here; you are not listed above.`] : []),
  ].join('\n');
  const memberVersion = createHash('sha256').update(memberText).digest('hex').slice(0, 16);
  const brief = (
    await db.query('SELECT 1 FROM rooms WHERE id=$1 AND parent_id IS NOT NULL', [command.room_id])
  ).rowCount
    ? await currentCornerBrief(db, command.room_id)
    : undefined;
  const briefText = brief
    ? `Current thread brief, revision ${brief.revision}. It governs this thread; earlier instructions that conflict with it are historical:\n${brief.spec}`
    : '';
  const line = (row: (typeof window)[number]) => `[message id: ${row.id}] ${row.name}: ${row.text}`;
  const render = (rows: typeof window, heading: string, withBrief: boolean, withMembers: boolean) =>
    [
      ...(withBrief && briefText ? [briefText] : []),
      ...(withMembers ? [memberText] : []),
      ...(rows.length ? [heading, ...rows.map(line)] : []),
    ].join('\n\n');
  const full = render(window, 'Recent conversation here, oldest first:', true, true);
  const after = previous?.createdAt
    ? (
        await db.query<(typeof window)[number]>(
          `SELECT message.id,message.created_at,message.author_id,author.name,left(message.text,$3) text FROM messages message
     JOIN identities author ON author.id=message.author_id
     WHERE message.room_id=$1 AND message.deleted_at IS NULL AND message.presentation='message' AND message.text<>''
       AND message.author_id<>$4 AND (message.created_at,message.id)>(COALESCE((SELECT created_at FROM messages WHERE id=$6),$5::timestamptz),$6::text)
       AND ($2::text IS NULL OR (message.created_at,message.id)<(SELECT created_at,id FROM messages WHERE id=$2))
     ORDER BY message.created_at,message.id`,
          [
            command.room_id,
            command.source_message_id,
            MESSAGE_CHARS,
            command.agent_id,
            previous.createdAt,
            previous.messageId ?? '',
          ],
        )
      ).rows
    : window;
  const delta = previous
    ? render(
        after,
        'New messages here since your last turn, oldest first:',
        brief?.revision !== previous.briefRevision,
        memberVersion !== previous.memberVersion,
      )
    : full;
  const newest = source
    ? { messageId: command.source_message_id!, createdAt: source.created_at.toISOString() }
    : window.length
      ? { messageId: window.at(-1)!.id, createdAt: window.at(-1)!.created_at.toISOString() }
      : {
          ...(previous?.messageId ? { messageId: previous.messageId } : {}),
          ...(previous?.createdAt ? { createdAt: previous.createdAt } : {}),
        };
  const contextSeen: Seen = {
    ...newest,
    ...(brief ? { briefRevision: brief.revision } : {}),
    memberVersion,
  };
  const message = {
    ...command.message,
    contextSeen,
    ...(delta ? { conversationContext: delta } : {}),
    ...(full !== delta ? { conversationWindow: full } : {}),
  };
  await db.query(
    `WITH updated AS (UPDATE agent_commands SET message=$2::jsonb WHERE id=$1 RETURNING id)
    UPDATE rooms_mcp_event_deliveries SET body=jsonb_set(body::jsonb,'{data,institutionalContext}',
      to_jsonb(concat_ws(E'\n\n',NULLIF(body::jsonb#>>'{data,institutionalContext}',''),$3::text)))::text
    WHERE command_id IN (SELECT id FROM updated) AND $3::text<>''`,
    [command.id, JSON.stringify(message), delta],
  );
  return { ...command, message };
}

/** The queue-time context text an external wake or mention carries: the
 * institutional snapshot, then the conversation delta. */
export const queuedContextSql = (alias: string) =>
  `NULLIF(concat_ws(E'\\n\\n',NULLIF(${alias}.message->>'institutionalContext',''),${alias}.message->>'conversationContext'),'')`;

import {
  CHAT_LINK_TOKEN_LIMIT,
  parseChatLinkToken,
  type ChatLinkPreview,
  type ChatLinkToken,
  type ChatLinkView,
  type ChatLinksView,
} from '@beeline/api-contract/chat-links';
import type { PhoneContext } from './context.js';
import { phoneCanReadRooms } from './access.js';
import { unix } from './values.js';

type ThreadToken = Extract<ChatLinkToken, { kind: 'thread' }>;
type MessageToken = Extract<ChatLinkToken, { kind: 'message' }>;

type Candidate<T> = { readonly rootId: string; readonly target: T };

/**
 * The one rule every reader shares: a match in the chat the link was written
 * in wins; otherwise exactly one match elsewhere in the Workspace. Two or more
 * matches elsewhere name nothing, so the token stays plain text. Access plays
 * no part in the choice; it only decides how the chosen target is shown.
 */
export function pickChatLinkTarget<T>(
  candidates: readonly Candidate<T>[],
  contextRootId: string,
): Candidate<T> | null {
  const local = candidates.filter((candidate) => candidate.rootId === contextRootId);
  if (local.length) return local.length === 1 ? local[0]! : null;
  return candidates.length === 1 ? candidates[0]! : null;
}

/** The first line with any words on it, as written. */
export function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

type ThreadRow = {
  name_key: string; id: string; name: string; parent_id: string; parent_name: string | null;
  author_name: string | null; created_at: Date | null; text: string | null;
};

type MessageRow = {
  handle_key: string; seq: number; id: string; room_id: string; root_id: string;
  room_name: string | null; root_name: string | null; is_thread: boolean;
  author_name: string; created_at: Date; text: string;
};

/**
 * Resolve `↳thread` and `¶author-N` tokens written in one Room or thread, for
 * one reader. The reader must be able to open the place the tokens were
 * written in. A target in a chat the reader cannot open comes back as
 * `private`, with nothing else about it. Unmatched tokens are omitted.
 */
export async function phoneResolveChatLinks(
  ctx: PhoneContext,
  roomId: string,
  tokens: readonly string[],
  viewerId: string,
): Promise<ChatLinksView | null> {
  if (!(await phoneCanReadRooms(ctx, [roomId], viewerId)).has(roomId)) return null;
  const context = (await ctx.database.query<{ root_id: string; workspace_id: string }>(
    `SELECT COALESCE(parent_id,id)::text root_id,workspace_id::text workspace_id FROM rooms WHERE id=$1`,
    [roomId],
  )).rows[0];
  if (!context) return null;

  const parsed = new Map<string, ChatLinkToken>();
  for (const raw of tokens.slice(0, CHAT_LINK_TOKEN_LIMIT)) {
    const token = typeof raw === 'string' ? parseChatLinkToken(raw) : null;
    if (token && !parsed.has(token.key)) parsed.set(token.key, token);
  }
  const threads = [...parsed.values()].filter((token): token is ThreadToken => token.kind === 'thread');
  const messages = [...parsed.values()].filter((token): token is MessageToken => token.kind === 'message');

  const [threadRows, messageRows] = await Promise.all([
    threads.length ? readThreadCandidates(ctx, context.workspace_id, threads) : [],
    messages.length ? readMessageCandidates(ctx, context.workspace_id, messages) : [],
  ]);

  const chosen: Array<{ key: string; rootId: string; view: ChatLinkView }> = [];
  for (const token of threads) {
    const nameKey = token.name.toLocaleLowerCase();
    const pick = pickChatLinkTarget(
      threadRows.filter((row) => row.name_key === nameKey).map((row) => ({ rootId: row.parent_id, target: row })),
      context.root_id,
    );
    if (!pick) continue;
    const row = pick.target;
    const preview: ChatLinkPreview | null = row.author_name && row.created_at && row.text !== null
      ? { author: row.author_name, createdAt: unix(row.created_at), firstLine: firstLine(row.text) }
      : null;
    chosen.push({
      key: token.key, rootId: pick.rootId,
      view: {
        key: token.key, kind: 'thread', roomId: row.id, parentRoomId: row.parent_id, name: row.name,
        ...(pick.rootId !== context.root_id && row.parent_name ? { chatName: row.parent_name } : {}),
        ...(preview ? { preview } : {}),
      },
    });
  }
  for (const token of messages) {
    const handleKey = token.handle.toLocaleLowerCase();
    const pick = pickChatLinkTarget(
      messageRows.filter((row) => row.handle_key === handleKey && row.seq === token.seq)
        .map((row) => ({ rootId: row.root_id, target: row })),
      context.root_id,
    );
    if (!pick) continue;
    const row = pick.target;
    chosen.push({
      key: token.key, rootId: pick.rootId,
      view: {
        key: token.key, kind: 'message', messageId: row.id, roomId: row.room_id,
        workspaceId: context.workspace_id,
        ...(row.is_thread && row.room_name ? { threadName: row.room_name } : {}),
        ...(pick.rootId !== context.root_id && row.root_name ? { chatName: row.root_name } : {}),
        preview: { author: row.author_name, createdAt: unix(row.created_at), firstLine: firstLine(row.text) },
      },
    });
  }

  const readable = await phoneCanReadRooms(ctx, [...new Set(chosen.map((item) => item.rootId))], viewerId);
  return {
    links: chosen.map((item) => readable.has(item.rootId)
      ? item.view
      : { key: item.key, kind: 'private' as const }),
  };
}

/** Threads in this Workspace whose name matches, with each thread's opening message. */
async function readThreadCandidates(
  ctx: PhoneContext,
  workspaceId: string,
  tokens: readonly ThreadToken[],
): Promise<ThreadRow[]> {
  const names = [...new Set(tokens.map((token) => token.name.toLocaleLowerCase()))];
  const result = await ctx.database.query<ThreadRow>(
    `SELECT wanted.name_key,thread.id::text id,thread.name,thread.parent_id::text parent_id,
            parent.name parent_name,author.name author_name,opening.created_at,opening.text
     FROM unnest($2::text[]) wanted(name_key)
     JOIN rooms thread ON thread.parent_id IS NOT NULL AND lower(thread.name)=wanted.name_key
     JOIN rooms parent ON parent.id=thread.parent_id AND parent.workspace_id=$1::uuid
     LEFT JOIN LATERAL (
       SELECT m.author_id,m.created_at,m.text FROM messages m
       WHERE m.room_id=thread.id AND m.presentation='message' AND m.deleted_at IS NULL
       ORDER BY m.created_at,m.id LIMIT 1
     ) opening ON true
     LEFT JOIN identities author ON author.id=opening.author_id`,
    [workspaceId, names],
  );
  return result.rows;
}

/** Messages in this Workspace with the token's number, written under the token's handle. */
async function readMessageCandidates(
  ctx: PhoneContext,
  workspaceId: string,
  tokens: readonly MessageToken[],
): Promise<MessageRow[]> {
  const handles = tokens.map((token) => token.handle.toLocaleLowerCase());
  const seqs = tokens.map((token) => token.seq);
  const result = await ctx.database.query<MessageRow>(
    `WITH wanted AS (
       SELECT DISTINCT handle_key,seq FROM unnest($2::text[],$3::integer[]) wanted(handle_key,seq)
     ), authors AS (
       SELECT DISTINCT wanted.handle_key,identity.id FROM (SELECT DISTINCT handle_key FROM wanted) wanted
       JOIN identities identity ON lower(identity.handle)=wanted.handle_key
         OR identity.id IN (SELECT reserved.identity_id FROM workspace_handles reserved
           WHERE reserved.workspace_id=$1::uuid AND lower(reserved.handle)=wanted.handle_key)
     )
     SELECT wanted.handle_key,wanted.seq,m.id,m.room_id::text room_id,
            COALESCE(room.parent_id,room.id)::text root_id,room.name room_name,
            root.name root_name,(room.parent_id IS NOT NULL) is_thread,
            author.name author_name,m.created_at,m.text
     FROM wanted
     JOIN authors ON authors.handle_key=wanted.handle_key
     JOIN messages m ON m.author_id=authors.id AND m.chat_seq=wanted.seq AND m.deleted_at IS NULL
     JOIN rooms room ON room.id=m.room_id AND room.workspace_id=$1::uuid
     JOIN rooms root ON root.id=COALESCE(room.parent_id,room.id)
     JOIN identities author ON author.id=m.author_id
     WHERE lower(beeline_room_handle(m.author_id,m.room_id))=wanted.handle_key`,
    [workspaceId, handles, seqs],
  );
  return result.rows;
}

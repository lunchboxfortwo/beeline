import type {
  RoomConversationInput,
  RoomConversationResult,
  RoomMessageResult,
} from './daemon-operations-room-conversation-window.js';

export class InvalidMessagePageError extends Error {}

export function readAgentMessageResult({ nextOffset, ...message }: RoomMessageResult) {
  return { ...message, ...(nextOffset !== undefined ? { next: { offset: nextOffset } } : {}) };
}

export type MessagePageCursor = { before?: string; after?: string; offset?: number };
export type MessagePageInput = {
  roomId: string;
  from?: 'oldest' | 'newest';
  limit?: number;
  cursor?: MessagePageCursor;
};

export function normalizeMessagePage(input: Readonly<MessagePageInput>) {
  const args = { ...input, ...input.cursor };
  args.from ??= args.after || args.offset !== undefined ? 'oldest' : 'newest';
  if (args.before !== undefined && (args.from !== 'newest' || !args.before))
    throw new InvalidMessagePageError('before requires a nonempty cursor and from newest');
  if (args.from === 'newest' && (args.after !== undefined || args.offset !== undefined))
    throw new InvalidMessagePageError('from newest pages with before, not after or offset');
  if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0))
    throw new InvalidMessagePageError('pass the returned next object unchanged as read cursor');
  for (const direction of ['before', 'after'] as const) {
    const value = args[direction];
    if (value === undefined) continue;
    // A timestamp-only cursor skips every message at that millisecond.
    const cursor = /^\d{1,19}$/.test(value)
      ? `${value},${(direction === 'before' ? '0' : 'f').repeat(64)}`
      : value;
    const timestamp = /^(\d{1,19}),(?:[0-9a-f]{64}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.exec(cursor)?.[1];
    if (!timestamp || BigInt(timestamp) > 9223372036854775807n)
      throw new InvalidMessagePageError('pass the returned next object unchanged as read cursor');
    args[direction] = cursor;
  }
  return args;
}

export type MessagePageLimits = { items: number; bodyChars?: number; responseChars?: number };

export const MESSAGE_PAGE_REPLY_EXCERPT_MAX = 160;

function boundPageReplyExcerpt(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= MESSAGE_PAGE_REPLY_EXCERPT_MAX) return clean;
  return `${clean.slice(0, MESSAGE_PAGE_REPLY_EXCERPT_MAX - 1).trimEnd()}…`;
}

type ConversationItem = RoomConversationResult['items'][number];
function messageRow(item: ConversationItem, offset: number) {
  const excerpt =
    typeof item.replyToExcerpt === 'string' && item.replyToExcerpt.trim()
      ? boundPageReplyExcerpt(item.replyToExcerpt)
      : undefined;
  return {
    id: item.id,
    messageId: item.id,
    cursor: item.cursor,
    authorId: item.authorId,
    ...(item.authorHandle ? { authorHandle: item.authorHandle } : {}),
    createdAt: item.createdAt,
    type: item.type,
    ...(offset ? { bodyOffset: offset } : {}),
    ...(item.replyToMessageId
      ? {
          repliesTo: {
            messageId: item.replyToMessageId,
            ...(item.replyToAuthorId ? { authorId: item.replyToAuthorId } : {}),
            ...(item.replyToAuthorName ? { authorName: item.replyToAuthorName } : {}),
            ...(excerpt ? { excerpt } : {}),
          },
        }
      : {}),
    ...(item.rootMessageId ? { rootMessageId: item.rootMessageId } : {}),
    ...(item.requestAuthorId ? { requestAuthorId: item.requestAuthorId } : {}),
    ...(item.attachments.length ? { attachmentCount: item.attachments.length, attachments: item.attachments } : {}),
    ...(item.messageLink ? { messageLink: item.messageLink } : {}),
  };
}

type MessageRow = ReturnType<typeof messageRow> & { body: string; bodyContinues?: true };
const hasContent = (item: ConversationItem) =>
  Boolean(item.body.trim() || item.attachments.length || item.systemEvent);

/** The bounded transcript page is shared by helper, connector and CLI reads. */
export async function readAgentMessagePage(
  input: MessagePageInput,
  read: (input: RoomConversationInput) => Promise<RoomConversationResult>,
  limits: MessagePageLimits = {items:8,bodyChars:1000,responseChars:12000},
) {
  const args = normalizeMessagePage(input);
  const newest = args.from === 'newest';
  const itemLimit = Math.min(args.limit ?? 8, limits.items);
  const responseBudget = limits.responseChars === undefined ? undefined : limits.responseChars - 1000;
  const rows: ConversationItem[] = [];
  let boundary = newest ? args.before : args.after;
  let more = false;
  // Retain the raw boundary even when a stretch contains only activity.
  for (let scan = 0; scan < 16; scan++) {
    const { items: batch } = await read({
      roomId: args.roomId,
      limit: itemLimit + 1,
      ...(newest ? { window: 'recent', ...(boundary ? { before: boundary } : {}) }
        : boundary ? { after: boundary } : { window: 'earliest' }),
    });
    if (newest) rows.unshift(...batch);
    else rows.push(...batch);
    const nextBoundary = (newest ? batch[0] : batch.at(-1))?.cursor;
    more = batch.length === itemLimit + 1;
    if (!more || rows.filter(hasContent).length > itemLimit || !nextBoundary || nextBoundary === boundary) break;
    boundary = nextBoundary;
  }
  const rawBoundary = (newest ? rows[0] : rows.at(-1))?.cursor;
  const visible = rows.filter(hasContent);
  const window = newest ? visible.slice(-itemLimit).reverse() : visible.slice(0, itemLimit);
  const items: MessageRow[] = [];
  let after = args.after;
  let offset = args.offset;
  for (const item of window) {
    const start = offset ?? 0;
    const text = item.systemEvent && !item.body.trim() ? JSON.stringify(item.systemEvent) : item.body;
    if (start > text.length) throw new InvalidMessagePageError('offset exceeds message body');
    const row = messageRow(item, start);
    let body = text.slice(start, limits.bodyChars === undefined ? undefined : start + limits.bodyChars);
    if (responseBudget !== undefined) {
      // Keep the attachment count when the full metadata cannot fit on the page.
      if (row.attachments && JSON.stringify([...items, row]).length > responseBudget) delete row.attachments;
      while (body && JSON.stringify([...items, { ...row, body }]).length > responseBudget)
        body = body.slice(0, Math.floor(body.length / 2));
    }
    if (!body && text.length > start) break;
    const continues = start + body.length < text.length;
    items.push({ ...row, body, ...(continues ? { bodyContinues: true } : {}) });
    if (!newest && continues) {
      offset = start + body.length;
      break;
    }
    after = item.cursor;
    offset = undefined;
  }
  let next: MessagePageCursor | undefined;
  if (newest) {
    const before = visible.length > items.length ? items.at(-1)?.cursor : rawBoundary;
    if ((more || visible.length > items.length) && before) next = { before };
  } else if (offset !== undefined || more || visible.length > items.length) {
    if (offset === undefined && visible.length === items.length) after = rawBoundary ?? after;
    next = { ...(after ? { after } : {}), ...(offset !== undefined ? { offset } : {}) };
  }
  return { cornerId: args.roomId, items, ...(next ? { next } : {}),
    limits: { ...limits, items: itemLimit } };
}

/**
 * Thread and message links written in message text.
 *
 * - `↳thread-name` names a thread (a corner) by its stored name.
 * - `¶author-N` names one message: the Nth message of its chat (a Room
 *   together with its threads), written by `author`. N is the message's
 *   `chatSeq`, never its internal id.
 *
 * The phone and the server share this parser, so a token links the same way
 * wherever it is read. Only the server decides what a token points to
 * (`resolveChatLinks`); a token it cannot match stays plain text.
 */

export const THREAD_LINK_MARK = '↳';
export const MESSAGE_LINK_MARK = '¶';

/** Most tokens one resolve request may carry. */
export const CHAT_LINK_TOKEN_LIMIT = 64;
/** Longest token the server will try to resolve. */
export const CHAT_LINK_TOKEN_MAX_LENGTH = 160;

export type ChatLinkToken =
  | {
      readonly kind: 'thread';
      /** The exact authored characters, e.g. `↳sending-new-message`. */
      readonly text: string;
      /** Case-folded lookup key; equal keys resolve to the same target. */
      readonly key: string;
      readonly name: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: 'message';
      readonly text: string;
      readonly key: string;
      readonly handle: string;
      readonly seq: number;
      readonly start: number;
      readonly end: number;
    };

/** One line of the target message: who wrote it, when, and its first line. */
export type ChatLinkPreview = {
  readonly author: string;
  /** Unix seconds. */
  readonly createdAt: number;
  readonly firstLine: string;
};

/** How the server resolved one token for this reader. Unmatched tokens are omitted. */
export type ChatLinkView =
  | {
      readonly key: string;
      readonly kind: 'thread';
      readonly roomId: string;
      readonly parentRoomId: string;
      readonly name: string;
      /** Present only when the thread belongs to another chat: that chat's name. */
      readonly chatName?: string;
      readonly preview?: ChatLinkPreview;
    }
  | {
      readonly key: string;
      readonly kind: 'message';
      readonly messageId: string;
      /** The Room or thread that holds the message. */
      readonly roomId: string;
      readonly workspaceId: string;
      /** The thread that holds the message, when it is in a thread. */
      readonly threadName?: string;
      /** Present only when the message belongs to another chat: that chat's name. */
      readonly chatName?: string;
      readonly preview: ChatLinkPreview;
    }
  | {
      /** The target exists in a chat this reader cannot open. */
      readonly key: string;
      readonly kind: 'private';
    };

export type ChatLinksView = { readonly links: readonly ChatLinkView[] };

// A thread name: letters, marks, digits, `_` and inner `-`. Corner names are
// hyphenated slugs (`migrations/corner-names.ts`).
const THREAD_NAME = String.raw`[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}_-]*[\p{L}\p{M}\p{N}_])?`;
// The same handle class the composer's @ picker writes. The final `-N` is the
// count, so a handle may itself contain `-` or digits.
const HANDLE = String.raw`[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?`;
const TOKEN_PATTERN = new RegExp(
  String.raw`(?:↳(${THREAD_NAME})|¶(${HANDLE})-([1-9][0-9]{0,8}))(?![\p{L}\p{M}\p{N}_]|-[\p{L}\p{N}])`,
  'gu',
);

const WORD_BEFORE = /[\p{L}\p{N}_]/u;

function fold(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

/** Every thread and message link token in `text`, left to right. */
export function findChatLinkTokens(text: string): ChatLinkToken[] {
  if (!text || (text.indexOf(THREAD_LINK_MARK) < 0 && text.indexOf(MESSAGE_LINK_MARK) < 0)) return [];
  const tokens: ChatLinkToken[] = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const start = match.index ?? 0;
    // A mark glued to a word (`a↳b`) is prose, not a link.
    if (start > 0 && WORD_BEFORE.test(text[start - 1]!)) continue;
    const value = match[0];
    if (value.length > CHAT_LINK_TOKEN_MAX_LENGTH) continue;
    const end = start + value.length;
    if (match[1] !== undefined) {
      tokens.push({ kind: 'thread', text: value, key: fold(value), name: match[1], start, end });
    } else {
      const handle = match[2]!;
      const seq = Number(match[3]);
      tokens.push({ kind: 'message', text: value, key: fold(value), handle, seq, start, end });
    }
  }
  return tokens;
}

/** Parse one whole token, or return null when `token` is not exactly one link. */
export function parseChatLinkToken(token: string): ChatLinkToken | null {
  const found = findChatLinkTokens(token);
  return found.length === 1 && found[0]!.start === 0 && found[0]!.end === token.length ? found[0]! : null;
}

/** The token Copy link writes for a message: `¶author-N`. */
export function messageLinkToken(handle: string, chatSeq: number): string {
  return `${MESSAGE_LINK_MARK}${handle.replace(/^@/, '')}-${chatSeq}`;
}

/** The token the composer's thread picker writes: `↳name`. */
export function threadLinkToken(name: string): string {
  return `${THREAD_LINK_MARK}${name}`;
}

function text(value: unknown, max = 4000): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function readPreview(value: unknown): ChatLinkPreview | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  return text(item.author, 200) && typeof item.firstLine === 'string' && item.firstLine.length <= 4000
    && typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)
    ? { author: item.author, createdAt: item.createdAt, firstLine: item.firstLine }
    : null;
}

function readChatLinkView(value: unknown): ChatLinkView | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (!text(item.key, CHAT_LINK_TOKEN_MAX_LENGTH)) return null;
  const chatName = text(item.chatName, 400) ? { chatName: item.chatName } : {};
  if (item.kind === 'private') return { key: item.key, kind: 'private' };
  if (item.kind === 'thread') {
    if (!text(item.roomId, 100) || !text(item.parentRoomId, 100) || !text(item.name, 400)) return null;
    const preview = readPreview(item.preview);
    return {
      key: item.key, kind: 'thread', roomId: item.roomId, parentRoomId: item.parentRoomId,
      name: item.name, ...chatName, ...(preview ? { preview } : {}),
    };
  }
  if (item.kind === 'message') {
    const preview = readPreview(item.preview);
    if (!text(item.messageId, 100) || !/^[0-9a-f]{64}$/.test(item.messageId) || !text(item.roomId, 100)
      || !text(item.workspaceId, 100) || !preview) return null;
    return {
      key: item.key, kind: 'message', messageId: item.messageId, roomId: item.roomId,
      workspaceId: item.workspaceId, preview, ...chatName,
      ...(text(item.threadName, 400) ? { threadName: item.threadName } : {}),
    };
  }
  return null;
}

/** Read a `resolveChatLinks` answer, dropping any entry that is not a whole link. */
export function readChatLinksView(value: unknown): ChatLinksView | null {
  if (!value || typeof value !== 'object') return null;
  const links = (value as Record<string, unknown>).links;
  if (!Array.isArray(links)) return null;
  return {
    links: links.slice(0, CHAT_LINK_TOKEN_LIMIT).flatMap((link) => {
      const read = readChatLinkView(link);
      return read ? [read] : [];
    }),
  };
}

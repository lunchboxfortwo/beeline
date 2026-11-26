import { cornerShortTitle, isConnectorIdentity, roomTitle } from '@beeline/api-contract/phone';
import { threadWorkState, type ChatListCorner } from '@beeline/api-contract/phone';
import type { ChatListItem } from '@beeline/buzz-client';
import { roomRowAttentionReason, roomRowName, roomRowPreview } from '@/buzz/room-list-row';
import type { RepoCandidate } from '@/buzz/room-repo-picker';

export type SearchChip = 'unread' | 'pinned';

/** A chat's "Who: last message" line, from the server's latest row. */
export function chatPreview(
  item: ChatListItem,
  viewer: string | undefined,
): { who?: string; text: string } {
  const preview = roomRowPreview(item, viewer);
  if (preview.attribution === 'none') return { text: preview.text };
  if (preview.attribution === 'self') return { who: 'You', text: preview.text };
  const peer = item.directMessage?.peer;
  const author = peer && isConnectorIdentity(peer) ? peer : item.latestMessage?.author;
  return { who: author?.name?.trim() || preview.handle, text: preview.text };
}

/** Whether the chat needs the viewer’s attention; the shared StatusMark owns its glyph. */
export function chatTagged(item: ChatListItem): boolean {
  return Boolean(roomRowAttentionReason(item));
}

/** `#name` for a chat, `@handle` for a direct message. */
export function chatTitle(item: Pick<ChatListItem, 'room' | 'directMessage'>): string {
  const name = roomRowName(item);
  return `${name.sigil}${name.name}`;
}

/** A joinable chat's `#name`. */
export function joinableTitle(name: string): string {
  return roomTitle(name) ?? `#${name}`;
}

export function threadTitle(item: ChatListItem, corner: ChatListCorner): string {
  return cornerShortTitle(item.room.name, corner.name, corner.id);
}

/** Open threads waiting on the viewer, in server order. */
export function chatThreads(
  item: ChatListItem,
  corners: readonly ChatListCorner[] | undefined,
  viewer: string | undefined,
): ChatListCorner[] {
  if (item.directMessage || !corners?.length) return [];
  return corners.filter((corner) => threadWorkState(corner, viewer) === 'needs-you');
}

/** How many waiting threads a chat shows before its `more` control. */
export const WAITING_THREADS_SHOWN = 3;

/** Show the waiting threads inline and count those still hidden. */
export function shownThreads(
  item: ChatListItem,
  corners: readonly ChatListCorner[] | undefined,
  expanded: boolean,
  viewer: string | undefined,
): { shown: readonly ChatListCorner[]; more: number } {
  const waiting = chatThreads(item, corners, viewer);
  const shown = expanded ? waiting : waiting.slice(0, WAITING_THREADS_SHOWN);
  return { shown, more: waiting.length - shown.length };
}

/** Search narrows by chat name, last message and thread titles; each chip narrows further. */
export function filterChats(
  chats: readonly ChatListItem[],
  query: string,
  chips: readonly SearchChip[],
  pinned: readonly string[],
  /** The corner store owns each chat's open threads once the list is read. */
  corners: (roomId: string) => readonly ChatListCorner[] | undefined = () => undefined,
): ChatListItem[] {
  const needle = query.trim().toLocaleLowerCase();
  return chats.filter((item) => {
    if (item.closed) return false;
    if (chips.includes('unread') && !item.unread) return false;
    if (chips.includes('pinned') && !pinned.includes(item.room.id)) return false;
    if (!needle) return true;
    const threads = (corners(item.room.id) ?? item.openCorners ?? [])
      .map((corner) => corner.name)
      .join(' ');
    return `${roomRowName(item).name} ${item.latestMessage?.text ?? ''} ${threads}`
      .toLocaleLowerCase()
      .includes(needle);
  });
}

/** A chat name from a repository: its short name as a chat slug. */
export function chatNameForRepository(candidate: Pick<RepoCandidate, 'name'>): string {
  const short = candidate.name.split('/').at(-1) ?? candidate.name;
  return short
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

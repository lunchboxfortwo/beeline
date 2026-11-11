import { cornerShortTitle, isConnectorIdentity, roomTitle } from '@beeline/api-contract/phone';
import type { ChatListCorner } from '@beeline/api-contract/phone';
import type { ChatListItem } from '@beeline/buzz-client';
import { roomRowAttentionReason, roomRowName, roomRowPreview } from '@/buzz/room-list-row';
import type { RepoCandidate } from '@/buzz/room-repo-picker';

/** Chats show up to three active threads; the rest wait behind "N more". */
export const VISIBLE_THREADS = 3;

export type SearchChip = 'unread' | 'pinned';

/** A chat's "Who: last message" line, from the server's latest row. */
export function chatPreview(item: ChatListItem, viewer: string | undefined): { who?: string; text: string } {
  const preview = roomRowPreview(item, viewer);
  if (preview.attribution === 'none') return { text: preview.text };
  if (preview.attribution === 'self') return { who: 'You', text: preview.text };
  const peer = item.directMessage?.peer;
  const author = peer && isConnectorIdentity(peer) ? peer : item.latestMessage?.author;
  return { who: author?.name?.trim() || preview.handle, text: preview.text };
}

/** The ring around the unread dot: a tag, an approval, or a thread waiting on the viewer. */
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

/** Waiting on the viewer: the corner is waiting and is theirs (the server's Mine rule). */
export function threadWaitsOnViewer(corner: ChatListCorner): boolean {
  return corner.state === 'waiting' && corner.mine === true;
}

export function threadWord(corner: ChatListCorner): string {
  return threadWaitsOnViewer(corner) ? 'waiting on you' : corner.state;
}

export function threadTitle(item: ChatListItem, corner: ChatListCorner): string {
  return cornerShortTitle(item.room.name, corner.name, corner.id);
}

/** Active threads, the ones waiting on the viewer first, then the viewer's own, then the rest in server order. */
export function chatThreads(item: ChatListItem, corners: readonly ChatListCorner[] | undefined): ChatListCorner[] {
  if (item.directMessage || !corners?.length) return [];
  const rank = (corner: ChatListCorner) => (threadWaitsOnViewer(corner) ? 0 : corner.mine ? 1 : 2);
  return corners
    .map((corner, index) => ({ corner, index }))
    .sort((left, right) => rank(left.corner) - rank(right.corner) || left.index - right.index)
    .map(({ corner }) => corner);
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
    const threads = (corners(item.room.id) ?? item.openCorners ?? []).map((corner) => corner.name).join(' ');
    return `${roomRowName(item).name} ${item.latestMessage?.text ?? ''} ${threads}`
      .toLocaleLowerCase()
      .includes(needle);
  });
}

/** A chat name from a repository: its short name as a chat slug. */
export function chatNameForRepository(candidate: Pick<RepoCandidate, 'name'>): string {
  const short = candidate.name.split('/').at(-1) ?? candidate.name;
  return short.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
}

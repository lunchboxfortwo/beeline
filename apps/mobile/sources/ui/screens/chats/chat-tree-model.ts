import { cornerShortTitle, isConnectorIdentity, roomTitle } from '@beeline/api-contract/phone';
import type { ChatListCorner, WorkState } from '@beeline/api-contract/phone';
import type { ChatListItem } from '@beeline/buzz-client';
import { roomRowAttentionReason, roomRowName, roomRowPreview } from '@/buzz/room-list-row';
import type { RepoCandidate } from '@/buzz/room-repo-picker';
import { threadListLabel } from '@/ui/screens/thread/thread-status';

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

/** "waiting on you" for the person the server's waiting blocker names, "waiting on <name>" for everyone else. */
export function threadWord(corner: ChatListCorner, viewer: string | undefined): string {
  return threadListLabel(corner, viewer).word;
}

export function threadTitle(item: ChatListItem, corner: ChatListCorner): string {
  return cornerShortTitle(item.room.name, corner.name, corner.id);
}

/** A thread's Tasks state; a row without one reads its corner state. */
export function threadWorkState(corner: ChatListCorner): WorkState {
  return (
    corner.workState ??
    (corner.state === 'waiting' ? 'needs-you' : corner.state === 'review' ? 'in-review' : 'in-progress')
  );
}

/** Chats navigate every thread: waiting ones first, the rest in server order. */
export function chatThreads(
  item: ChatListItem,
  corners: readonly ChatListCorner[] | undefined,
): ChatListCorner[] {
  if (item.directMessage || !corners?.length) return [];
  const waiting = (corner: ChatListCorner) => threadWorkState(corner) === 'needs-you';
  return [...corners.filter(waiting), ...corners.filter((corner) => !waiting(corner))];
}

/** How many waiting threads a chat shows before its `more` control. */
export const WAITING_THREADS_SHOWN = 3;

/** Up to three waiting threads show under a chat and `more` counts the rest;
 * expanded, every thread shows. With none waiting, no thread shows. */
export function shownThreads(
  threads: readonly ChatListCorner[],
  expanded: boolean,
): { shown: readonly ChatListCorner[]; more: number } {
  const waiting = threads.filter((corner) => threadWorkState(corner) === 'needs-you').length;
  if (!waiting) return { shown: [], more: 0 };
  const shown = expanded ? threads : threads.slice(0, Math.min(waiting, WAITING_THREADS_SHOWN));
  return { shown, more: threads.length - shown.length };
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

import { cornerShortTitle, isConnectorIdentity, roomTitle } from '@beeline/api-contract/phone';
import type { ChatListCorner, WorkState } from '@beeline/api-contract/phone';
import type { ChatListItem } from '@beeline/buzz-client';
import { roomRowAttentionReason, roomRowName, roomRowPreview } from '@/buzz/room-list-row';
import type { RepoCandidate } from '@/buzz/room-repo-picker';
import { threadListLabel, threadWaitsOnViewer, type ThreadWaitFacts } from '@/ui/screens/thread/thread-status';

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

/** "waiting on you" for the person the server's waiting blocker names, "waiting on <name>" for everyone else. */
export function threadWord(corner: ChatListCorner, viewer: string | undefined): string {
  return threadRow(corner, viewer).word;
}

export function threadTitle(item: ChatListItem, corner: ChatListCorner): string {
  return cornerShortTitle(item.room.name, corner.name, corner.id);
}

/**
 * A thread's Tasks state for this viewer; a row without one reads its corner state.
 * Needs you only when the thread waits on this viewer; a wait on anyone else is in progress.
 */
export function threadWorkState(
  corner: ThreadWaitFacts & { workState?: WorkState },
  viewer: string | undefined,
): WorkState {
  if (corner.state === 'archived') return 'done';
  const state = corner.workState ??
    (corner.state === 'waiting' ? 'needs-you' : corner.state === 'review' ? 'in-review' : 'in-progress');
  return state === 'needs-you' && !threadWaitsOnViewer(corner, viewer) ? 'in-progress' : state;
}

/** The thread's state mark: its Tasks state, drawn idle while nothing runs (a wait on someone else included). */
export function threadMark(
  corner: ThreadWaitFacts & { workState?: WorkState },
  viewer: string | undefined,
): { state: WorkState; idle: boolean } {
  const state = threadWorkState(corner, viewer);
  return { state, idle: state === 'in-progress' && (corner.state === 'idle' || corner.state === 'waiting') };
}

/**
 * A thread row's state line and mark read one state: a Tasks state past working (backlog,
 * review, done) names itself; otherwise the line words the server's corner state.
 */
export function threadRow(
  corner: ThreadWaitFacts & { workState?: WorkState },
  viewer: string | undefined,
): { word: string; you: boolean; state: WorkState; idle: boolean } {
  const mark = threadMark(corner, viewer);
  const word = mark.state === 'done' ? 'done' : mark.state === 'in-review' ? 'review' : mark.state === 'backlog' ? 'backlog' : undefined;
  return { ...(word ? { word, you: false } : threadListLabel(corner, viewer)), ...mark };
}

/** Chats navigate every thread: waiting ones first, the rest in server order. */
export function chatThreads(
  item: ChatListItem,
  corners: readonly ChatListCorner[] | undefined,
  viewer: string | undefined,
): ChatListCorner[] {
  if (item.directMessage || !corners?.length) return [];
  const waiting = (corner: ChatListCorner) => threadWorkState(corner, viewer) === 'needs-you';
  return [...corners.filter(waiting), ...corners.filter((corner) => !waiting(corner))];
}

/** How many waiting threads a chat shows before its `more` control. */
export const WAITING_THREADS_SHOWN = 3;

/** Up to three waiting threads show under a chat and `more` counts the rest;
 * expanded, every thread shows. With none waiting, no thread shows. */
export function shownThreads(
  threads: readonly ChatListCorner[],
  expanded: boolean,
  viewer: string | undefined,
): { shown: readonly ChatListCorner[]; more: number } {
  const waiting = threads.filter((corner) => threadWorkState(corner, viewer) === 'needs-you').length;
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

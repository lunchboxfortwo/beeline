import { describe, expect, it } from 'vitest';
import type { ChatListItem } from '@beeline/buzz-client';
import type { ChatListCorner } from '@beeline/api-contract/phone';
import {
  chatNameForRepository,
  chatPreview,
  chatTagged,
  chatThreads,
  filterChats,
  shownThreads,
  threadMark,
  threadRow,
  threadWord,
} from './chat-tree-model';

const alan = { pubkey: 'a'.repeat(64), kind: 'agent' as const, name: 'Alan', handle: 'alan' };

function chat(id: string, extra: Partial<ChatListItem> = {}): ChatListItem {
  return {
    room: { id, workspaceId: 'w', name: id, archived: false, createdAt: 1, updatedAt: 1 },
    latestMessage: {
      id: `${id}-m`,
      text: 'The one-row header is ready for a look.',
      createdAt: 10,
      author: alan,
    },
    ...extra,
  } as ChatListItem;
}

describe('chat rows', () => {
  it('reads "Who: last message" with the author name, and You for the viewer', () => {
    expect(chatPreview(chat('beeline'), 'viewer')).toEqual({
      who: 'Alan',
      text: 'The one-row header is ready for a look.',
    });
    expect(chatPreview(chat('beeline'), alan.pubkey)).toEqual({
      who: 'You',
      text: 'The one-row header is ready for a look.',
    });
    expect(chatPreview(chat('quiet', { latestMessage: undefined }), 'viewer')).toEqual({
      text: 'No messages yet',
    });
  });

  it('shows a system line as written, without a "You:" prefix', () => {
    const latest = { ...chat('beeline').latestMessage!, text: '@alan opened a thread calm-willow-thread',
      presentation: 'card' as const, systemEvent: { kind: 'corner-opened' } as never };
    expect(chatPreview(chat('beeline', { latestMessage: latest }), alan.pubkey)).toEqual({
      text: '@alan opened a thread calm-willow-thread',
    });
  });

  it('rings the dot for an unread tag or a chat that needs the viewer', () => {
    expect(chatTagged(chat('a', { unread: true }))).toBe(false);
    expect(
      chatTagged(
        chat('a', {
          unread: true,
          latestMessage: { ...chat('a').latestMessage!, mentionsViewer: true },
        }),
      ),
    ).toBe(true);
    expect(chatTagged(chat('a', { agentState: 'needs-you' }))).toBe(true);
  });

  const now = 1_800_000_000_000;
  const ago = (hours: number) => now / 1000 - hours * 60 * 60;

  const viewer = 'v'.repeat(64);
  const onViewer = { kind: 'report' as const, personId: viewer, personName: 'Vera' };
  const onAlan = { kind: 'report' as const, personId: alan.pubkey, personName: 'Alan' };

  it('lists every thread, Needs you threads first, without an age cutoff', () => {
    const corners = [
      {
        id: 'working',
        name: 'working',
        state: 'working' as const,
        workState: 'in-progress' as const,
      },
      { id: 'review', name: 'review', state: 'review' as const, workState: 'in-review' as const },
      { id: 'backlog', name: 'backlog', state: 'idle' as const, workState: 'backlog' as const },
      { id: 'done', name: 'done', state: 'idle' as const, workState: 'done' as const },
      ...Array.from({ length: 12 }, (_, i) => ({
        id: `blocked-${i}`,
        name: 'blocked',
        state: 'waiting' as const,
        workState: 'needs-you' as const,
        blocker: onViewer,
        lastActivityAt: ago(8 * 24),
      })),
    ];
    expect(chatThreads(chat('a'), corners, viewer).map((c) => c.id)).toEqual([
      ...Array.from({ length: 12 }, (_, i) => `blocked-${i}`),
      'working',
      'review',
      'backlog',
      'done',
    ]);
    expect(threadWord(corners[4]!, viewer)).toBe('waiting on you');
    expect(chatThreads(chat('dm', { directMessage: { peer: alan } }), corners, viewer)).toEqual([]);
    expect(chatThreads(chat('quiet'), corners.slice(0, 4), viewer).map((c) => c.id)).toEqual([
      'working',
      'review',
      'backlog',
      'done',
    ]);
  });

  it('marks Needs you only for the person a thread waits on; a wait on anyone else is idle', () => {
    const waiting = (blocker: typeof onViewer) =>
      ({ id: 'w', name: 'w', state: 'waiting', workState: 'needs-you', blocker }) as ChatListCorner;
    expect(threadMark(waiting(onViewer), viewer)).toEqual({ state: 'needs-you', idle: false });
    expect(threadMark(waiting(onAlan), viewer)).toEqual({ state: 'in-progress', idle: true });
    expect(threadMark({ state: 'waiting', blocker: onAlan } as ChatListCorner, viewer)).toEqual({ state: 'in-progress', idle: true });
    expect(threadMark({ state: 'working', workState: 'in-progress' } as ChatListCorner, viewer)).toEqual({ state: 'in-progress', idle: false });
    expect(threadMark({ state: 'archived' } as ChatListCorner, viewer)).toEqual({ state: 'done', idle: false });
  });

  it('Reproduction ROW-DONE: a thread row line and mark read one state, so a done thread reads done', () => {
    const row = (state: ChatListCorner['state'], workState?: ChatListCorner['workState']) =>
      threadRow({ id: 'r', name: 'r', state, ...(workState ? { workState } : {}) } as ChatListCorner, viewer);
    // latency-capture-investigation: its Tasks state is done while the machine rests idle.
    expect(row('idle', 'done')).toEqual({ word: 'done', you: false, state: 'done', idle: false });
    expect(row('working', 'in-review')).toMatchObject({ word: 'review', state: 'in-review' });
    expect(row('idle', 'backlog')).toMatchObject({ word: 'backlog', state: 'backlog' });
    expect(row('idle')).toEqual({ word: 'idle', you: false, state: 'in-progress', idle: true });
    expect(row('archived')).toMatchObject({ word: 'done', state: 'done' });
    expect(threadRow({ state: 'waiting', workState: 'needs-you', blocker: onViewer } as ChatListCorner, viewer))
      .toEqual({ word: 'waiting on you', you: true, state: 'needs-you', idle: false });
  });

  it('shows at most three waiting threads, counts the rest, and shows none when none wait', () => {
    const corner = (id: string, workState: string) =>
      ({ id, name: id, state: workState === 'needs-you' ? 'waiting' : 'working', workState, blocker: onViewer }) as unknown as ChatListCorner;
    const threads = [
      ...['a', 'b', 'c', 'd'].map((id) => corner(id, 'needs-you')),
      corner('e', 'in-progress'),
    ];
    expect(shownThreads(threads, false, viewer)).toEqual({ shown: threads.slice(0, 3), more: 2 });
    expect(shownThreads(threads, true, viewer)).toEqual({ shown: threads, more: 0 });
    expect(shownThreads([threads[0]!, threads[4]!], false, viewer)).toEqual({ shown: [threads[0]], more: 1 });
    expect(shownThreads([threads[4]!], false, viewer)).toEqual({ shown: [], more: 0 });
    expect(shownThreads([threads[4]!], true, viewer)).toEqual({ shown: [], more: 0 });
  });

  it('keeps rows without a work state', () => {
    const blocked = { id: 'legacy', name: 'legacy', state: 'waiting' as const, blocker: onAlan };
    expect(chatThreads(chat('a'), [blocked])).toEqual([blocked]);
    expect(threadWord(blocked, viewer)).toBe('waiting on Alan');
  });
});

describe('search', () => {
  const chats = [chat('beeline', { unread: true }), chat('milo'), chat('closed', { closed: true })];

  it('matches chat names, last messages and thread titles, never closed chats', () => {
    expect(filterChats(chats, '', [], []).map((item) => item.room.id)).toEqual(['beeline', 'milo']);
    expect(filterChats(chats, 'MILO', [], []).map((item) => item.room.id)).toEqual(['milo']);
    expect(
      filterChats(chats, 'routing', [], [], (id) =>
        id === 'milo' ? [{ id: 't', name: 'Model routing', state: 'working' }] : undefined,
      ).map((item) => item.room.id),
    ).toEqual(['milo']);
  });

  it('narrows by Unread and Pinned together', () => {
    expect(filterChats(chats, '', ['unread'], []).map((item) => item.room.id)).toEqual(['beeline']);
    expect(filterChats(chats, '', ['pinned'], ['milo']).map((item) => item.room.id)).toEqual([
      'milo',
    ]);
    expect(filterChats(chats, '', ['unread', 'pinned'], ['milo'])).toEqual([]);
  });
});

it('names a chat after its repository as a chat slug', () => {
  expect(chatNameForRepository({ name: 'lunchboxfortwo/Burdie-AI' })).toBe('burdie-ai');
  expect(chatNameForRepository({ name: 'owner/awesome_mcp.servers' })).toBe('awesome-mcp-servers');
  expect(chatNameForRepository({ name: 'x/' + 'a'.repeat(60) })).toHaveLength(48);
});

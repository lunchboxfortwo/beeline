import { describe, expect, it } from 'vitest';
import type { ChatListItem } from '@beeline/buzz-client';
import { threadWorkMark, type ChatListCorner } from '@beeline/api-contract/phone';
import { threadListLabel } from '@/ui/screens/thread/thread-status';
import {
  chatNameForRepository,
  chatPreview,
  chatTagged,
  chatThreads,
  filterChats,
  shownThreads,
} from './chat-tree-model';

const threadWord = (corner: ChatListCorner, viewer: string | undefined) => threadListLabel(corner, viewer).word;

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

  it('lists only threads waiting on the viewer, in server order and without an age cutoff', () => {
    const other: ChatListCorner[] = [
      { id: 'other-wait', name: 'Other wait', state: 'waiting', blocker: onAlan },
      { id: 'working', name: 'working', state: 'working' as const },
      { id: 'review', name: 'review', state: 'review' as const },
      { id: 'backlog', name: 'backlog', state: 'idle' as const, reason: 'backlog' as const },
      { id: 'idle', name: 'idle', state: 'idle' as const },
    ];
    const waiting: ChatListCorner[] = Array.from({ length: 12 }, (_, i) => ({
      id: `blocked-${i}`,
      name: 'blocked',
      state: 'waiting',
      blocker: onViewer,
      lastActivityAt: ago(8 * 24),
    }));
    const corners = [...other, ...waiting];
    expect(chatThreads(chat('a'), corners, viewer)).toEqual(waiting);
    expect(chatThreads(chat('dm', { directMessage: { peer: alan } }), corners, viewer)).toEqual([]);
    expect(chatThreads(chat('quiet'), other, viewer)).toEqual([]);
  });

  it('marks every waiting thread with the waiting @ for every viewer, whoever it waits on', () => {
    const waiting = (blocker: typeof onViewer) =>
      ({ id: 'w', name: 'w', state: 'waiting', blocker }) as ChatListCorner;
    expect(threadWorkMark(waiting(onViewer))).toEqual({ state: 'needs-you', idle: false });
    expect(threadWorkMark(waiting(onAlan))).toEqual({ state: 'needs-you', idle: false });
    expect(threadWorkMark({ state: 'waiting' } as ChatListCorner)).toEqual({ state: 'needs-you', idle: false });
    expect(threadWorkMark({ state: 'working' } as ChatListCorner)).toEqual({ state: 'in-progress', idle: false });
    expect(threadWorkMark({ state: 'archived' } as ChatListCorner)).toEqual({ state: 'done', idle: false });
  });

  it('Reproduction WAITING-NOT-IDLE: a pending grant or a block reported to the commander draws waiting for the owner', () => {
    // composer-tray waited on its commander Ruby; latency-rig-patch on a pending run-script grant. Both drew idle.
    const ruby = { kind: 'report' as const, personId: 'r'.repeat(64), personName: 'Ruby' };
    const reported = { id: 'b', name: 'b', state: 'waiting', blocker: ruby } as ChatListCorner;
    expect([threadWorkMark(reported), threadWord(reported, viewer)]).toEqual([{ state: 'needs-you', idle: false }, 'waiting on Ruby']);
    const grant = { id: 'g', name: 'g', state: 'waiting', reason: 'approve' } as ChatListCorner;
    expect([threadWorkMark(grant), threadWord(grant, viewer)]).toEqual([{ state: 'needs-you', idle: false }, 'waiting on approval']);
    const idle = { id: 'i', name: 'i', state: 'idle' } as ChatListCorner;
    expect([threadWorkMark(idle), threadWord(idle, viewer)]).toEqual([{ state: 'in-progress', idle: true }, 'idle']);
  });

  it('Reproduction ROW-DONE: a thread row reads one state, its machine state and reason; a planted second state is ignored', () => {
    // latency-capture-investigation: a stored Done over an idle machine drew Done beside "idle".
    const planted = { id: 'r', name: 'r', state: 'idle', workState: 'done' } as unknown as ChatListCorner;
    expect([threadWorkMark(planted), threadWord(planted, viewer)]).toEqual([{ state: 'in-progress', idle: true }, 'idle']);
    const backlog = { id: 'b', name: 'b', state: 'idle', reason: 'backlog' } as ChatListCorner;
    expect([threadWorkMark(backlog), threadWord(backlog, viewer)]).toEqual([{ state: 'backlog', idle: false }, 'backlog']);
    const review = { id: 'v', name: 'v', state: 'review', workState: 'backlog' } as unknown as ChatListCorner;
    expect([threadWorkMark(review), threadWord(review, viewer)]).toEqual([{ state: 'in-review', idle: false }, 'review']);
  });

  it('caps the collapsed rail at three and expands only the remaining waiting threads', () => {
    const waiting: ChatListCorner[] = ['a', 'b', 'c', 'd', 'e'].map((id) =>
      ({ id, name: id, state: 'waiting', blocker: onViewer }));
    const working: ChatListCorner = { id: 'working', name: 'Working', state: 'working' };
    const threads = [working, ...waiting];
    expect(shownThreads(chat('a'), threads, false, viewer)).toEqual({ shown: waiting.slice(0, 3), more: 2 });
    expect(shownThreads(chat('a'), threads, true, viewer)).toEqual({ shown: waiting, more: 0 });
    expect(shownThreads(chat('a'), threads.slice(0, 2), false, viewer)).toEqual({ shown: waiting.slice(0, 1), more: 0 });
    expect(shownThreads(chat('a'), [working], false, viewer)).toEqual({ shown: [], more: 0 });
    expect(shownThreads(chat('a'), [working], true, viewer)).toEqual({ shown: [], more: 0 });
  });

  it('uses the blocker when a thread has no additional work state', () => {
    const blocked = { id: 'legacy', name: 'legacy', state: 'waiting' as const, blocker: onAlan };
    expect(chatThreads(chat('a'), [blocked], alan.pubkey)).toEqual([blocked]);
    expect(chatThreads(chat('a'), [blocked], undefined)).toEqual([]);
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

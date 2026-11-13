import { describe, expect, it } from 'vitest';
import type { ChatListItem } from '@beeline/buzz-client';
import { chatNameForRepository, chatPreview, chatTagged, chatThreads, filterChats, threadWord } from './chat-tree-model';

const alan = { pubkey: 'a'.repeat(64), kind: 'agent' as const, name: 'Alan', handle: 'alan' };

function chat(id: string, extra: Partial<ChatListItem> = {}): ChatListItem {
  return {
    room: { id, workspaceId: 'w', name: id, archived: false, createdAt: 1, updatedAt: 1 },
    latestMessage: { id: `${id}-m`, text: 'The one-row header is ready for a look.', createdAt: 10, author: alan },
    ...extra,
  } as ChatListItem;
}

describe('chat rows', () => {
  it('reads "Who: last message" with the author name, and You for the viewer', () => {
    expect(chatPreview(chat('beeline'), 'viewer')).toEqual({ who: 'Alan', text: 'The one-row header is ready for a look.' });
    expect(chatPreview(chat('beeline'), alan.pubkey)).toEqual({ who: 'You', text: 'The one-row header is ready for a look.' });
    expect(chatPreview(chat('quiet', { latestMessage: undefined }), 'viewer')).toEqual({ text: 'No messages yet' });
  });

  it('rings the dot for an unread tag or a chat that needs the viewer', () => {
    expect(chatTagged(chat('a', { unread: true }))).toBe(false);
    expect(chatTagged(chat('a', { unread: true, latestMessage: { ...chat('a').latestMessage!, mentionsViewer: true } }))).toBe(true);
    expect(chatTagged(chat('a', { agentState: 'needs-you' }))).toBe(true);
  });

  const now = 1_800_000_000_000;
  const ago = (hours: number) => now / 1000 - hours * 60 * 60;

  const viewer = 'v'.repeat(64);
  const onViewer = { kind: 'report' as const, personId: viewer, personName: 'Vera' };
  const onAlan = { kind: 'report' as const, personId: alan.pubkey, personName: 'Alan' };

  it('orders threads waiting on the viewer first, then their own, then the rest', () => {
    const corners = [
      { id: '1', name: 'one', state: 'working' as const, lastActivityAt: ago(1) },
      { id: '2', name: 'two', state: 'waiting' as const, blocker: onAlan, lastActivityAt: ago(1) },
      { id: '3', name: 'three', state: 'idle' as const, mine: true as const, lastActivityAt: ago(1) },
      { id: '4', name: 'four', state: 'waiting' as const, mine: true as const, blocker: onViewer, lastActivityAt: ago(1) },
    ];
    expect(chatThreads(chat('a'), corners, now).map((corner) => corner.id)).toEqual(['4', '3', '1', '2']);
    expect(threadWord(corners[3]!, viewer)).toBe('waiting on you');
    expect(threadWord(corners[1]!, viewer)).toBe('waiting on Alan');
    // A direct message has no threads.
    expect(chatThreads(chat('dm', { directMessage: { peer: alan } }), corners, now)).toEqual([]);
  });

  it('lists threads from the last day, and threads waiting on the viewer for a week', () => {
    const corners = [
      { id: 'fresh', name: 'fresh', state: 'working' as const, lastActivityAt: ago(23) },
      { id: 'stale', name: 'stale', state: 'idle' as const, mine: true as const, lastActivityAt: ago(25) },
      { id: 'others-wait', name: 'others-wait', state: 'waiting' as const, lastActivityAt: ago(25) },
      { id: 'owed-week', name: 'owed-week', state: 'waiting' as const, mine: true as const, lastActivityAt: ago(6 * 24) },
      { id: 'owed-old', name: 'owed-old', state: 'waiting' as const, mine: true as const, lastActivityAt: ago(8 * 24) },
      // The viewer's own waiting thread keeps its week however its label reads.
      { id: 'mine-on-alan', name: 'mine-on-alan', state: 'waiting' as const, mine: true as const, blocker: onAlan, lastActivityAt: ago(25) },
      { id: 'silent', name: 'silent', state: 'working' as const },
    ];
    expect(chatThreads(chat('a'), corners, now).map((corner) => corner.id)).toEqual(['owed-week', 'mine-on-alan', 'fresh']);
    // No thread qualifies: the chat shows no thread lines.
    expect(chatThreads(chat('a'), corners.slice(1, 3), now)).toEqual([]);
  });
});

describe('search', () => {
  const chats = [
    chat('beeline', { unread: true }),
    chat('milo'),
    chat('closed', { closed: true }),
  ];

  it('matches chat names, last messages and thread titles, never closed chats', () => {
    expect(filterChats(chats, '', [], []).map((item) => item.room.id)).toEqual(['beeline', 'milo']);
    expect(filterChats(chats, 'MILO', [], []).map((item) => item.room.id)).toEqual(['milo']);
    expect(filterChats(chats, 'routing', [], [], (id) => (id === 'milo' ? [{ id: 't', name: 'Model routing', state: 'working' }] : undefined))
      .map((item) => item.room.id)).toEqual(['milo']);
  });

  it('narrows by Unread and Pinned together', () => {
    expect(filterChats(chats, '', ['unread'], []).map((item) => item.room.id)).toEqual(['beeline']);
    expect(filterChats(chats, '', ['pinned'], ['milo']).map((item) => item.room.id)).toEqual(['milo']);
    expect(filterChats(chats, '', ['unread', 'pinned'], ['milo'])).toEqual([]);
  });
});

it('names a chat after its repository as a chat slug', () => {
  expect(chatNameForRepository({ name: 'lunchboxfortwo/Burdie-AI' })).toBe('burdie-ai');
  expect(chatNameForRepository({ name: 'owner/awesome_mcp.servers' })).toBe('awesome-mcp-servers');
  expect(chatNameForRepository({ name: 'x/' + 'a'.repeat(60) })).toHaveLength(48);
});

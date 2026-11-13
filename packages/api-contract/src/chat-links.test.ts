import { describe, expect, it } from 'vitest';
import {
  findChatLinkTokens,
  messageLinkToken,
  parseChatLinkToken,
  readChatLinksView,
  threadLinkToken,
} from './chat-links.js';

describe('findChatLinkTokens', () => {
  it('finds thread and message links in prose, with their exact offsets', () => {
    const text = 'The fix landed in ↳sending-new-message. Candy\'s report was ¶candy-2773, same as ¶bbc-118.';
    expect(findChatLinkTokens(text).map(({ kind, text: token, start, end }) => ({ kind, token, start, end }))).toEqual([
      { kind: 'thread', token: '↳sending-new-message', start: 18, end: 38 },
      { kind: 'message', token: '¶candy-2773', start: 59, end: 70 },
      { kind: 'message', token: '¶bbc-118', start: 80, end: 88 },
    ]);
  });

  it('splits the count from a handle that holds hyphens, digits or underscores', () => {
    expect(findChatLinkTokens('¶pidoong-2-15 ¶firstmate_2-7')).toMatchObject([
      { kind: 'message', handle: 'pidoong-2', seq: 15, key: '¶pidoong-2-15' },
      { kind: 'message', handle: 'firstmate_2', seq: 7 },
    ]);
  });

  it('folds case into one key, and leaves anything that is not a whole link alone', () => {
    expect(findChatLinkTokens('↳Sending-New')[0]).toMatchObject({ key: '↳sending-new', name: 'Sending-New' });
    for (const prose of ['word↳thread', '¶candy', '¶candy-0', '¶candy-12x', '↳ spaced', '¶-3', '↳-x', 'a¶b-1']) {
      expect(findChatLinkTokens(prose)).toEqual([]);
    }
    expect(findChatLinkTokens('(↳notes), ¶ruby-9999.').map((token) => token.text)).toEqual(['↳notes', '¶ruby-9999']);
  });

  it('round-trips the tokens Copy link and the thread picker write', () => {
    expect(parseChatLinkToken(messageLinkToken('@candy', 2773))).toMatchObject({ kind: 'message', handle: 'candy', seq: 2773 });
    expect(parseChatLinkToken(threadLinkToken('speed-back-to'))).toMatchObject({ kind: 'thread', name: 'speed-back-to' });
    expect(parseChatLinkToken('↳notes and more')).toBeNull();
  });
});

describe('readChatLinksView', () => {
  it('keeps whole links and drops malformed entries', () => {
    const preview = { author: 'Candy', createdAt: 1, firstLine: 'Send button stays grey' };
    expect(readChatLinksView({
      links: [
        { key: '↳notes', kind: 'private', roomId: 'leak' },
        { key: '¶candy-1', kind: 'message', messageId: 'f'.repeat(64), roomId: 'r', workspaceId: 'w', preview, extra: 1 },
        { key: '¶candy-2', kind: 'message', messageId: 'not-hex', roomId: 'r', workspaceId: 'w', preview },
        { key: '↳x', kind: 'thread', roomId: 'r', parentRoomId: 'p', name: 'x', chatName: 'beeline' },
        { key: '↳y', kind: 'thread' },
      ],
    })).toEqual({
      links: [
        { key: '↳notes', kind: 'private' },
        { key: '¶candy-1', kind: 'message', messageId: 'f'.repeat(64), roomId: 'r', workspaceId: 'w', preview },
        { key: '↳x', kind: 'thread', roomId: 'r', parentRoomId: 'p', name: 'x', chatName: 'beeline' },
      ],
    });
    expect(readChatLinksView({})).toBeNull();
  });
});

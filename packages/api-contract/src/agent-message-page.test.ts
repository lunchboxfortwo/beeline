import { describe, expect, it } from 'vitest';
import {
  MESSAGE_PAGE_REPLY_EXCERPT_MAX,
  readAgentMessagePage,
  readAgentMessageResult,
} from './agent-message-page.js';
import type { RoomConversationResult } from './daemon-operations-room-conversation-window.js';

describe('readAgentMessagePage causal provenance', () => {
  it('exposes bounded repliesTo, rootMessageId, and requestAuthorId while keeping pages within budget', async () => {
    const longReply = `${'Quarterly update details '.repeat(12)}tail`;
    const page = await readAgentMessagePage(
      { roomId: 'room-1', limit: 8 },
      async (): Promise<RoomConversationResult> => ({
        items: [
          {
            id: 'm1',
            cursor: '100,m1',
            authorId: 'agent-1',
            authorHandle: 'crayon',
            createdAt: 100,
            type: 'message',
            body: 'Updated the schedule as requested.',
            attachments: [],
            replyToMessageId: 'm0',
            replyToAuthorId: 'human-1',
            replyToAuthorName: 'lunchboxfortwo',
            replyToExcerpt: `  ${longReply.replace(/ /g, '   ')}  `,
            rootMessageId: 'root-0',
            requestAuthorId: 'human-1',
          },
          {
            id: 'm2',
            cursor: '200,m2',
            authorId: 'human-1',
            createdAt: 200,
            type: 'message',
            body: 'Standalone note without parent.',
            attachments: [],
          },
        ],
      }),
    );

    expect(JSON.stringify(page).length).toBeLessThanOrEqual(12000);
    expect(page.items).toHaveLength(2);
    const [newest, older] = page.items;
    expect(newest).toMatchObject({ id: 'm2', body: 'Standalone note without parent.' });
    expect(newest!.repliesTo).toBeUndefined();
    expect(newest!.rootMessageId).toBeUndefined();
    expect(newest!.requestAuthorId).toBeUndefined();

    expect(older).toMatchObject({
      id: 'm1',
      authorId: 'agent-1',
      authorHandle: 'crayon',
      rootMessageId: 'root-0',
      requestAuthorId: 'human-1',
      repliesTo: {
        messageId: 'm0',
        authorId: 'human-1',
        authorName: 'lunchboxfortwo',
      },
    });
    expect(older!.repliesTo!.excerpt).toBeDefined();
    expect(older!.repliesTo!.excerpt!.length).toBeLessThanOrEqual(MESSAGE_PAGE_REPLY_EXCERPT_MAX);
    expect(older!.repliesTo!.excerpt!.endsWith('…')).toBe(true);
    expect(older!.repliesTo!.excerpt).not.toContain('  ');
  });

  it('preserves repliesTo and request provenance on readAgentMessageResult', () => {
    const result = readAgentMessageResult({
      messageId: 'm1',
      authorId: 'agent-1',
      authorHandle: 'crayon',
      createdAt: 100,
      body: 'Body text',
      bodyOffset: 0,
      bodyContinues: true,
      nextOffset: 9,
      repliesTo: {
        messageId: 'm0',
        authorId: 'human-1',
        authorName: 'lunchboxfortwo',
        excerpt: 'Parent message',
      },
      rootMessageId: 'root-0',
      requestAuthorId: 'human-1',
    });
    expect(result).toEqual({
      messageId: 'm1',
      authorId: 'agent-1',
      authorHandle: 'crayon',
      createdAt: 100,
      body: 'Body text',
      bodyOffset: 0,
      bodyContinues: true,
      next: { offset: 9 },
      repliesTo: {
        messageId: 'm0',
        authorId: 'human-1',
        authorName: 'lunchboxfortwo',
        excerpt: 'Parent message',
      },
      rootMessageId: 'root-0',
      requestAuthorId: 'human-1',
    });
  });

  it('renders unreadable private hand-offs as non-openable placeholders without leaking author or id while preserving pagination', async () => {
    const page = await readAgentMessagePage(
      { roomId: 'room-1', limit: 2 },
      async (): Promise<RoomConversationResult> => ({
        items: [
          {
            id: 'm1',
            cursor: '100,m1',
            authorId: 'human-1',
            createdAt: 100,
            type: 'message',
            body: 'Earlier public message',
            attachments: [],
          },
          {
            id: '',
            cursor: '200,secret-handoff-id',
            authorId: '',
            createdAt: 200,
            type: 'private-handoff',
            body: '[private hand-off]',
            attachments: [],
          },
          {
            id: 'm3',
            cursor: '300,m3',
            authorId: 'human-1',
            createdAt: 300,
            type: 'message',
            body: 'Newest public message',
            attachments: [],
          },
        ],
      }),
    );

    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({ id: 'm3', body: 'Newest public message' });
    expect(page.items[1]).toEqual({
      createdAt: 200,
      type: 'private-handoff',
      openable: false,
      body: '[private hand-off]',
    });
    expect(page.next).toEqual({ before: '200,secret-handoff-id' });
  });
});

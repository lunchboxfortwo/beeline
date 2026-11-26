import { expect, it, vi } from 'vitest';
import {
  formatNotificationReplyText,
  handleNotificationAction,
  readNotificationAction,
} from './notification-actions';

it('answers a raw Android task response with dataString once and waits for its outcome', async () => {
  const payload = {
    actionIdentifier: 'grant-once',
    notification: {
      request: {
        identifier: 'native-grant',
        content: {
          dataString: JSON.stringify({
            categoryId: 'beeline-grant',
            grantId: 'grant',
            messageId: 'message',
          }),
        },
      },
    },
  };
  let finish!: () => void;
  let started!: () => void;
  const answering = new Promise<void>((resolve) => {
    started = resolve;
  });
  const decideGrant = vi.fn(() => {
    started();
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const present = vi.fn(async () => {});
  const keys = new Set<string>();
  const deps = {
    platform: 'android' as const,
    decideGrant,
    sendReply: vi.fn(),
    newMessageId: () => 'unused',
    present,
    handled: {
      has: async (key: string) => keys.has(key),
      add: async (key: string) => {
        keys.add(key);
      },
    },
    inFlight: new Map(),
  };
  expect(readNotificationAction(payload)).toMatchObject({ grantId: 'grant', decision: 'once' });
  const task = handleNotificationAction(payload, deps);
  const listener = handleNotificationAction(payload, deps);
  await answering;
  expect(decideGrant).toHaveBeenCalledWith('grant', 'once');
  expect(present).not.toHaveBeenCalled();
  finish();
  await expect(Promise.all([task, listener])).resolves.toEqual(['done', null]);
  expect(present).toHaveBeenCalledOnce();
  await expect(handleNotificationAction(payload, deps)).resolves.toBeNull();
  expect(decideGrant).toHaveBeenCalledOnce();
});

it('ignores malformed native dataString', () => {
  expect(
    readNotificationAction({
      actionIdentifier: 'grant-once',
      notification: {
        request: {
          identifier: 'native-grant',
          content: { dataString: '{' },
        },
      },
    }),
  ).toBeNull();
});

it('tags the replied-to agent on inline notification replies unless the user already wrote a live @handle', async () => {
  expect(formatNotificationReplyText('ship it', 'crayon')).toBe('@crayon ship it');
  expect(formatNotificationReplyText('ship it', '@crayon')).toBe('@crayon ship it');
  expect(formatNotificationReplyText('@crayon ship it', 'crayon')).toBe('@crayon ship it');
  expect(formatNotificationReplyText('ask @speedy to check', 'crayon')).toBe(
    'ask @speedy to check',
  );
  expect(formatNotificationReplyText('email bob@example.com', 'crayon')).toBe(
    '@crayon email bob@example.com',
  );
  expect(formatNotificationReplyText('check `@grunt` in logs', 'crayon')).toBe(
    '@crayon check `@grunt` in logs',
  );
  expect(formatNotificationReplyText('quoted "@grunt" line', 'crayon')).toBe(
    '@crayon quoted "@grunt" line',
  );
  expect(formatNotificationReplyText('> @grunt\nlooks good', 'crayon')).toBe(
    '@crayon\n> @grunt\nlooks good',
  );
  expect(
    formatNotificationReplyText('take a look\n\nFORWARDED FROM #beeline · @maya', 'crayon'),
  ).toBe('@crayon take a look\n\nFORWARDED FROM #beeline · @maya');
  expect(formatNotificationReplyText('plain human reply')).toBe('plain human reply');

  const sendReply = vi.fn(async () => {});
  const present = vi.fn(async () => {});
  const keys = new Set<string>();
  const payload = {
    actionIdentifier: 'reply',
    userText: 'looks good, merge it',
    notification: {
      request: {
        identifier: 'reply-agent-1',
        content: {
          body: 'Crayon: Opened PR #208',
          data: {
            categoryId: 'beeline-reply',
            channelId: 'corner-1',
            cornerId: 'corner-1',
            messageId: 'msg-1',
            authorName: 'Crayon',
            agentHandle: 'crayon',
          },
        },
      },
    },
  };
  await expect(
    handleNotificationAction(payload, {
      platform: 'android',
      decideGrant: vi.fn(),
      sendReply,
      newMessageId: () => 'reply-msg-1',
      present,
      handled: {
        has: async (key: string) => keys.has(key),
        add: async (key: string) => {
          keys.add(key);
        },
      },
      inFlight: new Map(),
    }),
  ).resolves.toBe('done');
  expect(sendReply).toHaveBeenCalledWith({
    roomId: 'corner-1',
    parentMessageId: 'msg-1',
    text: '@crayon looks good, merge it',
    messageId: 'reply-msg-1',
  });
  expect(present).toHaveBeenCalledWith(
    expect.objectContaining({
      body: 'Crayon: Opened PR #208\nYou: @crayon looks good, merge it',
      subtitle: 'Replied',
    }),
  );
});

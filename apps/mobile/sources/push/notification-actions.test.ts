import { expect, it, vi } from 'vitest';
import { handleNotificationAction, readNotificationAction } from './notification-actions';

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

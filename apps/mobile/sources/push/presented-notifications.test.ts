import { beforeEach, expect, it, vi } from 'vitest';

const platformState = vi.hoisted(() => ({ OS: 'ios' as string }));
const notificationsLoaded = vi.hoisted(() => vi.fn());
const notificationsApi = vi.hoisted(() => ({
  getPresentedNotificationsAsync: vi.fn(async () => [] as Array<{ request: { identifier: string; content?: { data?: unknown } } }>),
  dismissNotificationAsync: vi.fn(async () => {}),
  setBadgeCountAsync: vi.fn(async () => {}),
}));

vi.mock('react-native', () => ({ Platform: platformState }));
vi.mock('expo-notifications', () => {
  notificationsLoaded();
  return notificationsApi;
});

import {
  dismissNativePresentedNotificationsForChannel,
  dismissNativePresentedNotificationsForChannels,
  dismissPresentedNotificationsForChannels,
} from './presented-notifications';
import { ACTION_OUTCOME_DATA_KEY } from './notification-actions';

beforeEach(() => {
  platformState.OS = 'ios';
  notificationsLoaded.mockClear();
  notificationsApi.getPresentedNotificationsAsync.mockReset().mockResolvedValue([]);
  notificationsApi.dismissNotificationAsync.mockReset().mockResolvedValue(undefined);
  notificationsApi.setBadgeCountAsync.mockReset().mockResolvedValue(undefined);
});

it('dismisses a read card from an Expo envelope while a later unread card stays presented', async () => {
  const presented = ['read', 'cursor', 'later'].map(eventId => ({
    request: { identifier: eventId, content: { data: { data: { type: 'agent-attention', channelId: 'chat', eventId } } } },
  }));
  const api = {
    getPresentedNotificationsAsync: async () => presented,
    dismissNotificationAsync: vi.fn(async () => {}),
    setBadgeCountAsync: vi.fn(async () => {}),
  };
  await dismissPresentedNotificationsForChannels([{ channelId: 'chat', messageId: 'cursor', readMessageIds: ['read'] }], api, 'ios');
  expect(api.dismissNotificationAsync.mock.calls).toEqual([['read'], ['cursor']]);
  expect(api.setBadgeCountAsync).not.toHaveBeenCalled();
});

it('uses a foreign Android notification tag to clear only the read message in its own Room', async () => {
  const entry = (channel: string, message: string) => ({
    request: { identifier: 'expo-notifications://foreign_notifications?tag=' + encodeURIComponent(channel + ':' + message) },
  });
  const read = entry('room', 'read');
  const api = { getPresentedNotificationsAsync: async () => [read, entry('room', 'later'), entry('other', 'read')],
    dismissNotificationAsync: vi.fn(async () => {}), setBadgeCountAsync: vi.fn(async () => {}) };
  await dismissPresentedNotificationsForChannels([{ channelId: 'room', messageId: 'read' }], api, 'android');
  expect(api.dismissNotificationAsync).toHaveBeenCalledExactlyOnceWith(read.request.identifier);
});

it('skips expo-notifications completely on non-native platforms', async () => {
  vi.resetModules();
  platformState.OS = 'web';
  const fresh = await import('./presented-notifications');

  await fresh.dismissNativePresentedNotificationsForChannel('room-a');
  await fresh.dismissNativePresentedNotificationsForChannels(
    [{ channelId: 'room-a', messageId: 'm1', readMessageIds: ['m1'] }],
    { keepActionOutcomes: true },
  );

  expect(notificationsLoaded).not.toHaveBeenCalled();
  expect(notificationsApi.getPresentedNotificationsAsync).not.toHaveBeenCalled();
  expect(notificationsApi.dismissNotificationAsync).not.toHaveBeenCalled();
});

it.each(['ios', 'android'] as const)(
  'dismisses matching channel notifications on %s through the native helper',
  async (os) => {
    platformState.OS = os;
    notificationsApi.getPresentedNotificationsAsync.mockResolvedValue([
      {
        request: {
          identifier: 'room-alert',
          content: { data: { type: 'channel-activity', channelId: 'room-a', messageId: 'm1' } },
        },
      },
      {
        request: {
          identifier: 'other-alert',
          content: { data: { type: 'channel-activity', channelId: 'room-b', messageId: 'm2' } },
        },
      },
    ]);

    await dismissNativePresentedNotificationsForChannel('room-a');

    expect(notificationsApi.dismissNotificationAsync).toHaveBeenCalledExactlyOnceWith('room-alert');
  },
);

it.each(['ios', 'android'] as const)(
  'dismisses read-cursor notifications on %s while preserving action outcomes when requested',
  async (os) => {
    platformState.OS = os;
    notificationsApi.getPresentedNotificationsAsync.mockResolvedValue([
      {
        request: {
          identifier: 'read-alert',
          content: { data: { type: 'channel-activity', channelId: 'room-a', messageId: 'm1' } },
        },
      },
      {
        request: {
          identifier: 'reply-outcome',
          content: {
            data: {
              type: 'channel-activity',
              channelId: 'room-a',
              messageId: 'm1',
              [ACTION_OUTCOME_DATA_KEY]: 'true',
            },
          },
        },
      },
      {
        request: {
          identifier: 'unread-alert',
          content: { data: { type: 'channel-activity', channelId: 'room-a', messageId: 'm2' } },
        },
      },
    ]);

    await dismissNativePresentedNotificationsForChannels(
      [{ channelId: 'room-a', messageId: 'm1', readMessageIds: ['m1'] }],
      { keepActionOutcomes: true },
    );

    expect(notificationsApi.dismissNotificationAsync).toHaveBeenCalledExactlyOnceWith('read-alert');
  },
);

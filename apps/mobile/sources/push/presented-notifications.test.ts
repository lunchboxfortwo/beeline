import { expect, it, vi } from 'vitest';
import { dismissPresentedNotificationsForChannels } from './presented-notifications';

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

import { Platform } from 'react-native';
import { getBuzzNotificationTargetFromData } from '@/utils/notificationRouting';
import type { PushLevel } from '@beeline/api-contract/phone';
import { ACTION_OUTCOME_DATA_KEY } from './notification-actions';

export type PresentedNotification = {
  request: {
    identifier: string;
    content?: { data?: unknown };
  };
};

export type PresentedNotificationApi = {
  getPresentedNotificationsAsync(): Promise<readonly PresentedNotification[]>;
  dismissNotificationAsync(identifier: string): Promise<void>;
  setBadgeCountAsync(count: number): Promise<unknown>;
};

export type PresentedNotificationStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

const LEGACY_PRESENTED_NOTIFICATIONS_CLEARED_KEY = '@beeline/push/android-room-tag-migration/v1';
const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Read the Android notification tag Expo retains for system-presented rows. */
export function presentedNotificationIdentifierTag(identifier: string): string | null {
  const prefix = 'expo-notifications://foreign_notifications?';
  if (!identifier.startsWith(prefix)) return null;
  const query = identifier.slice(prefix.length).split('#', 1)[0] ?? '';
  for (const field of query.split('&')) {
    const separator = field.indexOf('=');
    if (separator < 0 || field.slice(0, separator) !== 'tag') continue;
    try {
      const tag = decodeURIComponent(field.slice(separator + 1).replace(/\+/g, ' ')).trim();
      return tag || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Match data-rich Expo rows first, then Android's data-less foreign-row tag.
 * Only the conversation that opened matches: a Room never claims its corners'
 * pushes, and a corner never claims its Room's.
 */
export function presentedNotificationMatchesChannel(
  notification: PresentedNotification,
  openedChannelId: string,
): boolean {
  const target = getBuzzNotificationTargetFromData(notification.request.content?.data);
  if (target) {
    return (
      target.target !== 'workspace' &&
      (target.channelId === openedChannelId || target.cornerId === openedChannelId)
    );
  }
  const tag = presentedNotificationIdentifierTag(notification.request.identifier);
  return tag === openedChannelId || Boolean(tag?.startsWith(openedChannelId + ':'));
}

/** Remove pre-Room-tag Android rows once; their original destination is unrecoverable. */
export async function clearLegacyPresentedNotificationsOnce(
  api: PresentedNotificationApi,
  platform: string,
  storage: PresentedNotificationStorage,
): Promise<void> {
  if (platform !== 'android') return;
  if (await storage.getItem(LEGACY_PRESENTED_NOTIFICATIONS_CLEARED_KEY)) return;

  const presented = await api.getPresentedNotificationsAsync();
  const legacyIds = presented.flatMap((notification) => {
    const target = getBuzzNotificationTargetFromData(notification.request.content?.data);
    const tag = presentedNotificationIdentifierTag(notification.request.identifier);
    return !target && (!tag || !ROOM_ID.test(tag.split(':', 1)[0]!)) ? [notification.request.identifier] : [];
  });
  await Promise.all(legacyIds.map((identifier) => api.dismissNotificationAsync(identifier)));
  await storage.setItem(LEGACY_PRESENTED_NOTIFICATIONS_CLEARED_KEY, '1');
}

// APNs supplies the unread total on delivery and read clear. The shade can contain fewer entries.
export async function reconcilePresentedNotificationBadge(
  api: PresentedNotificationApi,
  _platform: string,
  pushLevel: PushLevel = 'attention',
): Promise<void> {
  if (pushLevel === 'off') await api.setBadgeCountAsync(0);
}

/** Dismiss every presented push for the Room or corner that is now open. */
export async function dismissPresentedNotificationsForChannel(
  channelId: string,
  api: PresentedNotificationApi,
  platform: string,
): Promise<void> {
  await dismissPresentedNotificationsForChannels([{ channelId }], api, platform);
}

/** An Android row rewritten to confirm a tapped action, such as "Replied". */
function isActionOutcome(notification: PresentedNotification): boolean {
  const data = notification.request.content?.data;
  return Boolean(
    data &&
    typeof data === 'object' &&
    (data as Record<string, unknown>)[ACTION_OUTCOME_DATA_KEY] === 'true',
  );
}

function presentedMessageId(notification: PresentedNotification, channelId: string): string | null {
  const target = getBuzzNotificationTargetFromData(notification.request.content?.data);
  if (target) return target.messageId ?? null;
  const tag = presentedNotificationIdentifierTag(notification.request.identifier);
  return tag?.startsWith(channelId + ':') ? tag.slice(channelId.length + 1) : null;
}

export type ChannelRead = {
  channelId: string;
  /** The server read cursor: the last read message. Absent = clear everything. */
  messageId?: string | null;
  /** The other read messages the server pushed to this device. */
  readMessageIds?: readonly string[];
};

function isNativeNotificationPlatform(): boolean {
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

/** Dismiss every presented push for an open Room or corner on native platforms. */
export async function dismissNativePresentedNotificationsForChannel(
  channelId: string,
): Promise<void> {
  if (!isNativeNotificationPlatform()) return;
  const api = await import('expo-notifications');
  await dismissPresentedNotificationsForChannel(channelId, api, Platform.OS);
}

/** Dismiss presented pushes for read Rooms or corners on native platforms. */
export async function dismissNativePresentedNotificationsForChannels(
  reads: readonly ChannelRead[],
  options: { keepActionOutcomes?: boolean } = {},
): Promise<void> {
  if (!isNativeNotificationPlatform()) return;
  const api = await import('expo-notifications');
  await dismissPresentedNotificationsForChannels(reads, api, Platform.OS, options);
}

/**
 * Dismiss presented pushes for these Rooms or corners — the ones opened here,
 * or read on another device. With a
 * read cursor, only the read messages' notifications go: the cursor's own and
 * those the server lists as read. The server orders messages, so a newer one
 * stays unread even when iOS presented it at the same second.
 */
export async function dismissPresentedNotificationsForChannels(
  reads: readonly ChannelRead[],
  api: PresentedNotificationApi,
  _platform: string,
  options: { keepActionOutcomes?: boolean } = {},
): Promise<void> {
  const readChannels = reads.flatMap((read) => {
    const channelId = read.channelId.trim();
    return channelId ? [{ ...read, channelId }] : [];
  });
  if (readChannels.length === 0) return;

  const presented = await api.getPresentedNotificationsAsync();
  const matchingIds = presented.flatMap((notification) =>
    !(options.keepActionOutcomes && isActionOutcome(notification)) &&
    readChannels.some((read) => {
      if (!presentedNotificationMatchesChannel(notification, read.channelId)) return false;
      if (!read.messageId) return true;
      const messageId = presentedMessageId(notification, read.channelId);
      return (
        messageId !== null &&
        (messageId === read.messageId || (read.readMessageIds ?? []).includes(messageId))
      );
    })
      ? [notification.request.identifier]
      : [],
  );
  await Promise.all(matchingIds.map((identifier) => api.dismissNotificationAsync(identifier)));
}

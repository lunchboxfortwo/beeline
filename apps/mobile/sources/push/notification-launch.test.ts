import { beforeEach, expect, it, vi } from 'vitest';
import { firebasePushMessage } from '../../../server/src/firebase-push';
import { mapNotificationContent } from '../../node_modules/expo-notifications/build/utils/mapNotificationResponse';
import { initialNotificationPath, routeBuzzNotificationResponse } from './notification-response';
import { getBuzzNotificationTargetFromData, notificationStackRoutes, resolveBuzzNotificationTarget, type BuzzNotificationTarget } from '@/utils/notificationRouting';
import { markInitialLandingResolved, resetInitialLandingForTests, suppressInitialLandingNavigation, isInitialLandingNavigationSuppressed } from '@/navigation/initial-landing';

const defaultAction = 'expo.modules.notifications.actions.DEFAULT';
const messageId = 'abcdef0123456789'.repeat(4);

beforeEach(resetInitialLandingForTests);

for (const corner of [false, true]) {
  for (const entry of ['cold', 'background', 'foreground']) {
    it(`opens the exact ${corner ? 'corner' : 'Room'} message immediately on a ${entry} tap`, async () => {
      const push = firebasePushMessage('test-device', {
        type: 'message', target: 'message', workspaceId: 'workspace', roomId: 'room',
        channelId: corner ? 'corner' : 'room', ...(corner ? { cornerId: 'corner' } : {}),
        messageId, text: 'An older message', collapseId: 'reused-android-slot',
      });
      let finishSelection!: () => void;
      if (entry !== 'cold') markInitialLandingResolved();
      const selection = new Promise<void>((resolve) => { finishSelection = resolve; });
      const openStack = vi.fn();
      const suppress = vi.fn(suppressInitialLandingNavigation);
      const route = routeBuzzNotificationResponse({
        actionIdentifier: defaultAction,
        notification: { request: { identifier: push.data!.tag,
          content: mapNotificationContent({ data: push.data } as never) } },
      }, {
        navigator: { openStack }, handled: new Set(), defaultActionIdentifier: defaultAction,
        waitForRootReady: async () => {},
        suppressPendingInitialLanding: suppress,
        clearLastResponse: async () => {},
        resolveTarget: async (target: BuzzNotificationTarget) => { await selection; return target; },
        log: () => {},
      });
      try {
        await vi.waitFor(() => expect(openStack).toHaveBeenCalledOnce());
        const stack = openStack.mock.calls[0]![0];
        expect(stack.at(-1)).toMatchObject({ name: 'beeline/chat/[channelId]', params: {
          channelId: corner ? 'corner' : 'room', communityId: 'workspace',
          notificationMessageId: messageId, notificationResponseId: messageId,
          ...(corner ? { parent: 'room' } : {}),
        } });
        expect(suppress).toHaveBeenCalledOnce();
        expect(isInitialLandingNavigationSuppressed()).toBe(true);
        expect(suppress.mock.invocationCallOrder[0]).toBeLessThan(openStack.mock.invocationCallOrder[0]!);
      } finally {
        finishSelection(); await route;
      }
    });
  }
}

for (const corner of [false, true]) {
  it(`seeds cold Expo startup directly with the ${corner ? 'corner' : 'Room'} and full message id`, async () => {
    const push = firebasePushMessage('device', {
      type: 'message', target: 'message', workspaceId: 'workspace', roomId: 'room',
      channelId: corner ? 'corner' : 'room', ...(corner ? { cornerId: 'corner' } : {}),
      messageId, text: 'Cold notification',
    });
    const response = { actionIdentifier: defaultAction,
      notification: { request: { identifier: 'android-slot', content: { data: push.data } } } };
    const entries = { getLastResponse: async () => response, defaultActionIdentifier: defaultAction,
      consumedResponses: { has: vi.fn(async () => false), add: vi.fn(async () => {}) } };
    const path = await initialNotificationPath('beeline:///', entries);
    const url = new URL(path, 'https://web.usebeeline.app');
    expect(url.pathname).toBe(`/beeline/chat/${corner ? 'corner' : 'room'}`);
    expect(url.searchParams.get('notificationMessageId')).toBe(messageId);
    expect(url.searchParams.get('notificationResponseId')).toBe(messageId);
    expect(url.searchParams.get('communityId')).toBe('workspace');
    if (corner) expect(url.searchParams.get('parent')).toBe('room');
    expect(entries.consumedResponses.add).not.toHaveBeenCalled();
    entries.consumedResponses.has.mockResolvedValue(true);
    expect(await initialNotificationPath('/', entries)).toBe('/');
  });
}

it.each([
  '/beeline/chat/explicit?notificationMessageId=message',
  'beeline://review/secret',
  'https://web.usebeeline.app/beeline/chat/room?notificationMessageId=message',
])('preserves the explicit launch URL %s', async (path) => {
  const getLastResponse = vi.fn(async () => null);
  expect(await initialNotificationPath(path, { getLastResponse, defaultActionIdentifier: defaultAction })).toBe(path);
  expect(getLastResponse).not.toHaveBeenCalled();
});

it('keeps ordinary startup when native replay is absent, an inline action, malformed, or unavailable', async () => {
  for (const getLastResponse of [
    async () => null,
    async () => ({ actionIdentifier: 'beeline.reply' }),
    async () => ({ actionIdentifier: defaultAction, notification: { request: { content: { data: 'bad JSON' } } } }),
    async () => { throw new Error('unsupported native getter'); },
  ]) expect(await initialNotificationPath('/', { getLastResponse, defaultActionIdentifier: defaultAction })).toBe('/');
});

it('keeps an archived corner as the source of a complete message payload', async () => {
  const target = getBuzzNotificationTargetFromData({ type: 'channel-activity', target: 'corner',
    workspaceId: 'workspace', roomId: 'room', channelId: 'corner', cornerId: 'corner', messageId })!;
  const readRoom = vi.fn(async () => ({ room: { id: 'corner', parentId: 'room', archived: true } }));
  const activateWorkspace = vi.fn(async () => {});
  expect(await resolveBuzzNotificationTarget(target, { readRoom, activateWorkspace })).toEqual(target);
  expect(readRoom).not.toHaveBeenCalled();
  expect(activateWorkspace).toHaveBeenCalledWith('workspace');
  expect(notificationStackRoutes(target, messageId).at(-1)?.params.notificationMessageId).toBe(messageId);
});

it('claims a cold tap before startup restoration but dispatches only after navigator readiness', async () => {
  let ready!: () => void;
  const root = new Promise<void>((resolve) => { ready = resolve; });
  const openStack = vi.fn();
  const route = routeBuzzNotificationResponse({ actionIdentifier: defaultAction,
    notification: { request: { identifier: 'slot', content: { data: {
      type: 'channel-activity', target: 'message', workspaceId: 'workspace',
      roomId: 'room', channelId: 'room', messageId,
    } } } },
  }, {
    navigator: { openStack }, handled: new Set(), defaultActionIdentifier: defaultAction,
    waitForRootReady: () => root, suppressPendingInitialLanding: suppressInitialLandingNavigation,
    clearLastResponse: async () => {}, resolveTarget: async (target) => target, log: () => {},
  });
  expect(isInitialLandingNavigationSuppressed()).toBe(true);
  expect(openStack).not.toHaveBeenCalled();
  ready(); await route;
  expect(openStack).toHaveBeenCalledOnce();
});


it('opens the chat for a retained notification naming the retired Threads page', () => {
  const target = getBuzzNotificationTargetFromData({
    type: 'channel-activity', workspaceId: 'workspace', roomId: 'room', channelId: 'room',
    target: 'corners', route: '/beeline/corners/room', returnTo: 'corners',
  })!;
  expect(notificationStackRoutes(target, 'legacy-tap')).toEqual([
    { name: 'beeline/channels', params: { communityId: 'workspace' } },
    { name: 'beeline/chat/[channelId]', params: {
      channelId: 'room', communityId: 'workspace', notificationResponseId: 'legacy-tap',
      returnTo: 'room-list', notificationTarget: 'message',
    } },
  ]);
});

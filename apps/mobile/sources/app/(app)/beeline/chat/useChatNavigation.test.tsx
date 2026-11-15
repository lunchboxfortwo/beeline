import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import { StackActions, StackRouter } from '@react-navigation/routers';
import { cornerHref, messageJumpHref } from '@/buzz/corner-navigation';
import { notificationStackRoutes } from '@/utils/notificationRouting';

const fixture = vi.hoisted(() => ({
  back: vi.fn(), dismiss: vi.fn(), replace: vi.fn(),
  hardwareBack: undefined as undefined | (() => boolean), remove: vi.fn(),
}));
vi.mock('expo-router', async () => {
  const React = await import('react');
  return {
    router: { back: fixture.back, dismiss: fixture.dismiss, replace: fixture.replace },
    useFocusEffect: (effect: () => unknown) => React.useEffect(effect as () => void, [effect]),
  };
});
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  BackHandler: { addEventListener: (_: string, handler: () => boolean) => {
    fixture.hardwareBack = handler;
    return { remove: fixture.remove };
  } },
}));
vi.mock('@/buzz/chat-attachment', () => ({ MAX_MESSAGE_ATTACHMENTS: 10 }));
vi.mock('@/sync/transport', () => ({ BuzzRigTransport: class {} }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
import { useChatNavigation } from './useChatNavigation';

const options = {
  routeNames: ['beeline/channels', 'beeline/tray', 'beeline/chat/[channelId]'],
  routeParamList: {}, routeGetIdList: {},
};
const stackRouter = StackRouter({ initialRouteName: 'beeline/channels' });
const chat = (channelId: string) => ({ name: 'beeline/chat/[channelId]', params: { channelId } });

beforeEach(() => {
  vi.clearAllMocks();
  fixture.hardwareBack = undefined;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

for (const source of ['chat', 'Chats list', 'Tasks', 'notification', 'cold start', 'legacy return hint']) {
  it.each(['header', 'Android back'])(`back from a thread opened from ${source} lands on its chat (%s)`, (control) => {
    const href = cornerHref('thread', 'room', 'Thread') as { params: Record<string, string> };
    // Tasks opens a bare message route; the screen's Room read supplies its parent.
    const thread = { name: 'beeline/chat/[channelId]', params: source === 'Tasks'
      ? messageJumpHref('thread', 'message', 'work:message', 'workspace').params : href.params };
    const routes = source === 'notification'
      ? notificationStackRoutes({ type: 'message', target: 'corner', workspaceId: 'workspace', roomId: 'room', channelId: 'thread' }, 'tap')
      : source === 'chat' ? [{ name: 'beeline/channels' }, chat('room'), thread]
      : source === 'Tasks' ? [{ name: 'beeline/tray' }, thread]
      : source === 'cold start' ? [thread]
      : [{ name: 'beeline/channels' }, thread];
    let state = stackRouter.getRehydratedState({ stale: true, routes }, options);
    const dispatch = (action: ReturnType<typeof StackActions.pop> | ReturnType<typeof StackActions.replace>) => {
      const next = stackRouter.getStateForAction(state, action, options);
      if (!next) throw new Error('Unhandled back navigation');
      state = stackRouter.getRehydratedState(next, options);
    };
    fixture.back.mockImplementation(() => dispatch(StackActions.pop(1)));
    fixture.dismiss.mockImplementation((count) => dispatch(StackActions.pop(count)));
    fixture.replace.mockImplementation((destination) => dispatch(StackActions.replace('beeline/chat/[channelId]', destination.params)));
    const drain = { setActive: vi.fn() };
    let handleBack!: () => void;
    function Harness() {
      const result = useChatNavigation([
        drain, { getState: () => state }, 'room', source === 'legacy return hint' ? 'room-list' : undefined,
        null, 'thread', vi.fn(), false, vi.fn(), vi.fn(), vi.fn(), null, false, [], vi.fn(),
      ] as unknown as Parameters<typeof useChatNavigation>[0]);
      handleBack = result[2];
      return null;
    }
    let tree: any;
    act(() => { tree = create(<Harness />); });
    act(() => { if (control === 'header') handleBack(); else expect(fixture.hardwareBack?.()).toBe(true); });
    expect(state.routes[state.index]).toMatchObject(chat('room'));
    expect(drain.setActive).toHaveBeenCalledWith(false);
    act(() => tree.unmount());
    expect(fixture.remove).toHaveBeenCalledOnce();
  });
}

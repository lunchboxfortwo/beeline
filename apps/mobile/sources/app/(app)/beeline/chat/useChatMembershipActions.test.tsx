import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => ({
  replace: vi.fn(),
  readChatList: vi.fn(),
  closeChat: vi.fn(async () => undefined),
  leaveRoom: vi.fn(async () => undefined),
  deleteRoom: vi.fn(async () => undefined),
}));
vi.mock('expo-router', () => ({ router: { replace: actions.replace } }));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('@/buzz/chat-list-store', () => ({ readChatList: actions.readChatList }));
vi.mock('@/modal', () => ({ Modal: { confirm: vi.fn(async () => true) } }));
import { useChatMembershipActions } from './useChatMembershipActions';

it.each(['close', 'leave', 'delete'] as const)(
  'reconciles the list before navigating after %s',
  async (action) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    actions.replace.mockClear();
    actions.readChatList.mockClear();
    let finishRead!: () => void;
    actions.readChatList.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRead = resolve;
      }),
    );
    const key = {
      relayUrl: 'https://server.test',
      viewerPubkey: 'viewer',
      workspaceId: 'workspace',
    };
    let lifecycle!: ReturnType<typeof useChatMembershipActions>[3];
    function Fixture() {
      const args: unknown[] = Array.from({ length: 22 }, () => vi.fn());
      Object.assign(args, {
        0: actions,
        1: 'workspace',
        2: true,
        4: 'room',
        7: false,
        9: 'Room',
        10: null,
        12: false,
        15: '',
        16: false,
        17: true,
        21: key,
      });
      [, , , lifecycle] = useChatMembershipActions(
        args as Parameters<typeof useChatMembershipActions>[0],
      );
      return null;
    }
    let tree: any;
    act(() => {
      tree = create(<Fixture />);
    });
    let pending!: Promise<void>;
    await act(async () => {
      pending = lifecycle(action);
    });
    expect(actions.readChatList).toHaveBeenCalledExactlyOnceWith(key, true);
    expect(actions.replace).not.toHaveBeenCalled();
    await act(async () => {
      finishRead();
      await pending;
    });
    expect(actions.replace).toHaveBeenCalledExactlyOnceWith({
      pathname: '/beeline/channels',
      params: { communityId: 'workspace' },
    });
    act(() => tree.unmount());
  },
);

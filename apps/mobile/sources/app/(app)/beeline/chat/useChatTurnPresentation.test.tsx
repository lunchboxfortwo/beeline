import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('react-native-keyboard-controller', () => ({
  useKeyboardState: () => 0, useReanimatedKeyboardAnimation: () => ({ progress: { value: 0 } }),
}));
vi.mock('react-native-reanimated', () => ({ useAnimatedStyle: (fn: () => unknown) => fn() }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('./send-confirmation', () => ({ useSendConfirmationReceipts: () => undefined }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: vi.fn(), phoneOperationFailureReason: vi.fn() }));
import { useChatTurnPresentation } from './useChatTurnPresentation';

it.each([true, false])('resolves an offscreen parent on the first reply render (sender=%s)', (isUser) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const parent: ChatDisplayMessage = { id: 'turn:parent', relayId: 'parent', text: 'Original quote', timestamp: 1, isUser: false };
  const reply: ChatDisplayMessage = { id: 'reply', text: 'Answer', timestamp: 2, isUser, replyToId: 'parent' };
  const no = () => undefined;
  const scroll = { isPinnedToTail: () => true, isUserDragging: () => false, follow: no };
  let index!: Map<string, ChatDisplayMessage>;
  function Harness() {
    const args = [[reply], null, [], no, null, undefined, no, false, null, 'viewer', new Map(), new Map(),
      { bottom: 0 }, 0, scroll, 'room', no, false, no, {}, no, 0, [parent, reply]];
    [, , index] = useChatTurnPresentation(args as unknown as Parameters<typeof useChatTurnPresentation>[0]);
    return <blockquote>{index.get(reply.replyToId!)?.text}</blockquote>;
  }
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(<Harness />); });
  try {
    expect(tree.root.findByType('blockquote').props.children).toBe('Original quote');
    expect(index.get(parent.id)).toBe(parent);
  } finally { act(() => tree.unmount()); }
});

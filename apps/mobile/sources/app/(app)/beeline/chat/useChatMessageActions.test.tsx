import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { createTranscriptScrollController } from '@/buzz/transcript-scroll-controller';
import { scrollFollowOnLayoutChange } from '@/buzz/room-scroll-follow';

vi.mock('react-native', () => ({ AccessibilityInfo: { announceForAccessibility: vi.fn() } }));
vi.mock('@/modal', () => ({ Modal: {} }));
vi.mock('@/buzz/chat-list-store', () => ({ readChatList: vi.fn() }));
vi.mock('@/buzz/room-message-records', () => ({ roomMessageRecord: vi.fn(), writeRoomBookmark: vi.fn() }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: vi.fn(), phoneOperationFailureReason: vi.fn() }));
vi.mock('@/buzz/message-forward', () => ({ forwardMessageToRoom: vi.fn(), forwardTargets: vi.fn(), resolveForwardTargetRoom: vi.fn() }));

import { useChatMessageActions } from './useChatMessageActions';

it.each([false, true])('swipe-reply-1: replying preserves the reading offset (tail=%s)', (atTail) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const message = {
    id: 'long-message', text: 'Reading marker. '.repeat(240), isUser: false,
    timestamp: 1, pubkey: 'reader', reference: { channelId: 'room' },
  } as ChatDisplayMessage;
  let offset = atTail ? 0 : 1200;
  const initialOffset = offset;
  const frames: Array<() => void> = [];
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frames.push(callback); return frames.length; });
  const controller = createTranscriptScrollController<ChatDisplayMessage>({
    rows: () => [message], rowIndex: () => 0,
    list: () => ({
      toNewest: () => { offset = 0; }, toOffset: (next) => { offset = next; },
      toRow: () => true, toEstimatedRow: () => {}, shiftBy: () => {},
    }),
    schedule: (callback) => { frames.push(callback); },
  });
  controller.observeTailPinned(atTail);
  const focus = vi.fn();
  const setReplyTarget = vi.fn();
  let beginReply!: (message: ChatDisplayMessage) => void;
  function Fixture() {
    const props: unknown[] = Array.from({ length: 36 }, () => vi.fn());
    Object.assign(props, {
      0: new Map(), 1: new Map(), 2: { current: [message] }, 3: 'room',
      4: setReplyTarget, 6: { current: '' }, 7: { current: null },
      9: controller, 10: { current: { focus } },
    });
    [, , beginReply] = useChatMessageActions(props as Parameters<typeof useChatMessageActions>[0]);
    return null;
  }
  let renderer: ReturnType<typeof create>;
  try {
    act(() => { renderer = create(<Fixture />); });
    act(() => { beginReply(message); });
    act(() => { while (frames.length) frames.shift()!(); });
    expect(setReplyTarget).toHaveBeenCalledWith(expect.objectContaining({ messageId: message.id }));
    expect(focus).toHaveBeenCalledOnce();
    expect(offset).toBe(initialOffset);
    expect(controller.isPinnedToTail()).toBe(atTail);
    // The real keyboard/composer layout owner must retain history and still
    // follow a reader at the tail when the keyboard closes again.
    expect(scrollFollowOnLayoutChange({
      previousFootprint: 44, nextFootprint: 360,
      isPinnedToTail: controller.isPinnedToTail(), isUserDragging: false,
    })).toBe('hold');
    expect(scrollFollowOnLayoutChange({
      previousFootprint: 360, nextFootprint: 44,
      isPinnedToTail: controller.isPinnedToTail(), isUserDragging: false,
    })).toBe(atTail ? 'scroll' : 'hold');
  } finally {
    act(() => renderer?.unmount());
    vi.unstubAllGlobals();
  }
});

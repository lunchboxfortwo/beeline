import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('@/buzz/room-scroll-follow', () => ({
  roomOpenLandsOnTail: () => false, useScrollFollowOnArrival: () => 'hold',
}));
vi.mock('@/buzz/room-message-store', () => ({ hostRowIndex: () => -1 }));
vi.mock('./chat-surface-values', () => ({ TAIL_PIN_THRESHOLD: 32 }));
import { useChatTranscriptLanding } from './useChatTranscriptLanding';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it.each(['room', 'corner'])('lands a canonical %s message URL without a push response id after its Room read', async (roomId) => {
  const messageId = '0123456789abcdef'.repeat(4);
  const request = vi.fn();
  const jump = vi.fn();
  const handled = { current: null };
  const controller = { request, observeTailPinned: vi.fn(), isPinnedToTail: () => false, isUserDragging: () => false };
  const liveDrafts = { subscribeCommit: () => () => {} };
  const noop = () => {};
  function Transcript({ ready }: { ready: boolean }) {
    useChatTranscriptLanding([
      controller, noop, false, noop, [], null, roomId === 'corner', null, messageId, roomId,
      noop, liveDrafts, { call: null }, [], undefined, messageId, undefined, handled,
      { current: new Map() }, () => false, {}, 'viewer', ready ? { room: { id: roomId } } : null,
      jump, false, 'idle', { current: null }, noop,
    ] as unknown as Parameters<typeof useChatTranscriptLanding>[0]);
    return null;
  }
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(<Transcript ready={false} />); });
    expect(request).not.toHaveBeenCalled();
    await act(async () => renderer.update(<Transcript ready />));
    expect(request).toHaveBeenCalledExactlyOnceWith({ kind: 'message', messageId, align: 'top', jump: true });
    expect(jump).toHaveBeenCalledExactlyOnceWith(messageId);
    await act(async () => renderer.update(<Transcript ready />));
    expect(request).toHaveBeenCalledOnce();
  } finally { if (renderer) await act(async () => renderer.unmount()); }
});

it.each([false, true])('lands each new opening boundary once (corner %s)', async isCorner => {
  const roomId = isCorner ? 'warm-thread' : 'warm-chat';
  const { spendUnreadLine } = await import('@/buzz/unread-line-ticket');
  spendUnreadLine(roomId, 'previous');
  const request = vi.fn();
  const controller = { request, isPinnedToTail: () => false, isUserDragging: () => false };
  const noop = () => {};
  function Transcript({ boundary }: { boundary: string }) {
    useChatTranscriptLanding([
      controller, noop, false, noop, [], null, isCorner, boundary, '', roomId,
      noop, { subscribeCommit: () => noop }, {}, [], undefined, undefined, undefined,
      { current: null }, { current: new Map() }, noop, null, '', null, noop, false, 'idle',
      { current: null }, noop,
    ] as unknown as Parameters<typeof useChatTranscriptLanding>[0]);
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<Transcript boundary="previous" />); });
  expect(request).not.toHaveBeenCalled();
  await act(async () => renderer.update(<Transcript boundary="next" />));
  await act(async () => renderer.update(<Transcript boundary="next" />));
  expect(request).toHaveBeenCalledExactlyOnceWith({ kind: 'firstUnread', messageId: 'next' });
  await act(async () => renderer.unmount());
});

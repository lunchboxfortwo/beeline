import { controls, roomView, Harness, flushEffects } from './test-support-useRoomSurfaceSession.test-support.js';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { router } from 'expo-router';
import { RoomViewHttpError } from '@beeline/buzz-client';
import { setRestoredPage } from '@/navigation/restored-page';

it.each(['deleted', 'removed', 'closed'])('silently replaces a %s restored thread with the ordinary start', async reason => {
  const forget = vi.fn();
  setRestoredPage('/beeline/chat/room-a', forget);
  if (reason === 'closed') {
    const view = roomView('room-a');
    controls.roomResponse = { ...view, room: { ...view.room, archived: true } };
  } else controls.roomError = new RoomViewHttpError(reason === 'deleted' ? 404 : 403, reason);
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(React.createElement(Harness, { channelId: 'room-a', capture: () => {} })); });
  await flushEffects();
  expect(router.replace).toHaveBeenCalledWith('/');
  expect(forget).toHaveBeenCalledOnce();
  expect(tree!.root.findByType('room-surface').props.error).toBeNull();
  await act(async () => tree.unmount());
});

it('keeps an offline restoration on its page for normal connection recovery', async () => {
  const forget = vi.fn();
  setRestoredPage('/beeline/chat/room-a', forget);
  controls.roomError = new Error('offline');
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(React.createElement(Harness, { channelId: 'room-a', capture: () => {} })); });
  await flushEffects();
  expect(router.replace).not.toHaveBeenCalled();
  expect(forget).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
  setRestoredPage(null);
});

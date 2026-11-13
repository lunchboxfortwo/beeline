import { controls, roomView, Harness, flushEffects } from './test-support-useRoomSurfaceSession.test-support.js';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { router } from 'expo-router';
import { expect, it } from 'vitest';
import type { RoomView } from '@beeline/buzz-client';
import type { UseRoomSurfaceSessionResult } from './useRoomSurfaceSession';

it.each(['archived', 'done'])('keeps a tapped message in its %s corner after the fresh Room read', async (state) => {
  const original = roomView('closed-corner');
  const view: RoomView = {
    ...original,
    room: { ...original.room, parentId: 'parent-room', archived: state === 'archived' },
    ...(state === 'done' ? { cornerLifecycle: { lifecycle: 'done' } as RoomView['cornerLifecycle'] } : {}),
    messages: [{ id: 'pushed-message', text: 'The message in the closed corner', createdAt: 1,
      presentation: 'message', author: { pubkey: 'ruby', kind: 'human', name: 'Ruby' } }],
  };
  controls.cached = null;
  controls.roomResponse = view;
  let current!: UseRoomSurfaceSessionResult;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(React.createElement(Harness, {
        channelId: 'closed-corner', notificationResponseId: 'pushed-message',
        capture: (session) => { current = session; },
      }));
    });
    await flushEffects();
    expect(router.replace).not.toHaveBeenCalled();
    expect(current.roomSurface?.room.id).toBe('closed-corner');
    expect(current.roomSurface?.messages[0]?.id).toBe('pushed-message');
  } finally {
    if (renderer) await act(async () => renderer.unmount());
  }
});

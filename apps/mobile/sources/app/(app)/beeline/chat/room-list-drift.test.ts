import { controls, roomView, Harness, flushEffects } from './test-support-useRoomSurfaceSession.test-support';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it } from 'vitest';
import type { UseRoomSurfaceSessionResult } from './useRoomSurfaceSession';

it('keeps an open Room on the shared response after its opening read and a later read failure', async () => {
  controls.hotViewer = true;
  controls.cached = roomView('room-a');
  controls.roomResponse = controls.cached;
  let current!: UseRoomSurfaceSessionResult;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(Harness, { channelId: 'room-a', capture: value => { current = value; } }));
  });
  await flushEffects();
  controls.roomError = new Error('Transport unavailable');
  await act(async () => current.readRoom());
  await flushEffects();
  await act(async () => {
    controls.cached = { ...roomView('room-a'), messages: [{ id: 'reply', text: 'Ordered Muse.', createdAt: 20,
      author: { pubkey: 'ruby', kind: 'agent', name: 'Ruby' }, presentation: 'message' }] };
    controls.cacheListeners.forEach(listener => listener());
  });
  try {
    expect(current.roomSurface?.messages.at(-1)?.text).toBe('Ordered Muse.');
    expect(controls.roomReads).toBe(2);
  } finally {
    await act(async () => renderer.unmount());
  }
});

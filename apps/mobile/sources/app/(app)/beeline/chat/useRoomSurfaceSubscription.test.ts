import { controls, roomView, Harness, flushEffects } from './test-support-useRoomSurfaceSession.test-support.js';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it } from 'vitest';
import { MonolithRequestTimeoutError } from '@/auth/monolith-session';
import { PhoneSocketDisconnectedError } from '@/sync/transport/phone-socket-error';
import type { UseRoomSurfaceSessionResult } from './useRoomSurfaceSession';

it.each([
  ['disconnect', new PhoneSocketDisconnectedError()],
  ['deadline', Object.assign(new MonolithRequestTimeoutError(), { socketRequest: true })],
])('mounts a cold transcript on first subscription after an opening %s', async (_kind, error) => {
  controls.connectionReady = false;
  controls.roomError = error;
  let current!: UseRoomSurfaceSessionResult;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(Harness, {
      channelId: 'room-a', capture: (value: UseRoomSurfaceSessionResult) => { current = value; },
    }));
  });
  await flushEffects();
  try {
    expect(controls.roomReads).toBe(1);
    expect(current.roomSurface).toBeNull();
    expect(current.hydrationError).toBeNull();
    expect(renderer.root.findAllByType('message-row')).toHaveLength(0);

    const view = roomView('room-a');
    const text = 'Message from before the connection returned';
    controls.roomError = null;
    controls.roomResponse = {
      ...view,
      messages: [{
        id: 'opening-message', text, createdAt: 10, author: view.viewer.identity, presentation: 'message',
      }],
    };
    controls.connectionReady = true;
    controls.connectionGeneration++;
    const subscribed = () => controls.subscriptions[0]!.emit({
      monolithLive: { type: 'subscribed', roomId: 'room-a' },
    });
    await act(async () => {
      subscribed();
      subscribed();
    });

    expect(renderer.root.findAllByType('message-row')[0]?.props.children).toBe(text);
    expect(current.roomSurface?.room.id).toBe('room-a');
    expect(controls.roomReads).toBe(2);
  } finally {
    await act(async () => renderer.unmount());
  }
});

it('reads once on open and once per reconnect, including recovery after a failed reconcile', async () => {
  const working = {
    requestId: 'ruby-request', agentPubkey: 'ruby', status: 'working' as const,
    startedAt: 10, createdAt: 10, version: 1,
  };
  controls.roomResponse = { ...roomView('room-a'), latestAgentTurns: [working] };
  let current!: UseRoomSurfaceSessionResult;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(Harness, {
      channelId: 'room-a', capture: (value: UseRoomSurfaceSessionResult) => { current = value; },
    }));
  });
  await flushEffects();
  expect(current.roomSurface?.latestAgentTurns[0]?.status).toBe('working');
  expect(controls.roomReads).toBe(1);
  await act(async () => {
    controls.subscriptions[0]!.emit({ monolithLive: { type: 'subscribed', roomId: 'room-a' } });
  });
  expect(controls.roomReads).toBe(1);

  controls.roomError = new Error('Server process stopped');
  controls.connectionReady = false;
  await act(async () => {
    controls.subscriptions[0]!.emit({
      monolithLive: { type: 'invalidate', roomId: 'room-a', reason: 'reconnect' },
    });
  });
  expect(controls.roomReads).toBe(1);
  controls.connectionReady = true;
  controls.connectionGeneration++;
  await act(async () => {
    controls.subscriptions[0]!.emit({ monolithLive: { type: 'subscribed', roomId: 'room-a' } });
  });
  expect(controls.roomReads).toBe(2);
  expect(current.roomSurface?.latestAgentTurns[0]?.status).toBe('working');

  controls.roomError = null;
  controls.connectionGeneration++;
  controls.roomResponse = {
    ...roomView('room-a'),
    latestAgentTurns: [{ ...working, status: 'complete', version: 2 }],
    messages: [{
      id: 'ruby-answer', text: 'Ruby finished during server replacement.', createdAt: 20,
      author: { pubkey: 'ruby', kind: 'agent', name: 'Ruby' }, presentation: 'message',
      requestId: working.requestId,
    }],
  };
  const reads = controls.roomReads;
  // A later operation has reopened the socket. The new process acknowledges
  // subscription admission, but does not replay the missed turn/message deltas.
  await act(async () => {
    controls.subscriptions[0]!.emit({ monolithLive: { type: 'subscribed', roomId: 'room-a' } });
  });
  expect(controls.roomReads).toBe(reads + 1);
  expect(current.roomSurface?.latestAgentTurns[0]?.status).toBe('complete');
  expect(renderer.root.findAllByType('message-row').at(-1)?.props.children)
    .toBe('Ruby finished during server replacement.');
  await flushEffects();
  expect(controls.roomReads).toBe(reads + 1);
  expect(controls.subscriptions).toHaveLength(1);
  expect(controls.transportCount).toBe(1);
  expect(controls.explicitReconnects).toBe(0);
  await act(async () => renderer.unmount());
});

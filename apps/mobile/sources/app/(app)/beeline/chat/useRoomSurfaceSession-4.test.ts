import { controls, roomView, flushEffects } from './test-support-useRoomSurfaceSession.test-support.js';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it } from 'vitest';
import { useRoomMessageStore } from '@/buzz/room-message-store';
import BuzzChat from './[channelId]';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { type RoomViewMessage } from '@beeline/buzz-client';
import { type UseRoomSurfaceSessionResult } from './useRoomSurfaceSession';



it('isolates transcript windows, outbox and late send completion when a route changes Room', async () => {
  let current!: {
    session: UseRoomSurfaceSessionResult;
    overlay: ReturnType<typeof import('@/buzz/room-send-frame').useRoomSendFrame>;
    history: ReturnType<typeof useRoomMessageStore>;
  };
  controls.scopeProbe = (session, overlay, history) => {
    current = { session, overlay, history };
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(BuzzChat));
  });
  await flushEffects();
  const view = roomView('room-a');
  const row = {
    id: 'source-message',
    text: 'source only',
    createdAt: 1,
    author: view.viewer.identity,
    presentation: 'message',
  } as RoomViewMessage;
  await act(async () => controls.responses[0]!.apply({ ...view, messages: [row] }));
  await act(async () =>
    current.overlay.append([{ id: 'pending', text: 'pending source' } as ChatDisplayMessage]),
  );
  const visible = () =>
    renderer.root.findAllByType('probe-row').map((node: any) => node.props.children);
  expect(visible()).toEqual(['source only', 'pending source']);
  // The transcript mounts with the first canonical response, so capture its
  // callbacks after that mount to exercise late work from the source Room.
  const source = current;
  const sourceOutbox = current.session.outbox.current();
  controls.routeChannelId = 'room-b';
  controls.cached = null;
  await act(async () => renderer.update(React.createElement(BuzzChat)));
  // Even before the destination responds, it must not draw the source tail.
  expect(visible()).toEqual([]);
  await flushEffects();
  await act(async () => controls.responses.at(-1)!.apply(roomView('room-b')));
  expect(visible()).toEqual([]);
  expect(current.session.outbox.current()).not.toBe(sourceOutbox);
  await act(async () => {
    source.overlay.append([{ id: 'late-preview', text: 'late source' } as ChatDisplayMessage]);
    source.session.applyRoomMessageResult({ ...row, id: 'late-ack', text: 'late acknowledgement' });
  });
  expect(visible()).toEqual([]);
  expect(current.session.roomSurface?.room.id).toBe('room-b');
  expect(current.session.roomSurface?.messages).toEqual([]);
  await act(async () => renderer.unmount());
});

it('shows a list-delivered reply after background cache eviction without waiting for another Room read', async () => {
  const { publishPhoneLiveEvent } = await import('@/sync/transport/phone-live-events');
  const { applyChatListDelta } = await import('@/buzz/chat-list-delta');
  const { roomMessageRecord } = await import('@/buzz/room-message-records');
  const { identityScope } = await import('@/buzz/identity-records');
  const view = roomView('room-a');
  const agent = { pubkey: 'niglet', kind: 'agent' as const, name: 'Niglet' };
  const sent: RoomViewMessage = { id: 'human-tag', text: '@niglet help me pair an agent', createdAt: 10,
    author: view.viewer.identity, presentation: 'message' };
  const working = { agentPubkey: agent.pubkey, requestId: sent.id, status: 'working' as const, createdAt: 11 };
  controls.hotViewer = true;
  controls.cached = view;
  controls.roomResponse = view;
  let current!: UseRoomSurfaceSessionResult;
  controls.scopeProbe = session => { current = session; };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(BuzzChat)); });
  await flushEffects();
  const visible = () => renderer.root.findAllByType('probe-row').map((node: any) => node.props.children);
  // The real send path returns this canonical acknowledgement, then a claim.
  await act(async () => current.applyRoomMessageResult(sent));
  await act(async () => publishPhoneLiveEvent({ type: 'turn-delta', roomId: 'room-a', turn: working }));
  expect(visible()).toContain(sent.text);
  const readsBeforeReply = controls.roomReads;
  controls.appState = 'background';
  await act(async () => { controls.appStateListeners.forEach(listener => listener('background')); });
  controls.cached = null;
  controls.roomResponse = null;
  const message: RoomViewMessage = { id: 'agent-reply', text: '@viewer Pairing an agent needs a code from your Beeline app.',
    createdAt: 79, author: agent, requestId: sent.id, presentation: 'message' };
  const reply = { type: 'message-delta' as const, roomId: 'room-a', message };
  const finish = { type: 'turn-delta' as const, roomId: 'room-a', turn: { ...working, status: 'complete' as const }, agentState: null };
  let list = { workspace: {}, viewer: view.viewer.identity, chats: [{ room: view.room, agentState: 'working' }],
    watchFilters: [], truncated: false } as unknown as import('@beeline/buzz-client').ChatListView;
  await act(async () => {
    publishPhoneLiveEvent(reply);
    // The deck received this same server-projected message while hidden.
    list = applyChatListDelta({ ...list, chats: [{ ...list.chats[0]!, latestMessage: message }] }, reply);
    publishPhoneLiveEvent(finish);
    list = applyChatListDelta(list, finish);
  });
  expect(list.chats[0]?.latestMessage?.id).toBe(message.id);
  controls.appState = 'active';
  await act(async () => { controls.appStateListeners.forEach(listener => listener('active')); });
  expect(controls.roomReads).toBe(readsBeforeReply);
  try {
    expect(visible()).toContain(message.text);
    expect(roomMessageRecord(identityScope('https://relay.test', 'viewer'), 'room-a', message.id)).toEqual(message);
    expect(current.roomSurface?.latestAgentTurns).toEqual([finish.turn]);
    expect(current.roomSurface?.latestAgentTurns.some(turn => turn.status === 'working')).toBe(false);
    await act(async () => current.readRoom());
    await act(async () => controls.responses.at(-1)!.apply({ ...view, messages: [sent, message], latestAgentTurns: [finish.turn] }));
    expect(visible()).toContain(message.text);
    expect(current.roomSurface?.latestAgentTurns).toEqual([finish.turn]);
  } finally { await act(async () => renderer.unmount()); }
});

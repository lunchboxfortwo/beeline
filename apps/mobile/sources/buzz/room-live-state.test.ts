import { afterEach, expect, it, vi } from 'vitest';
import { SurfaceResponseCache, isRoomView, type RoomView, type RoomViewAgentTurn } from '@beeline/buzz-client';
import { publishPhoneLiveEvent } from '@/sync/transport/phone-live-events';
import { observeRoomLiveState } from './room-live-state';
import { SurfaceRegistry } from './surface-registry';
import { applyChatListDelta } from './chat-list-delta';
import type { ChatListView } from '@beeline/buzz-client';

const ROOM = '11111111-1111-4111-8111-111111111111';
const VIEWER = 'a'.repeat(64), RUBY = 'b'.repeat(64);
const viewer = { relayUrl: 'https://relay.test', viewerPubkey: VIEWER };
const address = { relayOrigin: viewer.relayUrl, viewerPubkey: VIEWER, endpoint: `/room/${ROOM}` };
const working: RoomViewAgentTurn = { agentPubkey: RUBY, requestId: 'request', status: 'working', createdAt: 10 };
const initial = (): RoomView => ({ room: { id: ROOM, name: 'Beeline' }, messages: [], members: [],
  latestAgentTurns: [working], pendingAgentCommands: [{ agentPubkey: RUBY, requestId: 'request', createdAt: 10 }],
  viewer: { identity: { pubkey: VIEWER, kind: 'human', name: 'Captain' }, role: 'owner',
    permissions: { send: true, manage: true } }, repositoryResolution: 'none', watchFilters: [{ '#h': [ROOM] }] });
const stops: Array<() => void> = [];
afterEach(() => { stops.splice(0).forEach(stop => stop()); });

it('keeps the reply and terminal turn from the list-only socket on offline Room reopen, including disk restoration', async () => {
  const disk = new Map<string, string>();
  const durable = new SurfaceResponseCache({ get: async key => disk.get(key) ?? null,
    set: async (key, value) => { disk.set(key, value); }, remove: async key => { disk.delete(key); } });
  const cache = new SurfaceRegistry(durable);
  await cache.write(address, initial(), isRoomView);
  stops.push(observeRoomLiveState(cache, () => viewer));
  let list = { workspace: {}, viewer: initial().viewer.identity, chats: [{ room: initial().room, agentState: 'working' }],
    watchFilters: [], truncated: false } as unknown as ChatListView;
  const message = { id: 'c'.repeat(64), text: 'Ordered Muse. Muse has accepted the order but has not started yet.',
    createdAt: 20, presentation: 'message' as const, author: { pubkey: RUBY, kind: 'agent' as const, name: 'Ruby' } };
  const reply = { type: 'message-delta' as const, roomId: ROOM, message };
  const finish = { type: 'turn-delta' as const, roomId: ROOM, turn: { ...working, status: 'complete' as const }, agentState: null };
  // No Room registration or mounted transcript: the deck alone holds the socket.
  publishPhoneLiveEvent(reply);
  list = applyChatListDelta(list, reply);
  publishPhoneLiveEvent(finish);
  list = applyChatListDelta(list, finish);
  expect(list.chats[0]?.latestMessage?.id).toBe(message.id);
  const opened = cache.peek(address, isRoomView)!;
  expect(opened.messages.at(-1)).toEqual(message);
  expect(opened.latestAgentTurns).toEqual([finish.turn]);
  expect(opened.pendingAgentCommands).toEqual([]);
  // Allow existing persistence work to settle, without a network read or clock.
  await Promise.resolve();
  const restarted = new SurfaceRegistry(durable);
  const restored = await restarted.read(address, isRoomView);
  expect(restored?.messages.at(-1)?.id).toBe(list.chats[0]?.latestMessage?.id);
  expect(restored?.latestAgentTurns[0]?.status).toBe('complete');
});

it('notifies mounted Room observers from the same committed reply while a covering read is unavailable', async () => {
  const cache = new SurfaceRegistry(new SurfaceResponseCache({ get: async () => null, set: async () => {}, remove: async () => {} }));
  cache.publish(address, initial(), isRoomView);
  stops.push(observeRoomLiveState(cache, () => viewer));
  const paint = vi.fn();
  stops.push(cache.subscribe(address, paint));
  publishPhoneLiveEvent({ type: 'message-delta', roomId: ROOM, message: { id: 'd'.repeat(64), text: 'Ordered Muse.', createdAt: 21,
    presentation: 'message', author: { pubkey: RUBY, kind: 'agent', name: 'Ruby' } } });
  expect(paint).toHaveBeenCalledOnce();
  expect(cache.peek(address, isRoomView)?.messages.at(-1)?.text).toBe('Ordered Muse.');
});

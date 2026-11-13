import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SurfaceResponseCache, isRoomView, type RoomView, type RoomViewAgentTurn } from '@beeline/buzz-client';
import { publishPhoneLiveEvent } from '@/sync/transport/phone-live-events';
import { observeRoomLiveState } from './room-live-state';
import { SurfaceRegistry } from './surface-registry';
import { applyChatListDelta } from './chat-list-delta';
import { roomSurfaceRecords } from './room-message-records';
import { resetClientState } from '@/sync/client-reset';
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
beforeEach(() => resetClientState());
afterEach(() => { stops.splice(0).forEach(stop => stop()); });

it('keeps the reply and terminal turn from the list-only socket on offline Room reopen, including disk restoration', async () => {
  const disk = new Map<string, string>();
  const durable = new SurfaceResponseCache({ get: async key => disk.get(key) ?? null,
    set: async (key, value) => { disk.set(key, value); }, remove: async key => { disk.delete(key); } });
  const cache = new SurfaceRegistry(durable, undefined, undefined, undefined, roomSurfaceRecords);
  await cache.write(address, initial(), isRoomView);
  stops.push(observeRoomLiveState(cache, () => viewer));
  let list = { workspace: {}, viewer: initial().viewer.identity, chats: [{ room: initial().room, agentState: 'working' }],
    watchFilters: [], truncated: false } as unknown as ChatListView;
  const listAddress = { ...address, endpoint: '/workspace/:id/chats' };
  const listGuard = (value: unknown): value is ChatListView => Boolean(value);
  cache.publish(listAddress, list, listGuard);
  const message = { id: 'c'.repeat(64), text: 'Ordered Muse. Muse has accepted the order but has not started yet.',
    createdAt: 20, presentation: 'message' as const, author: { pubkey: RUBY, kind: 'agent' as const, name: 'Ruby' } };
  const reply = { type: 'message-delta' as const, roomId: ROOM, message };
  const finish = { type: 'turn-delta' as const, roomId: ROOM, turn: { ...working, status: 'complete' as const }, agentState: null };
  // No Room registration or mounted transcript: the deck alone holds the socket.
  publishPhoneLiveEvent(reply);
  list = applyChatListDelta(cache.peek(listAddress, listGuard)!, reply);
  publishPhoneLiveEvent(finish);
  list = applyChatListDelta(list, finish);
  expect(list.chats[0]?.latestMessage?.id).toBe(message.id);
  const opened = cache.peek(address, isRoomView)!;
  expect(opened.messages.at(-1)).toEqual(message);
  expect(opened.latestAgentTurns).toEqual([finish.turn]);
  expect(opened.pendingAgentCommands).toEqual([]);
  // Allow existing persistence work to settle, without a network read or clock.
  await Promise.resolve();
  const restarted = new SurfaceRegistry(durable, undefined, undefined, undefined, roomSurfaceRecords);
  const restored = await restarted.read(address, isRoomView);
  expect(restored?.messages.at(-1)?.id).toBe(list.chats[0]?.latestMessage?.id);
  expect(restored?.latestAgentTurns[0]?.status).toBe('complete');
});

it('notifies mounted Room observers from the same committed reply while a covering read is unavailable', async () => {
  const cache = new SurfaceRegistry(new SurfaceResponseCache({ get: async () => null, set: async () => {}, remove: async () => {} }), undefined, undefined, undefined, roomSurfaceRecords);
  cache.publish(address, initial(), isRoomView);
  stops.push(observeRoomLiveState(cache, () => viewer));
  const paint = vi.fn();
  stops.push(cache.subscribe(address, paint));
  publishPhoneLiveEvent({ type: 'message-delta', roomId: ROOM, message: { id: 'd'.repeat(64), text: 'Ordered Muse.', createdAt: 21,
    presentation: 'message', author: { pubkey: RUBY, kind: 'agent', name: 'Ruby' } } });
  expect(paint).toHaveBeenCalledOnce();
  expect(cache.peek(address, isRoomView)?.messages.at(-1)?.text).toBe('Ordered Muse.');
});

it('takes a missed reply and completed turn from readChats into the same records before any Room read', async () => {
  const { isChatListView } = await import('@beeline/buzz-client');
  const { roomMessageRecord, selectRoomViewRecords } = await import('./room-message-records');
  const { identityScope } = await import('./identity-records');
  const { currentSurfaceStamp } = await import('./surface-clock');
  const disk = new Map<string, string>();
  const cache = new SurfaceRegistry(new SurfaceResponseCache({ get: async key => disk.get(key) ?? null,
    set: async (key, value) => { disk.set(key, value); }, remove: async key => { disk.delete(key); } }),
    undefined, undefined, undefined, roomSurfaceRecords);
  const before = initial();
  cache.publish(address, before, isRoomView);
  await cache.remove(address);
  const message = { id: 'e'.repeat(64), text: 'Pairing an agent needs a code.', createdAt: 20,
    author: { pubkey: RUBY, kind: 'agent' as const, name: 'Niglet' }, presentation: 'message' as const, requestId: working.requestId };
  const done = { ...working, status: 'complete' as const };
  const listAddress = { ...address, endpoint: '/workspace/:id/chats' };
  const list = { workspace: { id: ROOM, name: 'Review', role: 'owner', updatedAt: 1 }, viewer: before.viewer.identity,
    chats: [{ room: before.room, latestMessage: message, latestAgentTurns: [done] }], watchFilters: [], truncated: false } as ChatListView;
  cache.publish(listAddress, list, isChatListView, currentSurfaceStamp());
  const painted = selectRoomViewRecords(identityScope(viewer.relayUrl, VIEWER), before);
  const preview = cache.peek(listAddress, isChatListView)!.chats[0]!.latestMessage!;
  expect(painted.messages.at(-1)).toEqual(preview);
  expect(roomMessageRecord(identityScope(viewer.relayUrl, VIEWER), ROOM, message.id)).toEqual(preview);
  expect(painted.latestAgentTurns).toEqual([done]);
  expect(painted.pendingAgentCommands).toEqual([]);
  // Ordinary open read fills the gap, keeping the newest already on screen.
  const human = { ...message, id: 'f'.repeat(64), text: '@niglet help', createdAt: 10,
    author: before.viewer.identity, requestId: undefined };
  cache.publish(address, { ...before, messages: [human, message], latestAgentTurns: [done] }, isRoomView, currentSurfaceStamp());
  expect(cache.peek(address, isRoomView)!.messages).toEqual([human, message]);
});

it('keeps only the bounded tail and newest message without a mounted transcript', async () => {
  const { roomMessageRecord, selectRoomViewRecords } = await import('./room-message-records');
  const { identityScope } = await import('./identity-records');
  const cache = new SurfaceRegistry(new SurfaceResponseCache({ get: async () => null, set: async () => {}, remove: async () => {} }),
    undefined, undefined, undefined, roomSurfaceRecords);
  stops.push(observeRoomLiveState(cache, () => viewer));
  for (let index = 0; index < 150; index++) publishPhoneLiveEvent({ type: 'message-delta', roomId: ROOM,
    message: { id: String(index).padStart(64, '0'), text: `reply ${index}`, createdAt: index,
      author: { pubkey: RUBY, kind: 'agent', name: 'Niglet' }, presentation: 'message' } });
  const scope = identityScope(viewer.relayUrl, VIEWER);
  expect(roomMessageRecord(scope, ROOM, '0'.repeat(64))).toBeUndefined();
  const rows = selectRoomViewRecords(scope, initial()).messages;
  expect(rows).toHaveLength(30);
  expect(rows.at(-1)?.text).toBe('reply 149');
});

it('notifies a Room reader once when its callback touches the cache LRU', async () => {
  const cache = new SurfaceRegistry(new SurfaceResponseCache({ get: async () => null, set: async () => {}, remove: async () => {} }),
    undefined, undefined, undefined, roomSurfaceRecords);
  cache.publish(address, initial(), isRoomView);
  stops.push(observeRoomLiveState(cache, () => viewer));
  let stop = () => {};
  const paint = vi.fn(() => { cache.peek(address, isRoomView); if (paint.mock.calls.length > 2) stop(); });
  stop = cache.subscribe(address, paint);
  stops.push(stop);
  publishPhoneLiveEvent({ type: 'message-delta', roomId: ROOM, message: { id: 'f'.repeat(64), text: 'One paint.',
    createdAt: 40, presentation: 'message', author: { pubkey: RUBY, kind: 'agent', name: 'Niglet' } } });
  expect(paint).toHaveBeenCalledOnce();
});

it('keeps an actual sidebar preview in the same store and upgrades its missing details on the ordinary Room read', async () => {
  const { selectRoomViewRecords } = await import('./room-message-records');
  const { identityScope } = await import('./identity-records');
  const { currentSurfaceStamp } = await import('./surface-clock');
  const cache = new SurfaceRegistry(new SurfaceResponseCache({ get: async () => null, set: async () => {}, remove: async () => {} }),
    undefined, undefined, undefined, roomSurfaceRecords);
  stops.push(observeRoomLiveState(cache, () => viewer));
  const preview = { id: '9'.repeat(64), text: 'Pairing an agent needs a code…', createdAt: 50,
    presentation: 'message' as const, author: { pubkey: RUBY, kind: 'agent' as const, name: 'Niglet' } };
  const readStarted = currentSurfaceStamp();
  publishPhoneLiveEvent({ type: 'sidebar-preview', roomId: ROOM, preview });
  const scope = identityScope(viewer.relayUrl, VIEWER);
  expect(selectRoomViewRecords(scope, initial()).messages).toEqual([preview]);
  const complete = { ...preview, text: 'Pairing an agent needs a code from your Beeline app.', requestId: working.requestId };
  const done = { ...working, status: 'complete' as const };
  cache.publish(address, { ...initial(), messages: [complete], latestAgentTurns: [done] }, isRoomView, readStarted);
  expect(selectRoomViewRecords(scope, initial()).messages).toEqual([complete]);
  expect(selectRoomViewRecords(scope, initial()).latestAgentTurns).toEqual([done]);
});

it('retains settled corner tools in the canonical tool window as replies arrive', async () => {
  const cache = new SurfaceRegistry(new SurfaceResponseCache({ get: async () => null, set: async () => {}, remove: async () => {} }),
    undefined, undefined, undefined, roomSurfaceRecords);
  const corner = { ...initial(), parent: { id: '22222222-2222-4222-8222-222222222222', name: 'Parent' } };
  cache.publish(address, corner, isRoomView);
  stops.push(observeRoomLiveState(cache, () => viewer));
  const tool = { id: '8'.repeat(64), text: '', createdAt: 15, requestId: working.requestId,
    author: { pubkey: RUBY, kind: 'agent' as const, name: 'Niglet' }, presentation: 'activity' as const,
    activity: [{ kind: 'tool' as const, title: 'Read configuration' }] };
  publishPhoneLiveEvent({ type: 'message-delta', roomId: ROOM, message: tool });
  publishPhoneLiveEvent({ type: 'turn-delta', roomId: ROOM, turn: { ...working, status: 'complete' } });
  expect(cache.peek(address, isRoomView)!.toolRows).toEqual([tool]);
  expect(cache.peek(address, isRoomView)!.messages).toEqual([]);
});

it('repaints and orders the deck from shared records while retaining arrival unread semantics', async () => {
  const { isChatListView } = await import('@beeline/buzz-client');
  const cache = new SurfaceRegistry(new SurfaceResponseCache({ get: async () => null, set: async () => {}, remove: async () => {} }),
    undefined, undefined, undefined, roomSurfaceRecords);
  const human = { id: '1'.repeat(64), text: '@niglet help', createdAt: 10, presentation: 'message' as const,
    author: initial().viewer.identity };
  const other = { ...human, id: '2'.repeat(64), createdAt: 15, text: 'Other Room' };
  const listAddress = { ...address, endpoint: '/workspace/:id/chats' };
  const list = { workspace: { id: ROOM, name: 'Review', role: 'owner', updatedAt: 1 }, viewer: human.author,
    chats: [{ room: { id: '22222222-2222-4222-8222-222222222222', name: 'Other' }, latestMessage: other },
      { room: initial().room, latestMessage: human, unread: false }],
    watchFilters: [], truncated: false } as ChatListView;
  cache.publish(listAddress, list, isChatListView);
  const before = cache.peek(listAddress, isChatListView)!;
  stops.push(observeRoomLiveState(cache, () => viewer));
  const reply = { type: 'message-delta' as const, roomId: ROOM, message: { ...human, id: '3'.repeat(64), createdAt: 20,
    text: 'Reply while hidden', author: { pubkey: RUBY, kind: 'agent' as const, name: 'Niglet' } } };
  publishPhoneLiveEvent(reply);
  const after = cache.peek(listAddress, isChatListView)!;
  expect(after).not.toBe(before);
  expect(after.chats[1]!.latestMessage!).toEqual(reply.message);
  const delivered = applyChatListDelta(after, reply);
  expect(delivered.chats[0]!.room.id).toBe(ROOM);
  expect(delivered.chats[0]!.unread).toBe(true);
});

it('does not revive Working when an older concurrent list response finishes last', async () => {
  const { isChatListView } = await import('@beeline/buzz-client');
  const { selectRoomViewRecords } = await import('./room-message-records');
  const { identityScope } = await import('./identity-records');
  const cache = new SurfaceRegistry(new SurfaceResponseCache({ get: async () => null, set: async () => {}, remove: async () => {} }),
    undefined, undefined, undefined, roomSurfaceRecords);
  const message = { id: '7'.repeat(64), text: 'Reply already stored.', createdAt: 20, presentation: 'message' as const,
    author: { pubkey: RUBY, kind: 'agent' as const, name: 'Niglet' } };
  const list = { workspace: { id: ROOM, name: 'Review', role: 'owner', updatedAt: 1 }, viewer: initial().viewer.identity,
    chats: [{ room: initial().room, latestMessage: message, latestAgentTurns: [{ ...working, status: 'complete' }] }],
    watchFilters: [], truncated: false } as ChatListView;
  const listAddress = { ...address, endpoint: '/workspace/:id/chats' };
  cache.publish(listAddress, list, isChatListView, 2);
  cache.publish(listAddress, { ...list, chats: [{ ...list.chats[0]!, latestAgentTurns: [working] }] }, isChatListView, 1);
  const room = selectRoomViewRecords(identityScope(viewer.relayUrl, VIEWER), initial());
  expect(room.messages).toEqual([message]);
  expect(room.latestAgentTurns[0]!.status).toBe('complete');
});

it('paints every returned row when another live message arrives during the Room read', async () => {
  const { offerRoomView, selectRoomViewRecords, writeRoomMessage } = await import('./room-message-records');
  const { identityScope } = await import('./identity-records');
  const { nextSurfaceStamp } = await import('./surface-clock');
  const scope = identityScope(viewer.relayUrl, VIEWER);
  const human = { id: '4'.repeat(64), text: '@niglet help', createdAt: 10, author: initial().viewer.identity, presentation: 'message' as const };
  offerRoomView(scope, { ...initial(), messages: [human] }, nextSurfaceStamp());
  const readStarted = nextSurfaceStamp();
  const live = { ...human, id: '5'.repeat(64), text: 'A later live message', createdAt: 30 };
  writeRoomMessage(scope, ROOM, live);
  const reply = { ...human, id: '6'.repeat(64), text: 'Reply returned by the successful read', createdAt: 20 };
  offerRoomView(scope, { ...initial(), messages: [human, reply] }, readStarted);
  expect(selectRoomViewRecords(scope, initial()).messages).toEqual([human, reply, live]);
});

it('keeps the list preview visible when active tool rows fill the bounded Room window', async () => {
  const { isChatListView } = await import('@beeline/buzz-client');
  const cache = new SurfaceRegistry(new SurfaceResponseCache({ get: async () => null, set: async () => {}, remove: async () => {} }),
    undefined, undefined, undefined, roomSurfaceRecords);
  const human = { id: '0'.repeat(64), text: '@niglet help', createdAt: 1, author: initial().viewer.identity, presentation: 'message' as const };
  cache.publish(address, { ...initial(), messages: [human] }, isRoomView);
  const listAddress = { ...address, endpoint: '/workspace/:id/chats' };
  cache.publish(listAddress, { workspace: { id: ROOM, name: 'Review', role: 'owner', updatedAt: 1 }, viewer: human.author,
    chats: [{ room: initial().room, latestMessage: human }], watchFilters: [], truncated: false } as ChatListView, isChatListView);
  stops.push(observeRoomLiveState(cache, () => viewer));
  for (let index = 0; index < 35; index++) publishPhoneLiveEvent({ type: 'message-delta', roomId: ROOM,
    message: { id: String(index + 1).padStart(64, '0'), text: '', createdAt: 20 + index, presentation: 'activity',
      requestId: working.requestId, author: { pubkey: RUBY, kind: 'agent', name: 'Niglet' }, activity: [{ kind: 'tool', title: 'Read configuration' }] } });
  expect(cache.peek(address, isRoomView)!.messages).toHaveLength(30);
  expect(cache.peek(address, isRoomView)!.messages).toContainEqual(cache.peek(listAddress, isChatListView)!.chats[0]!.latestMessage);
  publishPhoneLiveEvent({ type: 'turn-delta', roomId: ROOM, turn: { ...working, status: 'complete' } });
  expect(cache.peek(address, isRoomView)!.messages).toEqual([human]);
});

it.each(['complete', 'cancelled'] as const)('publishes %s to an open Room and deck when stored values have Metro spread semantics', async status => {
  const { isChatListView } = await import('@beeline/buzz-client');
  const cache = new SurfaceRegistry(new SurfaceResponseCache({ get: async () => null, set: async () => {}, remove: async () => {} }),
    undefined, undefined, undefined, { ...roomSurfaceRecords,
      store(address, value, stamp) {
        const stored = roomSurfaceRecords.store(address, value, stamp);
        // Metro's Object.assign lowering materializes object-literal getters.
        return address.endpoint === '/workspace/:id/chats'
          ? { ...(stored as ChatListView), chats: (stored as ChatListView).chats.map(item => Object.assign({}, item)) }
          : Object.assign({}, stored);
      },
    });
  const listAddress = { ...address, endpoint: '/workspace/:id/chats', params: { workspaceId: ROOM } };
  const list = { workspace: { id: ROOM, name: 'Review', role: 'owner', updatedAt: 1 }, viewer: initial().viewer.identity,
    chats: [{ room: initial().room, latestAgentTurns: [working] }], watchFilters: [], truncated: false } as ChatListView;
  cache.publish(address, initial(), isRoomView);
  cache.publish(listAddress, list, isChatListView);
  stops.push(observeRoomLiveState(cache, () => viewer));
  const terminal = { type: 'turn-delta' as const, roomId: ROOM, turn: { ...working, status }, agentState: null };
  const paint = vi.fn(() => cache.peek(address, isRoomView)?.latestAgentTurns[0]?.status);
  stops.push(cache.subscribe(address, paint));
  publishPhoneLiveEvent(terminal);
  expect(paint).toHaveReturnedWith(status);
  expect(cache.peek(listAddress, isChatListView)?.chats[0]?.latestAgentTurns).toEqual([terminal.turn]);
  cache.publish(listAddress, applyChatListDelta(cache.peek(listAddress, isChatListView)!, terminal), isChatListView);
  expect(cache.peek(address, isRoomView)?.latestAgentTurns).toEqual([terminal.turn]);
});

import { afterEach, expect, it } from 'vitest';
import type { ChatListView, RoomView, RoomViewMessage, SurfaceCacheAddress } from '@beeline/buzz-client';
import { resetClientState } from '@/sync/client-reset';
import { identityScope } from './identity-records';
import { offerRoomView, roomMessageRecord, roomSurfaceRecords, writeRoomMessage } from './room-message-records';

// Reproduction R1 on web: the Room read gives the reply its preview, then the
// chat list's latest-message copy of the same reply arrives without one.

const ROOM = '11111111-1111-4111-8111-111111111111';
const ORIGINAL = '1'.repeat(64), REPLY = '2'.repeat(64);
const VIEWER = 'a'.repeat(64), RELAY = 'https://relay.test';
const scope = identityScope(RELAY, VIEWER);
const author = { pubkey: 'b'.repeat(64), kind: 'human' as const, name: 'Sample Person' };
const reply: RoomViewMessage = {
  id: REPLY, text: 'Ship it', createdAt: 10, presentation: 'message', author,
  reply: { channelId: ROOM, eventId: ORIGINAL, rootId: ORIGINAL },
};
const replyPreview = { author: { pubkey: 'c'.repeat(64), kind: 'agent' as const, name: 'Sample Agent' }, text: 'Deploy plan ready' };
const roomView = (message: RoomViewMessage): RoomView => ({
  room: { id: ROOM, workspaceId: '22222222-2222-4222-8222-222222222222', name: 'Samples', visibility: 'public', archived: false, createdAt: 1, updatedAt: 1 },
  viewer: author, messages: [message], members: [], latestAgentTurns: [], pendingAgentCommands: [],
} as unknown as RoomView);
const listAddress: SurfaceCacheAddress = { relayOrigin: RELAY, viewerPubkey: VIEWER, endpoint: '/workspace/:id/chats' };
const listView = (message: RoomViewMessage): ChatListView => ({
  workspace: { id: '22222222-2222-4222-8222-222222222222', name: 'Samples', role: 'owner', updatedAt: 1 },
  viewer: author, chats: [{ room: roomView(message).room, latestMessage: message }], watchFilters: [], truncated: false,
} as unknown as ChatListView);

afterEach(() => resetClientState());

it('the chat list copy of a reply keeps the preview the Room read gave it', () => {
  offerRoomView(scope, roomView({ ...reply, replyPreview }), 1);
  roomSurfaceRecords.store(listAddress, listView({ ...reply }), 2);
  expect(roomMessageRecord(scope, ROOM, REPLY)?.replyPreview).toEqual(replyPreview);
});

it('a fresh Room read without a preview clears it, so a deleted original stops showing', () => {
  offerRoomView(scope, roomView({ ...reply, replyPreview }), 1);
  offerRoomView(scope, roomView({ ...reply }), 2);
  expect(roomMessageRecord(scope, ROOM, REPLY)?.replyPreview).toBeUndefined();
});

it('a live update without a preview clears it', () => {
  writeRoomMessage(scope, ROOM, { ...reply, replyPreview });
  writeRoomMessage(scope, ROOM, { ...reply });
  expect(roomMessageRecord(scope, ROOM, REPLY)?.replyPreview).toBeUndefined();
});

it('a chat list copy that names a different original does not borrow the old preview', () => {
  offerRoomView(scope, roomView({ ...reply, replyPreview }), 1);
  roomSurfaceRecords.store(listAddress, listView({ ...reply, reply: { channelId: ROOM, eventId: '3'.repeat(64), rootId: '3'.repeat(64) } }), 2);
  expect(roomMessageRecord(scope, ROOM, REPLY)?.replyPreview).toBeUndefined();
});

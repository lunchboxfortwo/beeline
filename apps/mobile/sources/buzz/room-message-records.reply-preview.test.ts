import { afterEach, expect, it } from 'vitest';
import type { RoomViewMessage } from '@beeline/buzz-client';
import { resetClientState } from '@/sync/client-reset';
import { identityScope } from './identity-records';
import { roomMessageRecord, writeRoomMessage } from './room-message-records';

// Reproduction R1 on web: the Room read gives the reply its preview, then the
// chat list's latest-message copy of the same reply arrives without one.

const ROOM = '11111111-1111-4111-8111-111111111111';
const ORIGINAL = '1'.repeat(64), REPLY = '2'.repeat(64);
const scope = identityScope('https://relay.test', 'a'.repeat(64));
const reply: RoomViewMessage = {
  id: REPLY, text: 'Ship it', createdAt: 10, presentation: 'message',
  author: { pubkey: 'b'.repeat(64), kind: 'human', name: 'Sample Person' },
  reply: { channelId: ROOM, eventId: ORIGINAL, rootId: ORIGINAL },
};
const replyPreview = { author: { pubkey: 'c'.repeat(64), kind: 'agent' as const, name: 'Sample Agent' }, text: 'Deploy plan ready' };

afterEach(() => resetClientState());

it('a reply row without a preview keeps the preview already held for the same original', () => {
  writeRoomMessage(scope, ROOM, { ...reply, replyPreview });
  writeRoomMessage(scope, ROOM, { ...reply });
  expect(roomMessageRecord(scope, ROOM, REPLY)?.replyPreview).toEqual(replyPreview);
});

it('a reply row that names a different original does not borrow the old preview', () => {
  writeRoomMessage(scope, ROOM, { ...reply, replyPreview });
  writeRoomMessage(scope, ROOM, { ...reply, reply: { channelId: ROOM, eventId: '3'.repeat(64), rootId: '3'.repeat(64) } });
  expect(roomMessageRecord(scope, ROOM, REPLY)?.replyPreview).toBeUndefined();
});

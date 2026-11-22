import { describe, expect, it } from 'vitest';
import { monolithFixture, ROOM } from '../test-fixtures/test-support-monolith.js';

const UNKNOWN_PLACE = 'unknown place; use an id from read(facet:addresses)';

describe('monolith integration: place addresses', () => {
  const fixture = monolithFixture();

  it('reads #<id> the same as <id> and refuses channel names without a database error', async () => {
    const plain = await fixture.daemonOperation('getRoomConversation', { roomId: ROOM, limit: 8, window: 'recent' });
    expect(plain.status).toBe(200);
    const prefixed = await fixture.daemonOperation('getRoomConversation', { roomId: `#${ROOM}`, limit: 8, window: 'recent' });
    expect(prefixed.status).toBe(200);
    expect(await prefixed.json()).toEqual(await plain.json());

    for (const [operation, input] of [
      ['getRoomConversation', { limit: 8, window: 'recent' }],
      ['getRoomMessage', { messageId: 'm1' }],
      ['listRoomMembers', {}],
      ['listReachableCorners', {}],
      ['listRooms', {}],
    ] as const)
      for (const name of ['#dev-chat', '#beeline/room-address-check', `#${ROOM}x`]) {
        const response = await fixture.daemonOperation(operation, { ...input, roomId: name });
        const body = await response.text();
        expect(response.status, `${operation} ${name}`).toBe(400);
        expect(body).toContain(UNKNOWN_PLACE);
        expect(body).not.toContain('invalid input syntax');
      }
  });
});

import { describe, expect, it } from 'vitest';
import { DAEMON_OPERATION_NAMES } from '../daemon-service.js';
import { normalizePlaceAddresses, UNKNOWN_PLACE } from './place-address.js';

const ID = 'b2a0bc47-d0ed-4b4f-b6a4-da1d49fcad1f';
const NAMES = ['#dev-chat', '#beeline/room-address-check', 'dev-chat', `#${ID}x`, ''];

describe('daemon place addresses', () => {
  it('reads a #-prefixed id as the id in every place field', () => {
    for (const operation of DAEMON_OPERATION_NAMES) {
      const input = { roomId: `#${ID.toUpperCase()}`, cornerId: `#${ID}`, parentRoomId: ID, targetRoomId: `#${ID}`,
        address: `#${ID}`, to: { place: `#${ID}`, agent: 'ruby' }, text: '#dev-chat' };
      const out = normalizePlaceAddresses(operation, input) as typeof input;
      expect(out).toMatchObject({ roomId: ID, cornerId: ID, parentRoomId: ID, targetRoomId: ID, text: '#dev-chat' });
      if (operation === 'order') expect(out.address).toBe(ID);
      if (operation === 'message') expect(out.to).toEqual({ place: ID, agent: 'ruby' });
    }
  });

  it('refuses a channel name in every address-taking operation with the plain error', () => {
    for (const operation of DAEMON_OPERATION_NAMES)
      for (const name of NAMES) {
        for (const field of ['roomId', 'cornerId', 'sourceRoomId', 'parentRoomId', 'returnRoomId', 'openedFromCornerId'])
          expect(() => normalizePlaceAddresses(operation, { [field]: name }), `${operation}.${field}=${name}`).toThrow(UNKNOWN_PLACE);
        if (operation === 'order') expect(() => normalizePlaceAddresses(operation, { address: name })).toThrow(UNKNOWN_PLACE);
        if (operation === 'message') expect(() => normalizePlaceAddresses(operation, { to: { place: name } })).toThrow(UNKNOWN_PLACE);
      }
  });

  it('leaves non-place fields alone', () => {
    const input = { address: '0xabc', recipient: '#dev-chat', messageId: 'm1' };
    expect(normalizePlaceAddresses('walletPay', input)).toEqual(input);
  });
});

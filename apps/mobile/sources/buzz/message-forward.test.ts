import { describe, expect, it, vi } from 'vitest';
import { resolveForwardTargetRoom } from './message-forward';

describe('forward destination resolution', () => {
  it('returns an existing Room synchronously so sending need not yield to a busy-picker render', () => {
    const resolve = vi.fn();
    const room = resolveForwardTargetRoom(
      { kind: 'room', id: 'destination', label: '#destination', group: 'rooms' },
      'workspace', resolve,
    );
    expect(room).toBe('destination');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('waits for a member destination to be accepted before returning its Room', async () => {
    const resolve = vi.fn(async () => ({ channelId: 'direct-room' }));
    const room = resolveForwardTargetRoom(
      { kind: 'member', id: 'peer', memberId: 'peer', label: '@peer', group: 'people' },
      'workspace', resolve,
    );
    expect(room).toBeInstanceOf(Promise);
    await expect(room).resolves.toBe('direct-room');
    expect(resolve).toHaveBeenCalledWith('workspace', 'peer');
  });
});

import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
const action = vi.hoisted(() => ({
  resolve: vi.fn(async () => ({ channelId: 'dm' })), prefetch: vi.fn(), known: vi.fn(), navigate: vi.fn(),
}));
vi.mock('expo-router', () => ({ router: {} }));
vi.mock('@/buzz/corner-navigation', () => ({ navigateToRoom: action.navigate }));
vi.mock('@/push/push-room-prefetch', () => ({ prefetchRoomOpen: action.prefetch, prefetchDirectMessageOpen: action.known }));
vi.mock('@/sync/transport', () => ({ BuzzRigTransport: class { resolveDirectMessage = action.resolve; } }));
vi.mock('@/buzz/workspace-records', () => ({ workspacePage: () => null }));
import { useMembersMembership } from './useMembersMembership';

it('reads the resolved agent DM before mounting the chat route', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const noop = () => {};
  let message!: (id: string) => Promise<void>;
  function Profile() {
    [message] = useMembersMembership([
      null, 'work', 'https://local.test', noop, noop, noop, noop, noop, noop,
      false, { current: false }, undefined, { publicKey: 'viewer' }, '', noop,
      noop, noop, noop, false, null,
    ] as unknown as Parameters<typeof useMembersMembership>[0]);
    return null;
  }
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<Profile />); });
  try {
    await act(async () => { await message('agent'); });
    expect(action.resolve).toHaveBeenCalledWith('work', 'agent');
    expect(action.known).toHaveBeenCalledWith('work', 'agent');
    expect(action.known.mock.invocationCallOrder[0]).toBeLessThan(action.resolve.mock.invocationCallOrder[0]);
    expect(action.prefetch).toHaveBeenCalledWith('dm');
    expect(action.prefetch.mock.invocationCallOrder[0]).toBeLessThan(action.navigate.mock.invocationCallOrder[0]);
  } finally { act(() => tree.unmount()); }
});

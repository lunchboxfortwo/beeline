import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  corners: null as any,
  push: vi.fn(),
  create: vi.fn(),
}));
vi.mock('expo-router', () => ({
  router: { push: fixture.push, replace: vi.fn(), back: vi.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({ roomId: 'room-1' }),
}));
vi.mock('tamagui', () => ({ YStack: 'YStack' }));
vi.mock('@/components/buzz/SurfaceGlyphLoader', () => ({ SurfaceGlyphLoader: 'SurfaceGlyphLoader' }));
vi.mock('lucide-react-native', () => ({ CornerDownRight: 'CornerDownRight', Plus: 'Plus' }));
vi.mock('@/ui/grammar', () => ({
  Screen: 'Screen', Btn: 'Btn', Copy: 'Copy', Glyph: 'Glyph',
}));
vi.mock('@/ui/screens/thread/ThreadLine', () => ({ ThreadLine: 'ThreadLine' }));
vi.mock('@/buzz/latency-route-hook', () => ({ useLatencyRouteFrame: () => undefined }));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: async () => ({ publicKey: 'me' }),
  peekBuzzViewerContext: () => ({ relayUrl: 'wss://relay.test', viewerPubkey: 'me' }),
}));
vi.mock('@/components/buzz/CornerOpenToast', () => ({ CornerOpenRow: () => null }));
vi.mock('@/sync/transport', () => ({ BuzzRigTransport: class {} }));
vi.mock('@/buzz/room-list-new-corner', () => ({ openRoomListCorner: fixture.create }));
vi.mock('@/sync/transport/monolith-operation', () => ({ phoneOperationFailureReason: () => 'failed' }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/buzz/use-room-corners', () => ({ useRoomCorners: () => fixture.corners }));
import BuzzCorners from './[roomId]';

const row = (id: string, name: string, state: string) => ({ corner: { id, name }, state, lifecycle: { lifecycle: 'unknown', checks: 'unknown' } });

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  fixture.push.mockReset();
  fixture.create.mockReset();
});

it('lists the chat’s active threads as thread lines and opens one', async () => {
  const loadMoreOpen = vi.fn();
  fixture.corners = {
    view: { room: { name: 'beeline' } },
    record: { nextOpen: 'cursor', summary: { cornerCount: 5 } },
    openRows: [row('c1', 'beeline/one-row-header', 'waiting'), row('c2', 'reconnect', 'review')],
    error: null,
    loadMoreOpen,
  };
  let tree: any;
  await act(async () => { tree = create(<BuzzCorners />); });
  expect(tree.root.findByType('Screen' as any).props.title).toBe('#beeline · Threads');
  const lines = tree.root.findAllByType('ThreadLine' as any);
  expect(lines.map((line: any) => [line.props.title, line.props.state])).toEqual([
    ['one-row-header', 'waiting'], ['reconnect', 'review'],
  ]);
  act(() => lines[1].props.onPress());
  expect(fixture.push).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ channelId: 'c2' }) }));
  const more = tree.root.find((node: any) => node.props.testID === 'room-corners-more');
  expect(more.findByType('Copy' as any).props.children).toBe('3 more');
  act(() => more.props.onPress());
  expect(loadMoreOpen).toHaveBeenCalledTimes(1);
  act(() => tree.unmount());
});

it('shows the read error instead of a list, and no new-thread control before the chat loads', async () => {
  fixture.corners = { view: undefined, record: undefined, openRows: [], error: 'Could not load', loadMoreOpen: vi.fn() };
  let tree: any;
  await act(async () => { tree = create(<BuzzCorners />); });
  expect(tree.root.find((node: any) => node.props.testID === 'room-corners-error').props.children).toBe('Could not load');
  expect(tree.root.findByType('Screen' as any).props.right).toBeUndefined();
  act(() => tree.unmount());
});

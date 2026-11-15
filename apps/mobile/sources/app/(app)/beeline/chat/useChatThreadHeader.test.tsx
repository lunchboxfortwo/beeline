vi.mock('@/buzz/work-board-store',()=>({useRecordedWorkItem:()=>null}));
import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
const opening = vi.hoisted(() => ({
  record: { header: { room: { name: 'beeline' } }, rows: [], openMore: [],
    summary: { openCorners: [{ id: 'thread', name: 'beeline/first-frame', state: 'waiting' }] } },
}));
vi.mock('expo-router', () => ({ router: {} }));
vi.mock('@/buzz/corner-navigation', () => ({ navigateToRoom: vi.fn() }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: {} }));
vi.mock('@/ui/shell/panel', () => ({ openPlace: vi.fn() }));
vi.mock('@/buzz/room-corner-store', () => ({
  useRoomCornerRecord: () => opening.record,
  findRoomCornerRow: () => undefined,
}));
vi.mock('@/ui/screens/thread/ThreadHeader', () => ({ ThreadTitleBlock: 'ThreadTitleBlock' }));
vi.mock('@/ui/screens/thread/useTitleBlockVisibility', () => ({ useTitleBlockVisibility: () => ({ collapsed: false }) }));
import { useChatThreadHeader } from './useChatThreadHeader';

it('OPEN-SHELL-1: shows the list title and state before the thread read, then replaces them with the response', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  function Header({ loaded }: { loaded: boolean }) {
    const { titleBlock } = useChatThreadHeader({ isCorner: true, roomSurface: null,
      resolvedChannelName: loaded ? 'beeline/server-title' : null,
      decodedId: 'thread', parentChannelId: 'room', state: loaded ? 'review' : undefined,
      objective: '', isArchived: false, isDesktop: false });
    return titleBlock;
  }
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(<Header loaded={false} />); });
  expect(tree.root.findByType('ThreadTitleBlock').props.h).toMatchObject({
    title: 'first-frame', chatTag: '#beeline', state: 'waiting',
  });
  act(() => tree.update(<Header loaded />));
  expect(tree.root.findByType('ThreadTitleBlock').props.h).toMatchObject({ title: 'server-title', state: 'review' });
  act(() => tree.unmount());
});

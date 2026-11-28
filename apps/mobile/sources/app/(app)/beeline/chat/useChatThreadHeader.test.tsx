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

it('thread-working-idle: suppresses stale workingAgentName once roomSurface proves no turn is active', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  opening.record = {
    header: { room: { name: 'grunt' } },
    rows: [],
    openMore: [],
    summary: { openCorners: [{ id: 'thread', name: 'grunt/fix', state: 'working', workingAgentName: 'Grunt' }] },
  } as any;
  const surface = (latestAgentTurns: Array<{ agentPubkey: string; requestId: string; status: string; createdAt: number }>) => ({
    room: { id: 'thread', workspaceId: 'ws', name: 'grunt/fix' },
    parent: { id: 'room', name: 'grunt' },
    members: [],
    latestAgentTurns,
  }) as any;
  function Header({ roomSurface }: { roomSurface: any }) {
    const { titleBlock } = useChatThreadHeader({
      isCorner: true, roomSurface, resolvedChannelName: 'grunt/fix',
      decodedId: 'thread', parentChannelId: 'room', state: 'working',
      objective: '', isArchived: false, isDesktop: false,
    });
    return titleBlock;
  }
  let tree!: ReturnType<typeof create>;
  // Before roomSurface loads, trust the server summary so genuinely active threads do not flicker.
  act(() => { tree = create(<Header roomSurface={null} />); });
  expect(tree.root.findByType('ThreadTitleBlock').props.h.workingAgentName).toBe('Grunt');
  // Once roomSurface loads with no active turn, suppress the stale workingAgentName.
  act(() => tree.update(<Header roomSurface={surface([{ agentPubkey: 'grunt', requestId: 'r1', status: 'complete', createdAt: 100 }])} />));
  expect(tree.root.findByType('ThreadTitleBlock').props.h.state).toBe('working');
  expect(tree.root.findByType('ThreadTitleBlock').props.h.workingAgentName).toBeUndefined();
  // When a live turn runs, show workingAgentName again.
  act(() => tree.update(<Header roomSurface={surface([{ agentPubkey: 'grunt', requestId: 'r2', status: 'working', createdAt: 200 }])} />));
  expect(tree.root.findByType('ThreadTitleBlock').props.h.workingAgentName).toBe('Grunt');
  act(() => tree.unmount());
});

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
import { threadActivityLabel } from '@beeline/api-contract/phone';
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
    members: [
      { identity: { pubkey: 'grunt', kind: 'agent', name: 'Grunt' } },
      { identity: { pubkey: 'ruby', kind: 'agent', name: 'Ruby' } },
    ],
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
  const labelOf = (h: any) => threadActivityLabel({ state: h.activityState ?? h.state, workingAgentName: h.workingAgentName });
  // Once roomSurface loads with no active turn, suppress the stale workingAgentName.
  act(() => tree.update(<Header roomSurface={surface([{ agentPubkey: 'grunt', requestId: 'r1', status: 'complete', createdAt: 100 }])} />));
  expect(tree.root.findByType('ThreadTitleBlock').props.h.state).toBe('working');
  expect(tree.root.findByType('ThreadTitleBlock').props.h.workingAgentName).toBeUndefined();
  expect(labelOf(tree.root.findByType('ThreadTitleBlock').props.h)).toBeUndefined();
  // When a live turn runs for a different agent, resolve from the active turn instead of the stale cached name.
  act(() => tree.update(<Header roomSurface={surface([{ agentPubkey: 'ruby', requestId: 'r2', status: 'working', createdAt: 200 }])} />));
  expect(labelOf(tree.root.findByType('ThreadTitleBlock').props.h)).toBe('Ruby is working');
  act(() => tree.unmount());
});

it('thread-working-idle: resolves working and reviewing labels from the live turn without replacing the server lifecycle state', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  opening.record = {
    header: { room: { name: 'beeline' } },
    rows: [],
    openMore: [],
    summary: { openCorners: [{ id: 'thread', name: 'beeline/live-label', state: 'idle' }] },
  } as any;
  const surface = (
    latestAgentTurns: Array<{ agentPubkey: string; requestId: string; status: string; createdAt: number; role?: 'review' }>,
    reviewerAgentId?: string,
  ) => ({
    room: { id: 'thread', workspaceId: 'ws', name: 'beeline/live-label' },
    parent: { id: 'room', name: 'beeline', ...(reviewerAgentId ? { reviewerAgentId } : {}) },
    cornerOpenerAgentId: 'crayon',
    members: [
      { identity: { pubkey: 'crayon', kind: 'agent', name: 'Crayon' } },
      { identity: { pubkey: 'speedy', kind: 'agent', name: 'Speedy' } },
      { identity: { pubkey: 'other', kind: 'agent', name: 'Other' } },
    ],
    latestAgentTurns,
  }) as any;
  function Header({ roomSurface, state = 'idle' }: { roomSurface: any; state?: 'idle' | 'review' }) {
    const { titleBlock } = useChatThreadHeader({
      isCorner: true, roomSurface, resolvedChannelName: 'beeline/live-label',
      decodedId: 'thread', parentChannelId: 'room', state,
      objective: '', isArchived: false, isDesktop: false,
    });
    return titleBlock;
  }
  const labelOf = (h: any) => threadActivityLabel({ state: h.activityState ?? h.state, workingAgentName: h.workingAgentName });
  let tree!: ReturnType<typeof create>;
  // Opens idle with an unnamed cached list row: no working label.
  act(() => { tree = create(<Header roomSurface={surface([], 'speedy')} />); });
  expect(tree.root.findByType('ThreadTitleBlock').props.h.state).toBe('idle');
  expect(labelOf(tree.root.findByType('ThreadTitleBlock').props.h)).toBeUndefined();

  // Implementer turn starts without refreshing the cached list row: mark stays server idle, label shows "<agent> is working".
  act(() => tree.update(<Header roomSurface={surface([{ agentPubkey: 'crayon', requestId: 'r1', status: 'working', createdAt: 100 }], 'speedy')} />));
  expect(tree.root.findByType('ThreadTitleBlock').props.h).toMatchObject({ state: 'idle', activityState: 'working', workingAgentName: 'Crayon' });
  expect(labelOf(tree.root.findByType('ThreadTitleBlock').props.h)).toBe('Crayon is working');

  // Dispatched reviewer turn keeps showing "Speedy is reviewing" even after the configured reviewer setting is cleared or changed.
  act(() => tree.update(<Header state="review" roomSurface={surface([{ agentPubkey: 'speedy', requestId: 'r2', status: 'working', createdAt: 200, role: 'review' }], undefined)} />));
  expect(tree.root.findByType('ThreadTitleBlock').props.h).toMatchObject({ state: 'review', activityState: 'review', workingAgentName: 'Speedy' });
  expect(labelOf(tree.root.findByType('ThreadTitleBlock').props.h)).toBe('Speedy is reviewing');

  act(() => tree.update(<Header state="review" roomSurface={surface([{ agentPubkey: 'speedy', requestId: 'r2', status: 'working', createdAt: 200, role: 'review' }], 'other')} />));
  expect(tree.root.findByType('ThreadTitleBlock').props.h).toMatchObject({ state: 'review', activityState: 'review', workingAgentName: 'Speedy' });
  expect(labelOf(tree.root.findByType('ThreadTitleBlock').props.h)).toBe('Speedy is reviewing');

  // Turn ends without refreshing the cached list row: header clears the activity label while keeping server state.
  act(() => tree.update(<Header state="idle" roomSurface={surface([{ agentPubkey: 'speedy', requestId: 'r2', status: 'complete', createdAt: 300 }], 'other')} />));
  expect(tree.root.findByType('ThreadTitleBlock').props.h.state).toBe('idle');
  expect(tree.root.findByType('ThreadTitleBlock').props.h.workingAgentName).toBeUndefined();
  expect(labelOf(tree.root.findByType('ThreadTitleBlock').props.h)).toBeUndefined();
  act(() => tree.unmount());
});

import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ summary: undefined as any, corners: undefined as any }));
vi.mock('react-native', () => ({ useWindowDimensions: () => ({ width: 390, height: 844 }) }));
vi.mock('tamagui', async () => {
  const R = await import('react');
  const Open = R.createContext<any>(null);
  const Collapsible = Object.assign(
    (props: any) => R.createElement(Open.Provider, { value: props }, props.children),
    {
      // Tamagui's trigger toggles the root's open state through onOpenChange.
      Trigger: (props: any) => {
        const root = R.useContext(Open);
        return R.cloneElement(props.children, { onPress: () => root.onOpenChange(!root.open) });
      },
      Content: (props: any) => props.children,
    },
  );
  return { Collapsible, ScrollView: 'ScrollView', Separator: 'Separator', YStack: 'YStack' };
});
vi.mock('lucide-react-native', () => ({ ChevronDown: 'ChevronDown', ChevronUp: 'ChevronUp', CornerDownRight: 'CornerDownRight' }));
vi.mock('@/ui/grammar', () => ({ Btn: 'Btn', Copy: 'Copy', Glyph: 'Glyph' }));
vi.mock('@/ui/screens/thread/ThreadLine', () => ({ ThreadLine: 'ThreadLine' }));
vi.mock('@/buzz/room-corner-store', () => ({ useRoomCornerSummary: () => fixture.summary }));
vi.mock('@/buzz/use-room-corners', () => ({ useRoomCorners: () => fixture.corners }));
import { ThreadsDropdown } from './ThreadsDropdown';

const byTestID = (tree: any, testID: string) => tree.root.findAll((node: any) => node.props.testID === testID && typeof node.type === 'string');

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

it('is only the header hairline with no active threads', () => {
  fixture.summary = { cornerCount: 0, openCorners: [] };
  let tree: any;
  act(() => { tree = create(<ThreadsDropdown roomId="r" chatName="beeline" openThread={vi.fn()} />); });
  expect(tree.toJSON().type).toBe('Separator');
  act(() => tree.unmount());
});

it('names the active count, then lists every thread inside a list capped at 45% of the window', () => {
  const openThread = vi.fn(), loadMoreOpen = vi.fn();
  fixture.summary = { cornerCount: 3, openCorners: [{ id: 'a', name: 'one-row-header', state: 'waiting' }] };
  fixture.corners = {
    openRows: [
      { corner: { id: 'a', name: 'beeline/one-row-header' }, state: 'waiting' },
      { corner: { id: 'b', name: 'reconnect' }, state: 'review' },
    ],
    record: { nextOpen: 'cursor' },
    loadMoreOpen,
  };
  let tree: any;
  act(() => { tree = create(<ThreadsDropdown roomId="r" chatName="beeline" openThread={openThread} />); });
  const trigger = byTestID(tree, 'threads-dropdown-trigger')[0];
  expect(trigger.findByType('Copy').props.children).toBe('Threads · 3 active');
  expect(trigger.props.label).toBe('3 active threads in beeline');
  expect(byTestID(tree, 'threads-dropdown-list')).toHaveLength(0);
  act(() => trigger.props.onPress());
  const list = tree.root.findAllByType('ScrollView');
  expect(list).toHaveLength(1);
  expect(list[0].props.maxHeight).toBe(Math.round(844 * 0.45));
  const lines = tree.root.findAllByType('ThreadLine');
  expect(lines.map((line: any) => [line.props.title, line.props.state])).toEqual([['one-row-header', 'waiting'], ['reconnect', 'review']]);
  act(() => lines[1].props.onPress());
  expect(openThread).toHaveBeenCalledWith('b');
  act(() => byTestID(tree, 'threads-dropdown-more')[0].props.onPress());
  expect(loadMoreOpen).toHaveBeenCalledTimes(1);
  act(() => tree.unmount());
});

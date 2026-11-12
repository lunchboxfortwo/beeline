import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

vi.mock('@/components/buzz/RepositoryMark', () => ({ RepositoryMark: (props: any) => React.createElement('RepositoryMark', props) }));
vi.mock('tamagui', async () => (await import('./tamagui-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('./tamagui-hosts.test-support')).lucideHosts());
vi.mock('react-native-svg', async () => (await import('./tamagui-hosts.test-support')).svgHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('@/buzz/message-outbox-observer', () => ({ useRoomOutboxFailure: () => null }));
vi.mock('@/buzz/room-corner-store', () => ({ useRoomCornerSummary: () => null }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: () => null }));

import type { ChatListItem } from '@beeline/buzz-client';
import { ChatRow, NEW_THREAD_HOLD_MS } from './ChatTree';
import { CornerDownRight } from 'lucide-react-native';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOM = 'room-1';
const item = {
  room: { id: ROOM, name: 'general', updatedAt: 1_700_000_000 },
  openCorners: [],
  unread: false,
} as unknown as ChatListItem;

const byTestID = (tree: ReactTestRenderer, id: string) =>
  tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === id);

function row(onNewThread?: (roomId: string) => void) {
  const handlers = { onOpen: vi.fn(), onPin: vi.fn(), onOpenThread: vi.fn() };
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<ChatRow item={item} now={1_700_000_000_000} first {...handlers} onNewThread={onNewThread} />);
  });
  return { tree, ...handlers };
}

/** A touch event at `ms` on the native touch clock. */
const at = (ms: number, extra: object = {}) => ({ nativeEvent: { timestamp: ms }, ...extra });

it('holding the mark for the threshold opens a new thread, and its release does not also open the chat', () => {
  const onNewThread = vi.fn();
  const { tree, onOpen, onPin } = row(onNewThread);
  const mark = byTestID(tree, `room-${ROOM}-new-thread`);
  const stopPropagation = vi.fn();
  act(() => mark.props.onPressIn(at(1_000, { stopPropagation })));
  act(() => mark.props.onPress(at(1_000 + NEW_THREAD_HOLD_MS)));
  expect(onNewThread).toHaveBeenCalledWith(ROOM);
  expect(onOpen).not.toHaveBeenCalled();
  expect(onPin).not.toHaveBeenCalled();
  // The mark's hold never starts the row's own pin hold.
  expect(stopPropagation).toHaveBeenCalled();
  expect(NEW_THREAD_HOLD_MS).toBe(450);
});

it('a tap on the mark or the row opens the chat without pinning', () => {
  const onNewThread = vi.fn();
  const { tree, onOpen, onPin } = row(onNewThread);
  const mark = byTestID(tree, `room-${ROOM}-new-thread`);
  act(() => mark.props.onPressIn(at(1_000)));
  act(() => mark.props.onPress(at(1_000 + NEW_THREAD_HOLD_MS - 1)));
  const chat = byTestID(tree, `room-${ROOM}`);
  act(() => chat.props.onPressIn(at(2_000)));
  act(() => chat.props.onPress(at(2_499)));
  expect(onOpen).toHaveBeenCalledTimes(2);
  expect(onPin).not.toHaveBeenCalled();
  expect(onNewThread).not.toHaveBeenCalled();
});

// A busy JS thread can deliver press-in and release together, long after the
// finger lifted; the hold still counts from the touch's own times.
it('holding the row toggles its pin instead of opening it, even when both touch events arrive at once', () => {
  const { tree, onOpen, onPin } = row();
  const chat = byTestID(tree, `room-${ROOM}`);
  act(() => {
    chat.props.onPressIn(at(1_000));
    chat.props.onPress(at(1_500));
  });
  expect(onPin).toHaveBeenCalledWith(ROOM);
  expect(onOpen).not.toHaveBeenCalled();
  expect(tree.root.findAll((node: any) => node.props?.testID === `room-${ROOM}-new-thread`)).toHaveLength(0);
});

it('shows the repository mark on the chat row and the ↳ glyph on its thread row', () => {
  let tree!: ReactTestRenderer;
  const marked = { ...item, room: {...item.room,avatar:'https://avatars.githubusercontent.com/u/42',favicon:'https://github.githubassets.com/favicons/favicon.png'},
    openCorners:[{id:'thread',name:'Thread',state:'idle',lifecycle:{lifecycle:'idle',checks:'unknown'},lastActivityAt:1_700_000_000}] } as unknown as ChatListItem;
  act(() => { tree = create(<ChatRow item={marked} now={1_700_000_000_000} first onOpen={vi.fn()} onPin={vi.fn()} onOpenThread={vi.fn()} />); });
  const marks = tree.root.findAll((node:any)=>node.type==='RepositoryMark');
  expect(marks).toHaveLength(1);
  expect(marks[0].props).toMatchObject({avatarUrl:marked.room.avatar,faviconUrl:marked.room.favicon});
  const threadRow = tree.root.find((node:any)=>node.props?.testID==='thread-row-thread');
  expect(threadRow.findAll((node:any)=>node.type==='RepositoryMark')).toHaveLength(0);
  expect(threadRow.findAll((node:any)=>node.props?.icon===CornerDownRight)).not.toHaveLength(0);
  act(() => tree.unmount());
});

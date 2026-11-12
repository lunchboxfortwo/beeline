import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('holding the mark for the threshold opens a new thread, and its release does not also open the chat', () => {
  const onNewThread = vi.fn();
  const { tree, onOpen, onPin } = row(onNewThread);
  const mark = byTestID(tree, `room-${ROOM}-new-thread`);
  const stopPropagation = vi.fn();
  act(() => mark.props.onPressIn({ stopPropagation }));
  act(() => { vi.advanceTimersByTime(NEW_THREAD_HOLD_MS - 1); });
  expect(onNewThread).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(1); });
  expect(onNewThread).toHaveBeenCalledWith(ROOM);
  act(() => mark.props.onPressOut());
  act(() => mark.props.onPress());
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
  act(() => mark.props.onPressIn({}));
  act(() => mark.props.onPressOut());
  act(() => mark.props.onPress());
  const chat = byTestID(tree, `room-${ROOM}`);
  act(() => chat.props.onPressIn({}));
  act(() => chat.props.onPressOut());
  act(() => chat.props.onPress());
  act(() => { vi.runAllTimers(); });
  expect(onOpen).toHaveBeenCalledTimes(2);
  expect(onPin).not.toHaveBeenCalled();
  expect(onNewThread).not.toHaveBeenCalled();
});

it('holding the row toggles its pin instead of opening it', () => {
  const { tree, onOpen, onPin } = row();
  const chat = byTestID(tree, `room-${ROOM}`);
  act(() => chat.props.onPressIn({}));
  act(() => { vi.advanceTimersByTime(500); });
  act(() => chat.props.onPressOut());
  act(() => chat.props.onPress());
  expect(onPin).toHaveBeenCalledWith(ROOM);
  expect(onOpen).not.toHaveBeenCalled();
  expect(tree.root.findAll((node: any) => node.props?.testID === `room-${ROOM}-new-thread`)).toHaveLength(0);
});

it('uses the parent repository mark for both a chat and its thread row', () => {
  let tree!: ReactTestRenderer;
  const marked = { ...item, room: {...item.room,avatar:'https://avatars.githubusercontent.com/u/42',favicon:'https://github.githubassets.com/favicons/favicon.png'},
    openCorners:[{id:'thread',name:'Thread',state:'idle',lifecycle:{lifecycle:'idle',checks:'unknown'}}] } as unknown as ChatListItem;
  act(() => { tree = create(<ChatRow item={marked} now={1_700_000_000_000} first onOpen={vi.fn()} onPin={vi.fn()} onOpenThread={vi.fn()} />); });
  const marks = tree.root.findAll((node:any)=>node.type==='RepositoryMark');
  expect(marks).toHaveLength(2);
  for (const mark of marks) expect(mark.props).toMatchObject({avatarUrl:marked.room.avatar,faviconUrl:marked.room.favicon});
  act(() => tree.unmount());
});

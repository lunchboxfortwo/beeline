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
import { ChatRow, ChatRowDivider, NEW_THREAD_HOLD_MS } from './ChatTree';
import { CornerDownRight } from 'lucide-react-native';
import { TextSizeContext, type TextSize } from '@/ui/grammar';

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

// A swipeable row must start on its divider and end on the next one, with the
// same unswiped spacing as a row that draws its own divider.
it('with the divider outside, the row spans divider to divider and keeps its spacing', () => {
  const props = { item, now: 1_700_000_000_000, onOpen: vi.fn(), onPin: vi.fn(), onOpenThread: vi.fn() };
  const vertical = (tree: ReactTestRenderer) => {
    const box = byTestID(tree, `chat-${ROOM}`);
    const separator = box.findAll((node: any) => node.type === 'Separator');
    return { top: box.props.paddingTop, bottom: box.props.paddingBottom, separator, gap: separator[0]?.props.marginBottom };
  };
  let inside!: ReactTestRenderer;
  let outside!: ReactTestRenderer;
  let last!: ReactTestRenderer;
  let divider!: ReactTestRenderer;
  act(() => {
    inside = create(<ChatRow {...props} first={false} />);
    outside = create(<ChatRow {...props} first={false} dividerOutside />);
    last = create(<ChatRow {...props} first={false} dividerOutside last />);
    divider = create(<ChatRowDivider roomId={ROOM} />);
  });
  const before = vertical(inside);
  const after = vertical(outside);
  expect(before.separator).toHaveLength(1);
  expect(after.separator).toHaveLength(0);
  expect(divider.root.findAll((node: any) => node.type === 'Separator')).toHaveLength(1);
  // Divider to content: unchanged.
  expect(after.top).toBe(before.gap);
  // Content to the next divider: this row's bottom plus the next row's top, as before.
  expect(after.bottom).toBe(before.bottom + before.top);
  expect(vertical(last).bottom).toBe(before.bottom);
  for (const tree of [inside, outside, last, divider]) act(() => tree.unmount());
});

it('labels the same waiting thread "waiting on you" in semibold for its commander and "waiting on <name>" for another member', () => {
  const commander = 'c'.repeat(64);
  const member = 'm'.repeat(64);
  const waiting = {
    ...item,
    openCorners: [{
      id: 'corner-w', name: 'One durable turn owner', state: 'waiting' as const, reason: 'question' as const, mine: true as const,
      blocker: { kind: 'report' as const, personId: commander, personName: 'Claude' }, lastActivityAt: 1_700_000_000,
    }],
  } as unknown as ChatListItem;
  const label = (viewer: string) => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<ChatRow item={waiting} viewer={viewer} now={1_700_000_000_000} first onOpen={vi.fn()} onPin={vi.fn()} onOpenThread={vi.fn()} />);
    });
    const line = byTestID(tree, 'thread-row-corner-w');
    const text = line.findAll((node: any) => node.type === 'Text').at(-1)!;
    const result = { aria: line.props['aria-label'], word: text.props.children, face: text.props.fontFamily };
    act(() => tree.unmount());
    return result;
  };
  expect(label(commander)).toEqual({
    aria: 'Thread One durable turn owner, waiting on you', word: 'waiting on you', face: 'SpaceGrotesk-SemiBold',
  });
  // The other member follows the thread too (`mine`), yet it waits on Claude, not on them.
  expect(label(member)).toEqual({
    aria: 'Thread One durable turn owner, waiting on Claude', word: 'waiting on Claude', face: 'SpaceGrotesk-Regular',
  });
});

// Chat list previews stop at two lines at every Text size.
it.each(['small', 'medium', 'large'] as const)('a long chat preview at Text size %s stops at two lines', (size: TextSize) => {
  const text = 'A long preview that runs well past two lines on a phone, so a line cap would cut it off. '.repeat(4);
  const long = { ...item, latestMessage: { id: 'm', text, author: { name: 'Ada' }, createdAt: 1_700_000_000 } } as unknown as ChatListItem;
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<TextSizeContext.Provider value={size}><ChatRow item={long} now={1_700_000_000_000} first onOpen={vi.fn()} onPin={vi.fn()} onOpenThread={vi.fn()} /></TextSizeContext.Provider>);
  });
  const preview = byTestID(tree, `room-${ROOM}-preview`);
  expect(preview.props.numberOfLines).toBe(2);
  expect(preview.props.ellipsizeMode).toBeUndefined();
  act(() => tree.unmount());
});

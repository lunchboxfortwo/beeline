import * as React from 'react';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

vi.mock('@/ui/screens/tags/WorkMarks', () => ({
  WorkStateMark: (props: any) => React.createElement('WorkStateMark', props),
}));
vi.mock('@/components/buzz/RepositoryMark', () => ({
  RepositoryMark: (props: any) => React.createElement('RepositoryMark', props),
}));
vi.mock('tamagui', async () => (await import('./tamagui-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () =>
  (await import('./tamagui-hosts.test-support')).lucideHosts(),
);
vi.mock('react-native-svg', async () => (await import('./tamagui-hosts.test-support')).svgHosts());
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('@/buzz/message-outbox-observer', () => ({ useRoomOutboxFailure: () => null }));
vi.mock('@/buzz/room-corner-store', () => ({ useRoomCornerSummary: () => null }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: () => null }));

import type { ChatListItem } from '@beeline/buzz-client';
import { ChatRow, ChatRowDivider, NEW_THREAD_HOLD_MS } from './ChatTree';
import { WorkStateMark } from '@/ui/screens/tags/WorkMarks';
import { TextSizeContext, type TextSize } from '@/ui/grammar';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
    tree = create(
      <ChatRow item={item} now={1_700_000_000_000} first {...handlers} onNewThread={onNewThread} />,
    );
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
  expect(
    tree.root.findAll((node: any) => node.props?.testID === `room-${ROOM}-new-thread`),
  ).toHaveLength(0);
});

it('shows the repository mark on the chat row and the status glyph first on its thread row', () => {
  let tree!: ReactTestRenderer;
  const marked = {
    ...item,
    room: {
      ...item.room,
      avatar: 'https://avatars.githubusercontent.com/u/42',
      favicon: 'https://github.githubassets.com/favicons/favicon.png',
    },
    openCorners: [
      {
        id: 'thread',
        name: 'Thread',
        state: 'waiting',
        workState: 'needs-you',
        lifecycle: { lifecycle: 'idle', checks: 'unknown' },
        lastActivityAt: 1_700_000_000,
      },
    ],
  } as unknown as ChatListItem;
  act(() => {
    tree = create(
      <ChatRow
        item={marked}
        now={1_700_000_000_000}
        first
        onOpen={vi.fn()}
        onPin={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    );
  });
  const marks = tree.root.findAll((node: any) => node.type === 'RepositoryMark');
  expect(marks).toHaveLength(1);
  expect(marks[0].props).toMatchObject({
    avatarUrl: marked.room.avatar,
    faviconUrl: marked.room.favicon,
  });
  const threadRow = tree.root.find((node: any) => node.props?.testID === 'thread-row-thread');
  expect(threadRow.findAll((node: any) => node.type === 'RepositoryMark')).toHaveLength(0);
  expect(threadRow.findByType(WorkStateMark).props.state).toBe('needs-you');
  const host = threadRow.findAll((node: any) => typeof node.type === 'string')[0]!;
  expect(host.findAll((node: any) => typeof node.type === 'string')[1]?.type).toBe('WorkStateMark');
  act(() => tree.unmount());
});

// A swipeable row must start on its divider and end on the next one, with the
// same unswiped spacing as a row that draws its own divider.
it('with the divider outside, the row spans divider to divider and keeps its spacing', () => {
  const props = {
    item,
    now: 1_700_000_000_000,
    onOpen: vi.fn(),
    onPin: vi.fn(),
    onOpenThread: vi.fn(),
  };
  const vertical = (tree: ReactTestRenderer) => {
    const box = byTestID(tree, `chat-${ROOM}`);
    const separator = box.findAll((node: any) => node.type === 'Separator');
    return {
      top: box.props.paddingTop,
      bottom: box.props.paddingBottom,
      separator,
      gap: separator[0]?.props.marginBottom,
    };
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

it('names whom a waiting thread waits on for screen readers, showing only its pause glyph and name', () => {
  const commander = 'c'.repeat(64);
  const member = 'm'.repeat(64);
  const waiting = {
    ...item,
    openCorners: [
      {
        id: 'corner-w',
        name: 'One durable turn owner',
        state: 'waiting' as const,
        reason: 'question' as const,
        mine: true as const,
        blocker: { kind: 'report' as const, personId: commander, personName: 'Claude' },
        lastActivityAt: 1_700_000_000,
      },
    ],
  } as unknown as ChatListItem;
  const label = (viewer: string) => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <ChatRow
          item={waiting}
          viewer={viewer}
          now={1_700_000_000_000}
          first
          onOpen={vi.fn()}
          onPin={vi.fn()}
          onOpenThread={vi.fn()}
        />,
      );
    });
    const line = byTestID(tree, 'thread-row-corner-w');
    const texts = line.findAll((node: any) => node.type === 'Text');
    const result = {
      aria: line.props['aria-label'],
      shown: texts.map((text: any) => text.props.children),
      glyph: line.findByType(WorkStateMark).props.state,
    };
    act(() => tree.unmount());
    return result;
  };
  expect(label(commander)).toEqual({
    aria: 'Thread One durable turn owner, waiting on you',
    shown: ['One durable turn owner'],
    glyph: 'needs-you',
  });
  // The other member follows the thread too (`mine`), yet it waits on Claude, not on them.
  expect(label(member)).toEqual({
    aria: 'Thread One durable turn owner, waiting on Claude',
    shown: ['One durable turn owner'],
    glyph: 'needs-you',
  });
});

// Chat list previews stop at two lines at every Text size.
it.each(['small', 'medium', 'large'] as const)(
  'a long chat preview at Text size %s stops at two lines',
  (size: TextSize) => {
    const text =
      'A long preview that runs well past two lines on a phone, so a line cap would cut it off. '.repeat(
        4,
      );
    const long = {
      ...item,
      latestMessage: { id: 'm', text, author: { name: 'Ada' }, createdAt: 1_700_000_000 },
    } as unknown as ChatListItem;
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <TextSizeContext.Provider value={size}>
          <ChatRow
            item={long}
            now={1_700_000_000_000}
            first
            onOpen={vi.fn()}
            onPin={vi.fn()}
            onOpenThread={vi.fn()}
          />
        </TextSizeContext.Provider>,
      );
    });
    const preview = byTestID(tree, `room-${ROOM}-preview`);
    expect(preview.props.numberOfLines).toBe(2);
    expect(preview.props.ellipsizeMode).toBeUndefined();
    act(() => tree.unmount());
  },
);

it('selection preserves the content columns and leaves an inset around the mark and age', () => {
  const { tree } = row();
  const frame = () => byTestID(tree, `room-${ROOM}`).props;
  const plain = frame();
  act(() =>
    tree.update(
      <ChatRow
        item={item}
        now={1_700_000_000_000}
        first
        selected
        onOpen={vi.fn()}
        onPin={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    ),
  );
  const selected = frame();
  for (const props of [plain, selected]) {
    expect(props.paddingHorizontal).toBe('2');
    expect(props.paddingVertical).toBe('2');
    expect(props.paddingLeft).toBeUndefined();
    expect(props.borderLeftWidth).toBe(1);
  }
  expect(plain.borderColor).toBe('transparent');
  expect(selected.borderColor).toBe('needsYou');
  act(() => tree.unmount());
});

it('the Desktop layout proof uses recent activity rather than Unix-epoch sentinels', () => {
  const require = createRequire(import.meta.url);
  const source = readFileSync(
    new URL('../../../../scripts/desktop-proportions-native-fixture.cjs', import.meta.url),
    'utf8',
  );
  // Evaluate the fixture's actual data without opening its HTTP listener.
  const fixture = runInNewContext(`${source}\n;({ room, messages })`, {
    require: (name: string) =>
      name === 'http' ? { createServer: () => ({ listen() {} }) } : require(name),
    process: { env: {} },
  });
  const now = Date.now();
  const latest = fixture.messages.at(-1);
  expect(latest.createdAt).toBeGreaterThan(Math.floor(now / 1000) - 120);
  expect(fixture.room.updatedAt).toBe(latest.createdAt);
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <ChatRow
        item={{ ...item, room: fixture.room, latestMessage: latest }}
        now={now}
        first
        onOpen={vi.fn()}
        onPin={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    );
  });
  expect(byTestID(tree, `room-${fixture.room.id}-age`).props.children).toBe('1m');
  act(() => tree.unmount());
});

it('shows up to three waiting threads, then more opens every thread, waiting first, with idle as a hollow ring', () => {
  const blocked = Array.from({ length: 5 }, (_, i) => ({
    id: `blocked-${i}`,
    name: `Needs you ${i}`,
    state: 'waiting',
    workState: 'needs-you',
  }));
  const other = ['in-progress', 'in-review', 'backlog', 'done'].map((workState) => ({
    id: workState,
    name: workState,
    state: 'working',
    workState,
  }));
  const idle = { id: 'idle', name: 'idle', state: 'idle', workState: 'in-progress' };
  let tree!: ReactTestRenderer;
  const props = {
    now: 1_700_000_000_000,
    first: true,
    onOpen: vi.fn(),
    onPin: vi.fn(),
    onOpenThread: vi.fn(),
  };
  act(() => {
    tree = create(
      <ChatRow
        {...props}
        item={{ ...item, openCorners: [...other, idle, ...blocked] } as unknown as ChatListItem}
      />,
    );
  });
  const rows = () =>
    tree.root.findAll(
      (n: any) =>
        typeof n.type === 'string' && String(n.props.testID ?? '').startsWith('thread-row-'),
    );
  const ids = () => rows().map((row: any) => row.props.testID.slice('thread-row-'.length));
  expect(ids()).toEqual(['blocked-0', 'blocked-1', 'blocked-2']);
  const more = byTestID(tree, `more-${ROOM}`);
  expect(more.props['aria-label']).toBe('Show 7 more threads');
  act(() => more.props.onPress());
  expect(ids()).toEqual([
    ...blocked.map((corner) => corner.id),
    'in-progress',
    'in-review',
    'backlog',
    'done',
    'idle',
  ]);
  expect(tree.root.findAll((n: any) => n.props.testID === `more-${ROOM}`)).toHaveLength(0);
  const row = (id: string) => rows().find((each: any) => each.props.testID === `thread-row-${id}`);
  const glyph = (id: string) => row(id).findByType(WorkStateMark).props;
  expect(glyph('idle')).toMatchObject({ state: 'in-progress', idle: true });
  expect(glyph('in-progress')).toMatchObject({ state: 'in-progress', idle: false });
  expect(glyph('backlog').state).toBe('backlog');
  // Waiting names are semibold ink; the rest are regular and quieter, both at the meta size.
  const name = (id: string) => row(id).find((n: any) => n.type === 'Text').props;
  expect(name('blocked-0')).toMatchObject({ color: 'ink' });
  expect(name('in-progress')).toMatchObject({ color: 'secondary' });
  expect(name('blocked-0').fontFamily).not.toBe(name('in-progress').fontFamily);
  expect(name('blocked-0').fontSize).toBe(name('in-progress').fontSize);
  act(() => {
    tree.update(
      <ChatRow {...props} item={{ ...item, openCorners: [...other, idle] } as unknown as ChatListItem} />,
    );
  });
  expect(tree.root.findAll((n: any) => n.props.testID === `nest-${ROOM}`)).toHaveLength(0);
  act(() => tree.unmount());
});

it.each(['small', 'medium', 'large'] as const)(
  'draws thread names at the meta size of Text size %s, below the chat title',
  (size: TextSize) => {
    const waiting = {
      ...item,
      openCorners: [{ id: 'w', name: 'waiting', state: 'waiting', workState: 'needs-you' }],
    } as unknown as ChatListItem;
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <TextSizeContext.Provider value={size}>
          <ChatRow item={waiting} now={1_700_000_000_000} first onOpen={vi.fn()} onPin={vi.fn()} onOpenThread={vi.fn()} />
        </TextSizeContext.Provider>,
      );
    });
    const name = byTestID(tree, 'thread-row-w').find((n: any) => n.type === 'Text').props;
    const preview = byTestID(tree, `room-${ROOM}-preview`).props;
    expect(name.fontSize).toBe(preview.fontSize);
    act(() => tree.unmount());
  },
);

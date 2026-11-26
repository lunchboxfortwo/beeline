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
vi.mock('react-native', () => ({ useWindowDimensions: () => ({ height: 844, width: 390 }) }));
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
vi.mock('@/components/buzz/Button', () => ({ Button: (props: any) => React.createElement('Button', props) }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: () => null }));

import type { ChatListItem } from '@beeline/buzz-client';
import { ChatRow, ChatRowDivider, JoinableChats, NEW_THREAD_HOLD_MS } from './ChatTree';
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

/** The viewer every waiting fixture waits on. */
const VIEWER = 'viewer';
const ON_VIEWER = { kind: 'report', personId: VIEWER, personName: 'Vera' };

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

it('shows the repository picture on the chat row and its thread row as ↳, name, then state mark', () => {
  let tree!: ReactTestRenderer;
  const marked = {
    ...item,
    room: {
      ...item.room,
      avatar: 'https://avatars.githubusercontent.com/u/42',
      favicon: 'https://github.githubassets.com/favicons/favicon.png',
      homepageIcon: 'https://api/v1/company-logos/https%3A%2F%2Fgrunt.run%2F',
    },
    openCorners: [
      {
        id: 'thread',
        name: 'Thread',
        state: 'waiting',
        blocker: { kind: 'report', personId: 'viewer', personName: 'Vera' },
        lifecycle: { lifecycle: 'idle', checks: 'unknown' },
        lastActivityAt: 1_700_000_000,
      },
    ],
  } as unknown as ChatListItem;
  act(() => {
    tree = create(
      <ChatRow
        item={marked}
        viewer="viewer"
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
  // Only the repository's own icon file: no owner avatar or GitHub favicon.
  expect(marks[0].props).toEqual({ homepageIconUrl: marked.room.homepageIcon, size: 36 });
  const threadRow = tree.root.find((node: any) => node.props?.testID === 'thread-row-thread');
  expect(threadRow.findAll((node: any) => node.type === 'RepositoryMark')).toHaveLength(0);
  expect(threadRow.findByType(WorkStateMark).props.state).toBe('needs-you');
  const host = threadRow.findAll((node: any) => typeof node.type === 'string')[0]!;
  const parts = host.children.filter((child: any) => typeof child !== 'string');
  expect(parts[0].findAll((node: any) => node.type === 'Icon.CornerDownRight')).toHaveLength(1);
  expect(parts.at(-1).findAll((node: any) => node.type === 'WorkStateMark')).toHaveLength(1);
  // The thread under the chat carries the needs-you mark; the chat row does not repeat it.
  expect(tree.root.findAll((node: any) => node.props?.testID === 'status-mark')).toHaveLength(0);
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

it('names a thread that waits on the viewer for screen readers; a wait on someone else does not list it', () => {
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
    const lines = tree.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === 'thread-row-corner-w');
    if (!lines.length) {
      act(() => tree.unmount());
      return null;
    }
    const line = lines[0];
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
  // The other member follows the thread too (`mine`), yet it waits on Claude, not on them:
  // it needs nothing from them, so it is not listed under the chat.
  expect(label(member)).toBeNull();
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

it('expands and collapses only threads waiting on the viewer and marks hidden waits', () => {
  const blocked = Array.from({ length: 5 }, (_, i) => ({
    id: `blocked-${i}`,
    name: `Needs you ${i}`,
    state: 'waiting',
    blocker: ON_VIEWER,
  }));
  const other = [
    { id: 'in-progress', name: 'in-progress', state: 'working' },
    { id: 'in-review', name: 'in-review', state: 'review' },
    { id: 'backlog', name: 'backlog', state: 'idle', reason: 'backlog' },
    { id: 'idle', name: 'idle', state: 'idle' },
    { id: 'other-wait', name: 'Other wait', state: 'waiting', blocker: { ...ON_VIEWER, personId: 'other' } },
  ];
  let tree!: ReactTestRenderer;
  const props = {
    viewer: VIEWER,
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
        item={{ ...item, openCorners: [...other, ...blocked] } as unknown as ChatListItem}
      />,
    );
  });
  const rows = () =>
    tree.root.findAll(
      (n: any) =>
        typeof n.type === 'string' && String(n.props.testID ?? '').startsWith('thread-row-'),
    );
  const ids = () => rows().map((row: any) => row.props.testID.slice('thread-row-'.length));
  const statusMarks = () => tree.root.findAll((n: any) => n.type === 'YStack' && n.props.testID === 'status-mark');
  const controls = (action: string) => tree.root.findAll((n: any) => n.props.testID === `${action}-${ROOM}`);
  expect(ids()).toEqual(['blocked-0', 'blocked-1', 'blocked-2']);
  expect(statusMarks()).toHaveLength(1);
  const more = byTestID(tree, `more-${ROOM}`);
  const controlHeight = more.props.minHeight;
  expect(more.props['aria-label']).toBe('Show 2 more threads');
  act(() => more.props.onPress());
  expect(ids()).toEqual(blocked.map((corner) => corner.id));
  expect(statusMarks()).toHaveLength(0);
  expect(controls('more')).toHaveLength(0);
  const less = byTestID(tree, `less-${ROOM}`);
  expect(less.props['aria-label']).toBe('Show fewer threads');
  expect(less.props.minHeight).toBe(controlHeight);
  expect(less.findAll((node: any) => node.type === 'Icon.ChevronUp')).toHaveLength(1);
  act(() => less.props.onPress());
  expect(ids()).toEqual(['blocked-0', 'blocked-1', 'blocked-2']);
  expect(controls('less')).toHaveLength(0);
  expect(statusMarks()).toHaveLength(1);

  const singleWait = { ...item, openCorners: [...other, blocked[0]] } as unknown as ChatListItem;
  act(() => tree.update(<ChatRow {...props} item={singleWait} />));
  expect(ids()).toEqual(['blocked-0']);
  expect(controls('more')).toHaveLength(0);
  expect(statusMarks()).toHaveLength(0);
  act(() => tree.update(<ChatRow {...props} item={{ ...singleWait, agentState: 'needs-you' }} />));
  expect(statusMarks()).toHaveLength(1);

  act(() => {
    tree.update(
      <ChatRow {...props} item={{ ...item, openCorners: other } as unknown as ChatListItem} />,
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
      openCorners: [{ id: 'w', name: 'waiting', state: 'waiting', blocker: ON_VIEWER }],
    } as unknown as ChatListItem;
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <TextSizeContext.Provider value={size}>
          <ChatRow item={waiting} viewer={VIEWER} now={1_700_000_000_000} first onOpen={vi.fn()} onPin={vi.fn()} onOpenThread={vi.fn()} />
        </TextSizeContext.Provider>,
      );
    });
    const name = byTestID(tree, 'thread-row-w').find((n: any) => n.type === 'Text').props;
    const preview = byTestID(tree, `room-${ROOM}-preview`).props;
    expect(name.fontSize).toBe(preview.fontSize);
    act(() => tree.unmount());
  },
);

it('keeps B as the default and permits the local avatar-column C comparison, ↳ leading both', () => {
  const marked = { ...item, openCorners: [{ id: 'thread', name: 'Thread', state: 'waiting', blocker: ON_VIEWER }] } as unknown as ChatListItem;
  const props = { item: marked, viewer: VIEWER, now: 1_700_000_000_000, first: true, onOpen: vi.fn(), onPin: vi.fn(), onOpenThread: vi.fn() };
  let tree!: ReactTestRenderer;
  act(() => { tree = create(<ChatRow {...props} />); });
  const thread = () => byTestID(tree, 'thread-row-thread');
  const icons = () => thread().findAll((node: any) => typeof node.type === 'string' && node.type === 'Icon.CornerDownRight');
  expect(icons()).toHaveLength(1);
  expect(tree.root.findByType('RepositoryMark').props.size).toBe(36);
  act(() => tree.update(<ChatRow {...props} threadLayout="C" />));
  expect(icons()).toHaveLength(1);
  expect(icons()[0].props.size).toBe(16);
  expect(thread().findByType(WorkStateMark).props.state).toBe('needs-you');
  expect(tree.root.findByType('RepositoryMark').props.size).toBe(40);
  expect(byTestID(tree, `nest-${ROOM}`).props).toMatchObject({ marginLeft: '0', paddingLeft: '2', borderLeftWidth: 1 });
  act(() => tree.update(<ChatRow {...props} />));
  expect(icons()).toHaveLength(1);
  expect(tree.root.findByType('RepositoryMark').props.size).toBe(36);
  act(() => tree.unmount());
});


it('Clear dispatches the section action; the next server projection hides it and a new chat shows it again', () => {
  const onClear = vi.fn();
  const chats = [{ id: 'public', name: 'Public', memberCount: 23 }];
  const props = { chats, joining: null, clearing: false, onClear, onJoin: vi.fn() };
  let tree!: ReactTestRenderer;
  act(() => { tree = create(<JoinableChats {...props} />); });
  act(() => byTestID(tree, 'clear-joinable').props.onPress());
  expect(onClear).toHaveBeenCalledOnce();
  // The component renders the server's list as-is while the write is pending.
  act(() => tree.update(<JoinableChats {...props} clearing />));
  expect(byTestID(tree, 'clear-joinable').props.disabled).toBe(true);
  expect(byTestID(tree, 'joinable-public')).toBeDefined();
  act(() => tree.update(<JoinableChats {...props} chats={[]} />));
  expect(tree.toJSON()).toBeNull();
  act(() => tree.update(<JoinableChats {...props} chats={[{ id: 'new', name: 'New', memberCount: 1 }]} />));
  expect(byTestID(tree, 'joinable-new')).toBeDefined();
  expect(tree.root.findAll((node: any) => node.props.testID === 'joinable-public')).toHaveLength(0);
  act(() => tree.unmount());
});

it.each([undefined, 'human', 'agent'] as const)('shows a running call only for an agent DM (peer=%s)', kind => {
  let tree!: ReactTestRenderer;
  const chat = {
    ...item,
    directMessage: kind ? { peer: { pubkey: 'peer', kind, name: 'Ruby' } } : undefined,
    voiceCall: { id: 'call', roomId: ROOM, startedAt: 1_700_000_000, participants: [] },
  } as unknown as ChatListItem;
  act(() => { tree = create(<ChatRow item={chat} now={1_700_000_010_000} first onOpen={() => {}} onPin={() => {}} onOpenThread={() => {}} />); });
  try {
    const preview = byTestID(tree, `room-${ROOM}-preview`);
    if (kind === 'agent') expect(preview.props.children).toBe('Ongoing call');
    else expect(preview.props.children).not.toBe('Ongoing call');
  } finally { act(() => tree.unmount()); }
});

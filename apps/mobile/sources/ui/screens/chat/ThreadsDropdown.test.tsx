import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ summary: undefined as any, corners: undefined as any, blur: () => {}, platform: 'web' }));
vi.mock('expo-router', async () => {
  const R = await import('react');
  return {
    router: { push: vi.fn(() => fixture.blur()) },
    useFocusEffect: (effect: () => (() => void)) => R.useEffect(() => {
      fixture.blur = effect();
      return fixture.blur;
    }, [effect]),
  };
});
vi.mock('react-native', () => ({ Platform: { get OS() { return fixture.platform; } }, useWindowDimensions: () => ({ width: 390, height: 844 }) }));
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
  // Match Tamagui's native pointerEvents helper: its spread of the touch event
  // drops inherited SyntheticEvent methods such as stopPropagation.
  const YStack = ({ onPointerDown, onTouchStart, ...props }: any) => R.createElement('YStack', {
    ...props,
    ...(fixture.platform === 'web' ? { onPointerDown, onTouchStart } : {
      onTouchStart: (event: any) => {
        onTouchStart?.(event);
        onPointerDown?.({ ...event, pointerType: 'touch', pointerId: event.nativeEvent.identifier });
      },
    }),
  });
  return { Collapsible, ScrollView: 'ScrollView', Separator: 'Separator', XStack: 'XStack', YStack };
});
vi.mock('lucide-react-native', () => ({ ChevronDown: 'ChevronDown', ChevronUp: 'ChevronUp', CornerDownRight: 'CornerDownRight' }));
vi.mock('@/components/buzz/HullDialog', () => ({ HullDialog: 'HullDialog' }));
vi.mock('@/ui/grammar', () => ({ Btn: 'Btn', Copy: 'Copy', Glyph: 'Glyph', HEIGHT: { control: 44 } }));
vi.mock('@/ui/screens/thread/ThreadLine', () => ({ ThreadLine: 'ThreadLine' }));
vi.mock('@/buzz/room-corner-store', () => ({ useRoomCornerSummary: () => fixture.summary }));
vi.mock('@/buzz/use-room-corners', () => ({ useRoomCorners: () => fixture.corners }));
import { ThreadsDropdown, ThreadsDropdownScope } from './ThreadsDropdown';
import { openPlace } from '@/ui/shell/panel';

const byTestID = (tree: any, testID: string) => tree.root.findAll((node: any) => node.props.testID === testID && typeof node.type === 'string');

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; fixture.platform = 'web'; });

it.each([false, true])('closes the expanded list when Chat info opens (desktop: %s)', (desktop) => {
  fixture.summary = { cornerCount: 1, openCorners: [] };
  fixture.corners = { openRows: [], record: {} };
  let tree: any;
  act(() => { tree = create(<ThreadsDropdownScope>
    <button onClick={() => openPlace({ kind: 'chat-info', roomId: 'r' }, desktop)}>Chat info</button>
    <ThreadsDropdown roomId="r" chatName="beeline" openThread={vi.fn()} onNewThread={vi.fn()} />
  </ThreadsDropdownScope>); });
  act(() => byTestID(tree, 'threads-dropdown-trigger')[0].props.onPress());
  expect(byTestID(tree, 'threads-dropdown-list')).toHaveLength(1);
  act(() => tree.root.findByType('button').props.onClick());
  expect(byTestID(tree, 'threads-dropdown-trigger')[0].props['aria-expanded']).toBe(false);
  expect(byTestID(tree, 'threads-dropdown-list')).toHaveLength(0);
  act(() => tree.unmount());
});

it.each(['onTouchStart', 'onPointerDown'])('dismisses on outside input without consuming it (%s)', (event) => {
  fixture.summary = { cornerCount: 1, openCorners: [] };
  fixture.corners = { openRows: [], record: {} };
  let tree: any;
  act(() => { tree = create(<ThreadsDropdownScope><ThreadsDropdown roomId="r" chatName="beeline" openThread={vi.fn()} onNewThread={vi.fn()} /></ThreadsDropdownScope>); });
  act(() => byTestID(tree, 'threads-dropdown-trigger')[0].props.onPress());
  const stopPropagation = vi.fn();
  act(() => byTestID(tree, 'threads-dropdown')[0].props[event]({ stopPropagation }));
  expect(stopPropagation).toHaveBeenCalledOnce();
  expect(byTestID(tree, 'threads-dropdown-list')).toHaveLength(1);
  act(() => byTestID(tree, 'threads-dismiss-scope')[0].props[event]());
  expect(byTestID(tree, 'threads-dropdown-list')).toHaveLength(0);
  act(() => tree.unmount());
});

it.each(['android', 'ios'])('opens Threads and delivers outside actions with native touch events (%s)', (platform) => {
  fixture.platform = platform;
  fixture.summary = { cornerCount: 1, openCorners: [{ id: 'a', name: 'Thread', state: 'waiting' }] };
  fixture.corners = { openRows: [], record: {} };
  const outsidePress = vi.fn();
  let tree: any;
  act(() => { tree = create(<ThreadsDropdownScope>
    <button onClick={outsidePress}>Composer</button>
    <ThreadsDropdown roomId="r" chatName="beeline" openThread={vi.fn()} onNewThread={vi.fn()} />
  </ThreadsDropdownScope>); });
  const nativeEvent = () => Object.assign(Object.create({ stopPropagation: vi.fn() }), {
    nativeEvent: { identifier: 1, pageX: 20, pageY: 100, locationX: 20, locationY: 10 },
  });
  // Native touch start bubbles before the trigger's press is delivered.
  act(() => byTestID(tree, 'threads-dropdown')[0].props.onTouchStart(nativeEvent()));
  act(() => byTestID(tree, 'threads-dropdown-trigger')[0].props.onPress());
  expect(byTestID(tree, 'threads-dropdown-list')).toHaveLength(1);
  const inside = nativeEvent();
  act(() => byTestID(tree, 'threads-dropdown')[0].props.onTouchStart(inside));
  expect(inside.stopPropagation).toHaveBeenCalledOnce();
  expect(byTestID(tree, 'threads-dropdown-list')).toHaveLength(1);
  const outside = nativeEvent();
  act(() => {
    byTestID(tree, 'threads-dismiss-scope')[0].props.onTouchStart(outside);
    tree.root.findByType('button').props.onClick();
  });
  expect(outside.stopPropagation).not.toHaveBeenCalled();
  expect(outsidePress).toHaveBeenCalledOnce();
  expect(byTestID(tree, 'threads-dropdown-list')).toHaveLength(0);
  act(() => tree.unmount());
});

it.each(['web', 'android'])('opens the existing new-thread sheet independently of the list (%s)', (platform) => {
  fixture.platform = platform;
  const onNewThread = vi.fn();
  for (const count of [0, 3]) {
    fixture.summary = { cornerCount: count, openCorners: [] };
    fixture.corners = { openRows: [], record: {} };
    let tree: any;
    act(() => { tree = create(<ThreadsDropdown roomId="r" chatName="beeline"
      openThread={vi.fn()} onNewThread={onNewThread} />); });
    const toggle = () => byTestID(tree, 'threads-dropdown-trigger')[0];
    act(() => toggle().props.onPress());
    expect(byTestID(tree, 'threads-dropdown-list')).toHaveLength(1);
    act(() => toggle().props.onPress());
    expect(byTestID(tree, 'threads-dropdown-list')).toHaveLength(0);
    act(() => toggle().props.onPress());
    act(() => byTestID(tree, 'threads-new-thread')[0].props.onPress());
    expect(byTestID(tree, 'threads-dropdown-list')).toHaveLength(0);
    const dialog = () => tree.root.findByType('HullDialog').props;
    expect(dialog().visible).toBe(true);
    expect(dialog().title).toBe('Begin a new thread');
    expect(dialog().body).toBe('Start a new thread in this chat.');
    expect(dialog().actions.map((action: any) => action.label)).toEqual(['Cancel', 'Open thread']);
    act(() => dialog().actions[0].onPress());
    expect(tree.root.findAllByType('HullDialog')).toHaveLength(0);
    expect(onNewThread).not.toHaveBeenCalled();
    act(() => byTestID(tree, 'threads-new-thread')[0].props.onPress());
    act(() => dialog().actions[1].onPress());
    expect(onNewThread).toHaveBeenCalledOnce();
    expect(tree.root.findAllByType('HullDialog')).toHaveLength(0);
    onNewThread.mockClear();
    act(() => tree.unmount());
  }
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
  act(() => { tree = create(<ThreadsDropdown roomId="r" chatName="beeline" openThread={openThread} onNewThread={vi.fn()}
    {...{ repositoryAvatar: 'https://example.com/project.png', repositoryFavicon: 'https://example.com/favicon.ico' }} />); });
  const trigger = byTestID(tree, 'threads-dropdown-trigger')[0];
  expect(trigger.findByType('Copy').props.children).toBe('Threads · 3 active');
  expect(trigger.props.label).toBe('3 active threads in beeline');
  expect(byTestID(tree, 'threads-dropdown-list')).toHaveLength(0);
  act(() => trigger.props.onPress());
  const list = tree.root.findAllByType('ScrollView');
  expect(list).toHaveLength(1);
  expect(list[0].props.maxHeight).toBe(Math.round(844 * 0.45));
  // With the composer's keyboard up, the first tap on a thread opens it
  // instead of only lowering the keyboard.
  expect(list[0].props.keyboardShouldPersistTaps).toBe('handled');
  const lines = tree.root.findAllByType('ThreadLine');
  for (const line of lines) {
    expect(line.props.avatarUrl).toBeUndefined();
    expect(line.props.faviconUrl).toBeUndefined();
  }
  expect(lines.map((line: any) => [line.props.title, line.props.state])).toEqual([['one-row-header', 'waiting'], ['reconnect', 'review']]);
  act(() => lines[1].props.onPress());
  expect(openThread).toHaveBeenCalledWith('b');
  act(() => byTestID(tree, 'threads-dropdown-more')[0].props.onPress());
  expect(loadMoreOpen).toHaveBeenCalledTimes(1);
  act(() => tree.unmount());
});

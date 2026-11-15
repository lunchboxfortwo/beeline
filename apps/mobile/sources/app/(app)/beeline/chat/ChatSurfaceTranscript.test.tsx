import React from 'react';
import { Platform } from 'react-native';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import type { RoomViewMessage } from '@beeline/buzz-client';
import { useRoomMessageStore } from '@/buzz/room-message-store';
import { createTranscriptScrollController } from '@/buzz/transcript-scroll-controller';
import { useChatTranscriptLanding } from './useChatTranscriptLanding';

vi.mock('react-native', () => ({ View: 'View', FlatList: 'FlatList', Platform: { OS: 'android' } }));
vi.mock('tamagui', () => ({ YStack: 'YStack' }));
vi.mock('@/ui/grammar', async () => {
  const { createElement } = await import('react');
  return {
    DesktopScroll: 'DesktopScroll',
    ListPad: ({ list, x: _x, y: _y, top: _top, emptyGrow: _grow, ...rest }: any) => createElement(list, rest),
  };
});
vi.mock('@/buzz/activity-timeline', () => ({ buildTurnActivity: vi.fn() }));
vi.mock('@/components/buzz/ConversationComposer', () => ({ COMPOSER_MAX_INPUT_HEIGHT: 100, COMPOSER_SINGLE_LINE_INPUT_HEIGHT: 40 }));
vi.mock('@/buzz/room-send-list', () => ({ RoomSendList: 'RoomSendList' }));
vi.mock('@/buzz/room-scroll-follow', () => ({
  phoneTranscriptTailPadding: () => 40,
  roomOpenLandsOnTail: () => false,
  useScrollFollowOnArrival: () => 'hold',
}));
vi.mock('@/components/buzz/StarPromptCard', () => ({ StarPromptCard: () => null }));
vi.mock('@/components/buzz/RoomUnreadControls', () => ({ RoomUnreadControls: () => null }));
vi.mock('@/components/buzz/TranscriptScrubber', () => ({ TranscriptScrubber: () => null }));

import { ChatSurfaceTranscript } from './ChatSurfaceTranscript';

type Props = React.ComponentProps<typeof ChatSurfaceTranscript>;
let renderer: ReactTestRenderer;
afterEach(() => { if (renderer) act(() => renderer.unmount()); });

it('keeps a short-message viewport in the eager phone window through draft replacement and arrivals (R1)', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const row = (id: string): ChatDisplayMessage => ({ id, text: id, timestamp: 1, isUser: false });
  const history = Array.from({ length: 20 }, (_, n) => row(`earlier-${n}`));
  const props = {
    desktopTranscript: false, transcriptMessages: [row('draft'), ...history],
    scrollController: {}, phoneScrollList: {}, starPrompt: { prompt: null },
    renderItem: ({ item }: { item: ChatDisplayMessage }) => <React.Fragment>{item.text}</React.Fragment>,
  } as unknown as Props;
  act(() => { renderer = create(<ChatSurfaceTranscript {...props} />); });
  for (const messages of [props.transcriptMessages, [row('committed'), ...history], [row('next-draft'), row('committed'), ...history]]) {
    act(() => renderer.update(<ChatSurfaceTranscript {...props} transcriptMessages={messages} />));
    const list = renderer.root.findByType('RoomSendList');
    // RN retains the initial cells even when its moving window has not caught
    // up. Eight short 72dp rows fill this 576dp phone viewport without waiting
    // for another batch. Two eager rows leave three quarters of it unprotected.
    const eagerRows = list.props.data.slice(0, list.props.initialNumToRender);
    expect(eagerRows.length * 72).toBeGreaterThanOrEqual(576);
    expect(eagerRows.map((message: ChatDisplayMessage) => message.id)).toContain('earlier-5');
    expect(list.props.maxToRenderPerBatch).toBe(4);
    expect(list.props.windowSize).toBe(5);
    expect(list.props.maintainVisibleContentPosition.minIndexForVisible).toBe(1);
  }
});

it('does not redraw unchanged transcript rows when surrounding conversation state updates', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const renderItem = vi.fn(({ item }: { item: ChatDisplayMessage }) => <React.Fragment>{item.text}</React.Fragment>);
  const props = {
    desktopTranscript: true,
    transcriptMessages: [{ id: 'one', text: 'one', timestamp: 1, isUser: false }],
    getDesktopRowRefCallback: () => undefined,
    scrollController: {}, phoneScrollList: {}, starPrompt: { prompt: null }, renderItem,
  } as unknown as Props;
  act(() => { renderer = create(<ChatSurfaceTranscript {...props} />); });
  expect(renderItem).toHaveBeenCalledTimes(1);
  act(() => renderer.update(<ChatSurfaceTranscript {...props} />));
  expect(renderItem).toHaveBeenCalledTimes(1);
  act(() => renderer.update(<ChatSurfaceTranscript {...props} transcriptMessages={[
    ...props.transcriptMessages, { id: 'two', text: 'two', timestamp: 2, isUser: false },
  ]} />));
  expect(renderItem).toHaveBeenCalledTimes(3);
});

it('keeps an older notification target after native landing events, with 80 newer messages (R1)', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const row = (id: string, createdAt: number): RoomViewMessage => ({
    id, text: id, createdAt, presentation: 'message',
    author: { pubkey: 'ruby', kind: 'human', name: 'Ruby' },
  });
  const target = row('older-notification-target', 1);
  const newer = Array.from({ length: 80 }, (_, index) => row(`newer-${index}`, index + 2));
  const around = vi.fn(async () => ({ roomId: 'corner', messages: [target, ...newer] }));
  const client = { historyAround: around, history: vi.fn() };
  const frames: Array<() => void> = [];
  const displayed = { current: [] as ChatDisplayMessage[] };
  let history!: ReturnType<typeof useRoomMessageStore>;
  const controller = createTranscriptScrollController<ChatDisplayMessage>({
    rows: () => displayed.current,
    rowIndex: (destination, rows) => rows.findIndex(message => message.id === destination.messageId),
    list: () => ({ toRow: () => true, toEstimatedRow() {}, toNewest() {}, toOffset() {}, shiftBy() {} }),
    holdsLanding: () => !history.attached,
    onScrolled: () => history.endJump(),
    schedule: work => { frames.push(work); },
  });
  const noop = () => {};
  const drafts = { subscribeCommit: () => noop };
  const surface = { room: { id: 'corner' } };
  function Notification() {
    history = useRoomMessageStore({
      roomId: 'corner', tailMessages: newer, roomClient: client, enabled: true, initialVisibleCount: 200,
    });
    displayed.current = [...(history.attached ? newer : history.rows)].reverse().map(message => ({
      id: message.id, text: message.text, timestamp: message.createdAt, isUser: false,
    }));
    const handled = React.useRef<string | null>(null);
    useChatTranscriptLanding([
      controller, noop, false, noop, displayed.current, history.jump, true, null, target.id, 'corner',
      noop, drafts, { call: null }, [...displayed.current].reverse(), target.id, target.id, 'corner',
      handled, { current: new Map() }, () => true, client, 'viewer', surface, history.jumpTo,
      !history.attached, history.newerStatus, { current: null }, history.loadNewer,
    ] as unknown as Parameters<typeof useChatTranscriptLanding>[0]);
    return <ChatSurfaceTranscript {...{
      desktopTranscript: false, transcriptMessages: displayed.current, anchoredSegmentActive: !history.attached,
      scrollController: controller, phoneScrollList: {}, starPrompt: { prompt: null },
      phoneScrollOffsetRef: { current: 0 }, observePhoneTailOffset: noop,
      transcriptPositions: history.positions, loadNewerTranscriptMessages: history.loadNewer,
      allowOlderHistoryRef: { current: false },
      renderItem: ({ item }: { item: ChatDisplayMessage }) => <React.Fragment>{item.text}</React.Fragment>,
    } as unknown as Props} />;
  }
  await act(async () => { renderer = create(<Notification />); });
  const list = () => renderer.root.findByType('RoomSendList');
  expect(around).toHaveBeenCalledExactlyOnceWith('corner', target.id);
  await act(async () => { while (frames.length) frames.shift()!(); });
  const targetRow = displayed.current.find(message => message.id === target.id)!;
  act(() => controller.observeVisibleRows([targetRow]));
  expect(controller.isHoldingLanding()).toBe(true);
  const landedRows = list().props.data;
  // Android queues this old tail-offset event behind the programmatic landing.
  // It is not a reader asking to page toward the 80 newer messages.
  const tailEvent = { nativeEvent: {
    contentOffset: { y: 0 }, contentSize: { height: 1800 }, layoutMeasurement: { height: 600 },
  } };
  act(() => list().props.onScroll(tailEvent));
  expect(list().props.data).toEqual(landedRows);
  // A real reader gesture releases the held landing and may load the next page.
  act(() => list().props.onScrollBeginDrag());
  act(() => list().props.onScroll(tailEvent));
  expect(list().props.data.length).toBeGreaterThan(landedRows.length);
});

it.each(['lands', 'cancelled'])('waits for the complete killed-notification target window: %s (R1)', async (outcome) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const row = (id: string, createdAt: number): RoomViewMessage => ({
    id, text: id, createdAt, presentation: 'message',
    author: { pubkey: 'ruby', kind: 'human', name: 'Ruby' },
  });
  const target = row('fresh-killed-notification-target', 1);
  const newer = Array.from({ length: 80 }, (_, i) => row(`newer-${i + 1}`, i + 2));
  type Page = { roomId: string; messages: RoomViewMessage[] };
  let answerAround!: (page: Page) => void;
  let answerAfter!: (page: Page) => void;
  const client = {
    history: vi.fn(),
    historyAround: vi.fn(() => new Promise<Page>(resolve => { answerAround = resolve; })),
    historyAfter: vi.fn(() => new Promise<Page>(resolve => { answerAfter = resolve; })),
  };
  const frames: Array<() => void> = [];
  let history!: ReturnType<typeof useRoomMessageStore>;
  const rows = { current: [] as ChatDisplayMessage[] };
  const scroll = vi.fn(() => true);
  const controller = createTranscriptScrollController<ChatDisplayMessage>({
    rows: () => rows.current,
    rowIndex: (destination, messages) => messages.findIndex(m => m.id === destination.messageId),
    list: () => ({ toRow: scroll, toEstimatedRow() {}, toNewest() {}, toOffset() {}, shiftBy() {} }),
    holdsLanding: () => !history.attached,
    onScrolled: () => history.endJump(),
    onCancelled: () => history.endJump(),
    schedule: callback => { frames.push(callback); },
  });
  const noop = () => {};
  const drafts = { subscribeCommit: () => noop };
  function ColdNotification() {
    history = useRoomMessageStore({
      roomId: 'corner', tailMessages: newer.slice(-30), roomClient: client, enabled: true, initialVisibleCount: 200,
    });
    rows.current = [...(history.attached ? newer.slice(-30) : history.rows)].reverse().map(m => ({
      id: m.id, text: m.text, timestamp: m.createdAt, isUser: false,
    }));
    const handled = React.useRef<string | null>(null);
    useChatTranscriptLanding([
      controller, noop, false, noop, rows.current, history.jump, true, null, target.id, 'corner',
      noop, drafts, { call: null }, [...rows.current].reverse(), target.id, target.id, 'corner',
      handled, { current: new Map() }, () => true, client, 'viewer', { room: { id: 'corner' } }, history.jumpTo,
      !history.attached, history.newerStatus, { current: null }, history.loadNewer,
    ] as unknown as Parameters<typeof useChatTranscriptLanding>[0]);
    React.useLayoutEffect(() => controller.observeLayout(), [history.rows]);
    return null;
  }
  await act(async () => { renderer = create(<ColdNotification />); });
  act(() => { while (frames.length) frames.shift()!(); });
  expect(scroll).not.toHaveBeenCalled();
  // The server returns at most fourteen newer rows around the target. That
  // short page can trigger native underfill after landing. Finish the bounded
  // window first, instead of declaring that first page ready.
  await act(async () => answerAround({ roomId: 'corner', messages: [target, ...newer.slice(0, 14)] }));
  expect(history.jump).toEqual({ messageId: target.id, status: 'loading' });
  expect(client.historyAfter).toHaveBeenCalledExactlyOnceWith('corner', newer[13]!.id);
  expect(scroll).not.toHaveBeenCalled();
  if (outcome === 'cancelled') act(() => controller.cancel());
  await act(async () => answerAfter({ roomId: 'corner', messages: newer.slice(14, 44) }));
  if (outcome === 'cancelled') {
    expect(history.attached).toBe(true);
    expect(history.jump).toBeNull();
    expect(scroll).not.toHaveBeenCalled();
    return;
  }
  expect(rows.current).toHaveLength(21);
  expect(scroll).toHaveBeenCalledWith(20, target.id, 'top');
  const targetRow = rows.current.find(m => m.id === target.id)!;
  act(() => controller.observeVisibleRows([targetRow]));
  expect(controller.isHoldingLanding()).toBe(true);
  expect(client.historyAround).toHaveBeenCalledOnce();
  expect(client.historyAfter).toHaveBeenCalledOnce();
});


it.each(['onWheel', 'onTouchMove'])('pages older history after a narrow web %s gesture (history-14)', (gesture) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const previous = Platform.OS;
  Object.assign(Platform, { OS: 'web' });
  try {
    const allowOlderHistoryRef = { current: false };
    const loadOlder = vi.fn();
    const userScrolled = vi.fn();
    const props = {
      desktopTranscript: false, transcriptMessages: [],
      scrollController: { userScrolled }, phoneScrollList: {}, starPrompt: { prompt: null },
      allowOlderHistoryRef,
      loadOlderTranscriptIfReaderAsked: () => { if (allowOlderHistoryRef.current) loadOlder(); },
    } as unknown as Props;
    act(() => { renderer = create(<ChatSurfaceTranscript {...props} />); });
    const list = renderer.root.findByType('RoomSendList');
    act(() => list.props.onEndReached());
    expect(loadOlder).not.toHaveBeenCalled();
    act(() => list.props[gesture]());
    act(() => list.props.onEndReached());
    expect(loadOlder).toHaveBeenCalledOnce();
    expect(userScrolled).toHaveBeenCalledOnce();
  } finally {
    Object.assign(Platform, { OS: previous });
  }
});

it('anchors a short thread at the header instead of leaving blank space above it', () => {
  const props={desktopTranscript:false,leadBlock:<header>Thread</header>,transcriptMessages:[{id:'one',text:'one',timestamp:1,isUser:false}],scrollController:{},phoneScrollList:{},starPrompt:{prompt:null},renderItem:()=>null} as unknown as Props;
  act(()=>{renderer=create(<ChatSurfaceTranscript {...props}/>);});
  expect(renderer.root.findByType('RoomSendList').props.headAligned).toBe(true);
  act(()=>renderer.update(<ChatSurfaceTranscript {...props} leadBlock={null}/>));
  expect(renderer.root.findByType('RoomSendList').props.headAligned).toBe(false);
});

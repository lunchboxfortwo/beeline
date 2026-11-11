import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const haptics = vi.hoisted(() => ({ impact: vi.fn() }));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    // The handlers are the config, so a test can drive the gesture directly.
    PanResponder: { create: (config: any) => ({ panHandlers: config }) },
    Platform: { OS: 'android' },
    FlatList: host('FlatList'),
    Text: host('Text'),
    View: host('View'),
  };
});
vi.mock('react-native-unistyles', async () => {
  const { beelineThemes } = await import('@/buzz/groknight');
  return {
    StyleSheet: {
      create: (factory: (theme: { buzz: typeof beelineThemes.obsidian }) => unknown) =>
        factory({ buzz: beelineThemes.obsidian }),
    },
  };
});
vi.mock('expo-haptics', () => ({
  impactAsync: haptics.impact,
  ImpactFeedbackStyle: { Light: 'light' },
}));
vi.mock('@/app/(app)/beeline/chat/chat-surface-styles', () => ({ styles: {} }));
vi.mock('@/buzz/activity-timeline', () => ({ buildTurnActivity: vi.fn() }));
vi.mock('@/components/buzz/ConversationComposer', () => ({ COMPOSER_MAX_INPUT_HEIGHT: 100, COMPOSER_SINGLE_LINE_INPUT_HEIGHT: 40 }));
vi.mock('@/buzz/room-send-list', () => ({ RoomSendList: 'RoomSendList' }));
vi.mock('@/components/buzz/StarPromptCard', () => ({ StarPromptCard: () => null }));
vi.mock('@/components/buzz/RoomUnreadControls', () => ({ RoomUnreadControls: () => null }));

import type { RoomHistoryView, RoomViewMessage } from '@beeline/buzz-client';
import { useRoomMessageStore } from '@/buzz/room-message-store';
import {
  createTranscriptScrollController,
  phoneTranscriptList,
  type TranscriptScrollList,
} from '@/buzz/transcript-scroll-controller';
import { createTranscriptScrubberStore, SCRUBBER_LINGER_MS } from '@/buzz/use-transcript-scrubber';
import { TranscriptScrubber } from './TranscriptScrubber';
import { ChatSurfaceTranscript } from '@/app/(app)/beeline/chat/ChatSurfaceTranscript';
import { useChatTranscriptLanding } from '@/app/(app)/beeline/chat/useChatTranscriptLanding';
import { createLiveDraftDrainStore } from '@/buzz/live-draft-drain';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';

const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  process.env.TZ = originalTz;
});
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const RAIL = 600;
const at = (iso: string) => Date.parse(iso) / 1_000;
const scroll = (y: number, contentHeight: number) => ({
  contentOffset: { y },
  contentSize: { height: contentHeight },
  layoutMeasurement: { height: RAIL },
});

/** A scroll controller over a list that records each offset it is moved to. */
function controllerOver(toOffset: (offset: number) => void, cancelled: string[] = []) {
  const list: TranscriptScrollList = {
    toNewest: () => {},
    toRow: () => true,
    toEstimatedRow: () => {},
    toOffset,
    shiftBy: () => {},
  };
  return createTranscriptScrollController<{ id: string }>({
    list: () => list,
    rows: () => [],
    rowIndex: () => -1,
    onCancelled: (destination, reason) => cancelled.push(`${destination.kind}:${reason}`),
    schedule: () => {},
  });
}

function render(contentHeight = 5_600, offset = 0) {
  const store = createTranscriptScrubberStore();
  const listToOffset = vi.fn((y: number) =>
    store.observeScroll(scroll(y, store.getSnapshot().metrics?.contentHeight ?? contentHeight)),
  );
  const loadOlder = vi.fn();
  const cancelled: string[] = [];
  const controller = controllerOver(listToOffset, cancelled);
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <TranscriptScrubber positions={store} scrollController={controller} loadOlder={loadOlder} />,
    );
  });
  const strip = () => renderer.root.findByProps({ testID: 'transcript-scrubber' });
  act(() => strip().props.onLayout({ nativeEvent: { layout: { height: RAIL } } }));
  act(() => store.observeScroll(scroll(offset, contentHeight)));
  const grab = () => renderer.root.findByProps({ testID: 'transcript-scrubber-grab' });
  return { renderer, store, listToOffset, loadOlder, controller, cancelled, strip, grab };
}

describe('TranscriptScrubber', () => {
  it('places the bar by the list offset over the loaded rows while the list scrolls', () => {
    const { renderer, store, grab } = render(5_600, 2_500);
    // Halfway through 5000pt of scroll: halfway down the 564pt track.
    expect(grab().props.style[1].top).toBe(0.5 * (RAIL - 36) - 14);
    act(() => store.observeScroll(scroll(5_000, 5_600)));
    expect(grab().props.style[1].top).toBe(-14);
    act(() => vi.advanceTimersByTime(SCRUBBER_LINGER_MS));
    expect(renderer.root.findAllByProps({ testID: 'transcript-scrubber-grab' })).toHaveLength(0);
  });

  it('scrubber-idle-1: holds the rendered thumb still through idle row measurements', () => {
    const { renderer, store, grab } = render(5_600, 2_500);
    const top = grab().props.style[1].top;
    for (const height of [8_600, 5_600, 9_600, 5_600]) {
      act(() => {
        store.observeContentSize(height);
        store.observeScroll(scroll(2_500.25, height));
      });
      expect(grab().props.style[1].top).toBe(top);
      act(() => vi.advanceTimersByTime(SCRUBBER_LINGER_MS / 4));
    }
    expect(renderer.root.findAllByProps({ testID: 'transcript-scrubber-grab' })).toHaveLength(0);
    act(() => store.observeScroll(scroll(2_500, 8_600)));
    expect(renderer.root.findAllByProps({ testID: 'transcript-scrubber-grab' })).toHaveLength(0);
    act(() => renderer.unmount());
    store.dispose();
  });

  it('passes touches off the bar to the list', () => {
    const { strip, grab } = render();
    expect(strip().props.pointerEvents).toBe('box-none');
    expect(strip().props.onPanResponderGrant).toBeUndefined();
    expect(grab().props.onPanResponderGrant).toBeTypeOf('function');
  });

  it('has no bar when the loaded rows fit on screen', () => {
    const { renderer } = render(400);
    expect(renderer.root.findAllByProps({ testID: 'transcript-scrubber-grab' })).toHaveLength(0);
  });

  it('scrolls the list with the finger as soon as the bar is pressed', () => {
    const { renderer, store, listToOffset, grab } = render(5_600, 0);
    act(() =>
      store.observeVisibleRows([
        { id: 'a', text: 'a', isUser: false, timestamp: at('2026-09-01T09:10:00Z') },
      ]),
    );
    act(() => grab().props.onPanResponderGrant({ nativeEvent: {} }));
    expect(haptics.impact).toHaveBeenCalledTimes(1);
    // A quarter of the track up is a quarter of the way into the loaded rows.
    act(() => grab().props.onPanResponderMove({}, { dy: -(RAIL - 36) / 4 }));
    expect(listToOffset).toHaveBeenLastCalledWith(1_250);
    expect(grab().props.style[1].top).toBe(0.75 * (RAIL - 36) - 14);
    expect(
      renderer.root.findByProps({ testID: 'transcript-scrubber-bubble' }).findByType('Text').props
        .children,
    ).toBe('Tue 1 Sep');
    // Past the top: the list goes to its oldest loaded row and no further.
    act(() => grab().props.onPanResponderMove({}, { dy: -RAIL }));
    expect(listToOffset).toHaveBeenLastCalledWith(5_000);
    act(() => grab().props.onPanResponderRelease());
    expect(renderer.root.findAllByProps({ testID: 'transcript-scrubber-bubble' })).toHaveLength(0);
    // The bar stays long enough to grab again.
    act(() => vi.advanceTimersByTime(SCRUBBER_LINGER_MS - 1));
    expect(grab().props.style[1].top).toBe(-14);
  });

  it('asks the store for older rows only once the scrub reaches the oldest loaded ones', () => {
    const { loadOlder, grab } = render(5_600, 0);
    act(() => grab().props.onPanResponderGrant({ nativeEvent: {} }));
    act(() => grab().props.onPanResponderMove({}, { dy: -(RAIL - 36) / 2 }));
    expect(loadOlder).not.toHaveBeenCalled();
    act(() => grab().props.onPanResponderMove({}, { dy: -RAIL }));
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  it('keeps scrolling into older rows as they load under the finger', () => {
    const { store, listToOffset, grab } = render(5_600, 5_000);
    act(() => grab().props.onPanResponderGrant({ nativeEvent: {} }));
    act(() => grab().props.onPanResponderMove({}, { dy: -2 }));
    expect(listToOffset).toHaveBeenLastCalledWith(5_000);
    // An older page lands: the content grows, the offset holds, and no scroll
    // event follows. The held finger goes on to the new oldest row.
    act(() => store.observeContentSize(8_600));
    expect(listToOffset).toHaveBeenLastCalledWith(8_000);
  });

  it('leaves the list alone under a finger held partway up', () => {
    const { store, listToOffset, grab } = render(5_600, 0);
    act(() => grab().props.onPanResponderGrant({ nativeEvent: {} }));
    act(() => grab().props.onPanResponderMove({}, { dy: -(RAIL - 36) / 2 }));
    expect(listToOffset).toHaveBeenCalledTimes(1);
    // Rows measure, a message arrives, the keyboard opens: the finger has
    // not moved, so the list must not either.
    act(() => store.observeContentSize(6_000));
    act(() =>
      store.observeScroll({
        contentOffset: { y: 2_500 },
        contentSize: { height: 6_000 },
        layoutMeasurement: { height: 300 },
      }, false),
    );
    expect(listToOffset).toHaveBeenCalledTimes(1);
    const heldTop = grab().props.style[1].top;
    act(() => grab().props.onPanResponderRelease());
    expect(grab().props.style[1].top).toBe(heldTop);
  });

  it('lands where the finger lifts after a fling, once momentum ends', () => {
    const { listToOffset, controller, grab } = render(5_600, 0);
    // The reader flings the list, then grabs the bar while it still coasts.
    act(() => {
      controller.dragStarted();
      controller.dragEnded(true);
      controller.momentumStarted();
    });
    act(() => grab().props.onPanResponderGrant({ nativeEvent: {} }));
    act(() => grab().props.onPanResponderMove({}, { dy: -(RAIL - 36) / 4 }));
    act(() => grab().props.onPanResponderRelease());
    expect(listToOffset).toHaveBeenLastCalledWith(1_250);
    // Momentum carried the list past it; its end lands the scrub again.
    listToOffset.mockClear();
    act(() => controller.momentumEnded());
    expect(listToOffset).toHaveBeenCalledExactlyOnceWith(1_250);
    expect(controller.active()).toBeNull();
  });

  it('replaces a message jump in progress with the scrubbed offset', () => {
    const { listToOffset, controller, cancelled, grab } = render(5_600, 0);
    act(() => controller.request({ kind: 'message', messageId: 'm1', align: 'top', jump: true }));
    expect(controller.isLanding()).toBe(true);
    act(() => grab().props.onPanResponderGrant({ nativeEvent: {} }));
    act(() => grab().props.onPanResponderMove({}, { dy: -(RAIL - 36) / 2 }));
    expect(listToOffset).toHaveBeenLastCalledWith(2_500);
    expect(controller.isLanding()).toBe(false);
    // A later layout pass does not pull the list back to the jump.
    act(() => controller.observeLayout());
    expect(listToOffset).toHaveBeenCalledTimes(1);
    expect(cancelled).toEqual(['message:replaced']);
  });
});

/**
 * The Room screen's wiring around a stand-in inverted list: onScroll feeds
 * observeScroll, onContentSizeChange feeds observeContentSize, the scroll
 * controller calls scrollToOffset, and the bar asks a stand-in store for an
 * older page, which loads one page at a time. The list's own onEndReached
 * waits for a drag on the list, so it never loads here. Like iOS,
 * scrollToOffset to the offset the list already has does nothing and sends
 * no scroll event.
 */
describe('TranscriptScrubber on the Room transcript', () => {
  const PAGE = 3_000;

  it('keeps the thumb still above tail and follows the tail while one draft slowly grows', () => {
    // One stable draft, twelve small appends over three seconds, no new posts.
    // Drive the real draft-commit subscription and Room list callbacks; only
    // native measurement/anchor reports and the platform list are stand-ins.
    for (const initialOffset of [2_500, 0]) {
      const positions = createTranscriptScrubberStore();
      const drafts = createLiveDraftDrainStore({ clock: {
        requestFrame: (callback) => Number(setTimeout(callback, 16)),
        cancelFrame: (id) => clearTimeout(id),
      } });
      const draft: ChatDisplayMessage = { id: 'live-turn:agent:turn', text: 'Starting', timestamp: 1, isUser: false };
      const rows = [draft, ...Array.from({ length: 20 }, (_, n) => ({
        id: `history-${n}`, text: `Post ${n}`, timestamp: 1, isUser: true,
      }))];
      const rowIds = rows.map((row) => row.id);
      const native = { offset: initialOffset, height: 5_600 };
      let renderer!: ReactTestRenderer;
      const list = () => renderer.root.findByType('RoomSendList');
      const reportScroll = () => list().props.onScroll({ nativeEvent: scroll(native.offset, native.height) });
      const scrollToOffset = vi.fn(({ offset }: { offset: number }) => {
        native.offset = offset;
        reportScroll();
      });
      const adapter = phoneTranscriptList(() => ({ scrollToOffset, scrollToIndex: vi.fn() }), () => true);
      const controller = createTranscriptScrollController({
        list: () => adapter, rows: () => rows, rowIndex: () => -1,
        schedule: (callback) => { setTimeout(callback, 16); },
      });
      const paint = ({ text }: { text: string }) => { draft.text = text; };
      const detach = drafts.attach(draft.id, { paint, replace: paint });
      const noop = () => {};
      function Room() {
        const [, observePhoneTailOffset] = useChatTranscriptLanding([
          controller, noop, false, noop, rows, null, true, null, '', 'room',
          noop, drafts, { call: null }, [...rows].reverse(), undefined, undefined, undefined,
          { current: null }, { current: new Map() }, () => true, null, '', null,
          noop, false, 'idle', { current: null }, noop,
        ] as unknown as Parameters<typeof useChatTranscriptLanding>[0]);
        const props = {
          desktopTranscript: false, transcriptMessages: rows, scrollController: controller,
          phoneScrollList: adapter, starPrompt: { prompt: null }, transcriptPositions: positions,
          phoneScrollOffsetRef: { current: native.offset }, observePhoneTailOffset,
          allowOlderHistoryRef: { current: false }, detachedFillMeasuredRef: { current: false },
          phoneUnderfill: { observeContentHeight: noop }, holdPhoneLanding: noop,
          loadOlderTranscriptMessages: noop,
          renderItem: ({ item }: { item: ChatDisplayMessage }) => <React.Fragment>{item.text}</React.Fragment>,
        } as unknown as React.ComponentProps<typeof ChatSurfaceTranscript>;
        return <ChatSurfaceTranscript {...props} />;
      }
      try {
        act(() => { renderer = create(<Room />); });
        act(() => renderer.root.findByProps({ testID: 'transcript-scrubber' })
          .props.onLayout({ nativeEvent: { layout: { height: RAIL } } }));
        // Establish the starting thumb with a real, completed reader gesture.
        act(() => {
          list().props.onScrollBeginDrag();
          reportScroll();
          list().props.onScrollEndDrag({ nativeEvent: { contentOffset: { y: native.offset }, velocity: { y: 0 } } });
        });
        const thumbTop = renderer.root.findByProps({ testID: 'transcript-scrubber-grab' }).props.style[1].top;
        const atTail = initialOffset === 0;
        for (let step = 1; step <= 12; step++) {
          act(() => vi.advanceTimersByTime(234));
          act(() => {
            drafts.publish(draft.id, `Starting${' more'.repeat(step)}`);
            vi.advanceTimersByTime(16);
          });
          act(() => renderer.update(<Room />));
          expect(list().props.data.map((row: ChatDisplayMessage) => row.id)).toEqual(rowIds);
          expect(draft.text).toBe(`Starting${' more'.repeat(step)}`);
          act(() => {
            // Inverted native anchoring moves the old reading row as the
            // newest draft gains 12pt. Layout must restore a pinned tail.
            native.height += 12;
            native.offset += 12;
            reportScroll();
            list().props.onContentSizeChange(400, native.height);
          });
          expect.soft(native.offset, `step ${step}, tail=${atTail}`).toBe(atTail ? 0 : initialOffset + step * 12);
          expect(controller.isPinnedToTail()).toBe(atTail);
          const thumbs = renderer.root.findAllByProps({ testID: 'transcript-scrubber-grab' })
            .filter((node: { type: unknown }) => typeof node.type === 'string');
          if (step * 250 < SCRUBBER_LINGER_MS) {
            expect(thumbs).toHaveLength(1);
            expect.soft(thumbs[0].props.style[1].top, `step ${step}, tail=${atTail}`).toBe(thumbTop);
          } else {
            expect.soft(thumbs, `idle thumb after ${step * 250}ms, tail=${atTail}`).toHaveLength(0);
          }
        }
        expect(drafts.getMetrics(draft.id)).toMatchObject({ arrivals: 12, paints: 12 });
        expect(scrollToOffset.mock.calls).toHaveLength(atTail ? 24 : 0);
        expect(positions.getSnapshot().metrics?.contentHeight).toBe(5_744);
      } finally {
        act(() => renderer?.unmount());
        detach();
        drafts.reset();
        positions.dispose();
        vi.clearAllTimers();
      }
    }
  });

  function mountRoom() {
    const store = createTranscriptScrubberStore();
    const list = { offset: 0, contentHeight: 5_600, loads: 0, pending: 0 };
    const scrollEvent = () => ({
      contentOffset: { y: list.offset },
      contentSize: { height: list.contentHeight },
      layoutMeasurement: { height: RAIL },
    });
    const loadOlder = () => {
      if (list.pending) return;
      list.loads += 1;
      list.pending += 1;
    };
    // An older page renders on a later frame, at the top of the content.
    const landOlderPage = () => {
      expect(list.pending).toBeGreaterThan(0);
      list.pending -= 1;
      list.contentHeight += PAGE;
      store.observeContentSize(list.contentHeight);
    };
    const scrollToOffset = (offset: number) => {
      const next = Math.min(Math.max(0, offset), list.contentHeight - RAIL);
      if (next === list.offset) return;
      list.offset = next;
      store.observeScroll(scrollEvent());
    };
    const controller = controllerOver(scrollToOffset);
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <TranscriptScrubber
          positions={store}
          scrollController={controller}
          loadOlder={loadOlder}
        />,
      );
    });
    act(() =>
      renderer.root
        .findByProps({ testID: 'transcript-scrubber' })
        .props.onLayout({ nativeEvent: { layout: { height: RAIL } } }),
    );
    act(() => store.observeScroll(scrollEvent()));
    const grab = () => renderer.root.findByProps({ testID: 'transcript-scrubber-grab' });
    return { list, grab, landOlderPage };
  }

  it('loads page after page while the reader holds the bar at the top', () => {
    const { list, grab, landOlderPage } = mountRoom();
    act(() => grab().props.onPanResponderGrant({ nativeEvent: {} }));
    act(() => grab().props.onPanResponderMove({}, { dy: -RAIL }));
    expect(list).toMatchObject({ offset: 5_000, loads: 1 });
    act(landOlderPage);
    expect(list).toMatchObject({ contentHeight: 8_600, offset: 8_000, loads: 2 });
    act(landOlderPage);
    expect(list).toMatchObject({ contentHeight: 11_600, offset: 11_000, loads: 3 });
  });

  it('scrubs into the older rows after they load', () => {
    const { list, grab, landOlderPage } = mountRoom();
    act(() => grab().props.onPanResponderGrant({ nativeEvent: {} }));
    act(() => grab().props.onPanResponderMove({}, { dy: -RAIL }));
    act(() => grab().props.onPanResponderRelease());
    act(landOlderPage);
    // Released before the page landed: the list stays where the reader left it.
    expect(list).toMatchObject({ contentHeight: 8_600, offset: 5_000, loads: 1 });
    // Grab again and drag up: the list follows into the new rows.
    act(() => grab().props.onPanResponderGrant({ nativeEvent: {} }));
    act(() => grab().props.onPanResponderMove({}, { dy: -RAIL }));
    expect(list).toMatchObject({ offset: 8_000, loads: 2 });
  });

  it('feeds the transcript list size into the bar', () => {
    const surface = readFileSync(
      resolve(__dirname, '../../app/(app)/beeline/chat/ChatSurfaceTranscript.tsx'),
      'utf8',
    );
    expect(readFileSync(resolve(__dirname, '../../app/(app)/beeline/chat/useChatRoomPresentation.tsx'), 'utf8')).toContain('positions: transcriptPositions,');
    expect(surface).toContain('transcriptPositions.observeScroll(');
    expect(surface).toContain('scrollController.isUserDragging() || scrollController.isLanding()');
    expect(surface).toContain('transcriptPositions.observeContentSize(height);');
    expect(surface).toContain('positions={transcriptPositions}');
    expect(surface).toContain('loadOlder={loadOlderTranscriptMessages}');
    expect(surface).toContain('scrollController={scrollController}');
  });
});

/**
 * The bar over the real Room message store: it reads the store's
 * `positions` and pages older history through the store's `loadOlder`.
 */
describe('TranscriptScrubber on the Room message store', () => {
  const roomMessage = (id: string, createdAt: number): RoomViewMessage => ({
    id: id.repeat(64),
    createdAt,
    text: `message-${id}`,
    presentation: 'message',
    author: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Owner' },
  });

  function Room({
    roomId,
    history,
    onStore,
    toOffset,
  }: {
    roomId: string;
    history: (
      roomId: string,
      before?: { createdAt: number; id: string },
    ) => Promise<RoomHistoryView>;
    onStore: (store: ReturnType<typeof useRoomMessageStore>) => void;
    toOffset: (offset: number) => void;
  }) {
    const store = useRoomMessageStore({
      roomId,
      tailMessages: [roomMessage('b', 2), roomMessage('c', 3)],
      roomClient: { history },
      enabled: true,
      initialVisibleCount: 2,
    });
    onStore(store);
    const [controller] = React.useState(() => controllerOver(toOffset));
    return (
      <TranscriptScrubber
        positions={store.positions}
        loadOlder={() => store.loadOlder(2)}
        scrollController={controller}
      />
    );
  }

  it('reads positions and pages history through the store, and starts fresh in the next Room', async () => {
    const history = vi.fn(() => new Promise<RoomHistoryView>(() => {}));
    const toOffset = vi.fn();
    let store!: ReturnType<typeof useRoomMessageStore>;
    let renderer!: ReactTestRenderer;
    const element = (roomId: string) => (
      <Room
        roomId={roomId}
        history={history}
        toOffset={toOffset}
        onStore={(value) => (store = value)}
      />
    );
    act(() => {
      renderer = create(element('room-a'));
    });
    act(() =>
      renderer.root
        .findByProps({ testID: 'transcript-scrubber' })
        .props.onLayout({ nativeEvent: { layout: { height: RAIL } } }),
    );
    // The list reports where it is to the store; the bar draws from it.
    act(() => store.positions.observeScroll(scroll(0, 5_600)));
    const grab = () => renderer.root.findByProps({ testID: 'transcript-scrubber-grab' });
    act(() => grab().props.onPanResponderGrant({ nativeEvent: {} }));
    act(() => grab().props.onPanResponderMove({}, { dy: -RAIL }));
    act(() => grab().props.onPanResponderRelease());
    expect(toOffset).toHaveBeenLastCalledWith(5_000);
    expect(history).toHaveBeenCalledExactlyOnceWith('room-a', { createdAt: 2, id: 'b'.repeat(64) });

    // Another Room: the store forgets the last Room's positions, so no bar.
    act(() => renderer.update(element('room-b')));
    expect(store.positions.getSnapshot().metrics).toBeNull();
    expect(renderer.root.findAllByProps({ testID: 'transcript-scrubber-grab' })).toHaveLength(0);
    renderer.unmount();
  });
});

import * as Haptics from 'expo-haptics';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { PanResponder } from 'react-native';
import { YStack } from 'tamagui';
import { T } from '@/ui/grammar';
import type {
  TranscriptScrollController,
  TranscriptScrollRow,
} from '@/buzz/transcript-scroll-controller';
import {
  scrubOffset,
  scrubReachesOldest,
  type TranscriptScrollMetrics,
} from '@/buzz/transcript-scrubber';
import type { RoomMessagePositions } from '@/buzz/room-message-store';

/** The thumb's touch target, wider and taller than the bar it holds. */
export const SCRUBBER_STRIP_WIDTH = 44;
const BAR_HEIGHT = 36;
const GRAB_HEIGHT = 64;
const BAR_WIDTH = 3;
const HANDLE_WIDTH = 6;

/**
 * The transcript's own scroll bar. It shows while the list scrolls, placed by
 * the list's offset over the rows the phone has loaded. Grab it and drag: the
 * list scrolls with the finger, and a bubble names the day on screen. Only the
 * thumb takes touches; the rest of the right edge belongs to the list.
 *
 * The bar reads where the list is from the Room message store's `positions`
 * and asks the store for older rows when a scrub reaches the oldest loaded
 * ones. The scroll controller moves the list; the bar only requests an offset.
 */
export function TranscriptScrubber({
  positions,
  loadOlder,
  scrollController,
}: {
  /** The Room message store's `positions`. */
  positions: RoomMessagePositions;
  /** The Room message store's older page. */
  loadOlder: () => void;
  scrollController: Pick<TranscriptScrollController<TranscriptScrollRow>, 'request'>;
}) {
  const { metrics, position: listPosition, date, visible } = useSyncExternalStore(
    positions.subscribe,
    positions.getSnapshot,
  );
  const [railHeight, setRailHeight] = useState(0);
  // The thumb follows the finger while dragging, not the list's echo.
  const [dragPosition, setDragPosition] = useState<number | null>(null);
  const position = dragPosition ?? listPosition;
  const live = useRef({ position, dragPosition, railHeight, scrollController, loadOlder });
  live.current = { position, dragPosition, railHeight, scrollController, loadOlder };
  const grabbedAt = useRef(0);

  const scrubTo = useCallback((metrics: TranscriptScrollMetrics, next: number) => {
    const offset = scrubOffset(metrics, next);
    live.current.scrollController.request({ kind: 'offset', offset });
    if (scrubReachesOldest(metrics, offset)) live.current.loadOlder();
  }, []);

  // Older rows that load under a finger held at the top change the list's
  // size, not its offset. Re-aim the list at the new oldest row and ask for
  // the next page. Held anywhere else, the list stays put: rows measuring,
  // a new message or the keyboard must not move it under a still finger.
  const contentHeight = metrics?.contentHeight;
  const viewportHeight = metrics?.viewportHeight;
  useEffect(() => {
    const held = live.current.dragPosition;
    const current = positions.getSnapshot().metrics;
    if (held === null || held < 1 || !current) return;
    scrubTo(current, held);
  }, [contentHeight, viewportHeight, positions, scrubTo]);

  const pan = useMemo(() => {
    const finish = () => {
      const held = live.current.dragPosition;
      setDragPosition(null);
      // Native echoes can arrive after release. Keep the finger's destination
      // while idle anchor corrections continue updating the scroll metrics.
      positions.reveal(held ?? undefined);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        grabbedAt.current = live.current.position ?? 0;
        setDragPosition(grabbedAt.current);
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      },
      onPanResponderMove: (_event, state) => {
        const track = live.current.railHeight - BAR_HEIGHT;
        const current = positions.getSnapshot().metrics;
        if (track <= 0 || !current) return;
        // Up the screen is older: position grows as dy goes negative.
        const next = Math.min(1, Math.max(0, grabbedAt.current - state.dy / track));
        setDragPosition(next);
        scrubTo(current, next);
      },
      onPanResponderRelease: finish,
      onPanResponderTerminate: finish,
    });
  }, [positions, scrubTo]);

  const dragging = dragPosition !== null;
  const shown = position !== null && (visible || dragging);
  const top = position === null ? 0 : (1 - position) * Math.max(0, railHeight - BAR_HEIGHT);

  return (
    <YStack
      onLayout={(event) => setRailHeight(event.nativeEvent.layout.height)}
      pointerEvents="box-none"
      // The date bubble needs the transcript's width to size to its text.
      position="absolute"
      top={0}
      right={0}
      bottom={0}
      left={0}
      testID="transcript-scrubber"
    >
      {shown && (
        <YStack
          position="absolute"
          right={0}
          top={top - (GRAB_HEIGHT - BAR_HEIGHT) / 2}
          width={SCRUBBER_STRIP_WIDTH}
          height={GRAB_HEIGHT}
          justifyContent="center"
          alignItems="flex-end"
          testID="transcript-scrubber-grab"
          {...(pan.panHandlers as object)}
        >
          {/* The bar keeps the centre line of the wider handle it becomes. */}
          <YStack pointerEvents="none" width={HANDLE_WIDTH} marginRight="1" alignItems="center">
            <YStack
              pointerEvents="none"
              width={dragging ? HANDLE_WIDTH : BAR_WIDTH}
              height={BAR_HEIGHT}
              borderRadius="full"
              backgroundColor={dragging ? 'needsYou' : 'secondary'}
              testID="transcript-scrubber-bar"
            />
          </YStack>
        </YStack>
      )}
      {shown && dragging && date && (
        <YStack
          pointerEvents="none"
          position="absolute"
          top={top}
          right={SCRUBBER_STRIP_WIDTH}
          padding="2"
          borderWidth={1}
          borderColor="strongStroke"
          borderRadius="sm"
          backgroundColor="canvas"
          testID="transcript-scrubber-bubble"
        >
          <T v="metaStrong" color="needsYou">{date}</T>
        </YStack>
      )}
    </YStack>
  );
}

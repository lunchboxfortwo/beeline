import React, { forwardRef, useCallback, useImperativeHandle, useMemo } from 'react';
import { I18nManager } from 'react-native';
import { XStack, YStack } from 'tamagui';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Motion } from '@/ui/grammar';
import {
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
  withSpring,
} from 'react-native-reanimated';

export type TranscriptSwipeableMethods = { close(): void };
type Direction = 'left' | 'right';
type Props = {
  children: React.ReactNode;
  dragOffsetFromRightEdge?: number;
  friction?: number;
  enabled?: boolean;
  actionsVisible?: boolean;
  onSwipeableWillOpen?(direction: Direction): void;
  onSwipeableClose?(direction: Direction): void;
  onSwipeableOpenStartDrag?(): void;
  renderLeftActions?(): React.ReactNode;
  renderRightActions?(): React.ReactNode;
  testID?: string;
};

/** Transcript swipes commit one action and immediately return. They never
 * retain an open drawer, so they need neither a second tap recognizer nor
 * per-row drawer measurements/progress/retained-open animation state. */
const TranscriptSwipeable = forwardRef<TranscriptSwipeableMethods, Props>(
  function TranscriptSwipeable(
    {
      children,
      dragOffsetFromRightEdge = 18,
      friction = 1.35,
      enabled = true,
      actionsVisible = true,
      onSwipeableWillOpen,
      onSwipeableClose,
      onSwipeableOpenStartDrag,
      renderLeftActions,
      renderRightActions,
      testID,
    },
    ref,
  ) {
    const offset = useSharedValue(0);
    const left = Boolean(renderLeftActions);
    const right = Boolean(renderRightActions);
    const close = useCallback(() => {
      'worklet';
      const direction: Direction = offset.value < 0 ? 'right' : 'left';
      offset.value = withSpring(
        0,
        {
          mass: 2,
          damping: 1000,
          stiffness: 700,
          overshootClamping: true,
          reduceMotion: ReduceMotion.System,
        },
        (finished) => {
          if (finished && onSwipeableClose) runOnJS(onSwipeableClose)(direction);
        },
      );
    }, [offset, onSwipeableClose]);
    useImperativeHandle(ref, () => ({ close }), [close]);
    const pan = useMemo(
      () =>
        Gesture.Pan()
          .enabled(enabled && (left || right))
          .activeOffsetX([-dragOffsetFromRightEdge, 10])
          .onStart(() => {
            if (onSwipeableOpenStartDrag) runOnJS(onSwipeableOpenStartDrag)();
          })
          .onUpdate((event) => {
            offset.value = Math.max(
              right ? -ACTION_WIDTH : 0,
              Math.min(left ? ACTION_WIDTH : 0, event.translationX / friction),
            );
          })
          .onEnd((event) => {
            // Match Swipeable's half-panel threshold and velocity projection.
            const projected = (event.translationX + 0.05 * event.velocityX) / friction;
            if (
              onSwipeableWillOpen &&
              ((left && projected > ACTION_WIDTH / 2) || (right && projected < -ACTION_WIDTH / 2))
            ) {
              runOnJS(onSwipeableWillOpen)(projected > 0 ? 'right' : 'left');
            }
          })
          // Cancellation by a scroll, interrupted touch, and committed actions all
          // return on the UI thread. No JS timer can strand a translated message.
          .onFinalize(close),
      [
        close,
        dragOffsetFromRightEdge,
        enabled,
        friction,
        left,
        offset,
        onSwipeableOpenStartDrag,
        onSwipeableWillOpen,
        right,
      ],
    );
    const contentStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));
    return (
      <YStack testID={testID}>
        <GestureDetector gesture={pan} touchAction="pan-y">
          <YStack overflow="hidden">
            {actionsVisible ? <SwipePanels offset={offset} renderLeftActions={renderLeftActions} renderRightActions={renderRightActions} /> : null}
            <Motion motion={contentStyle}>{children}</Motion>
          </YStack>
        </GestureDetector>
      </YStack>
    );
  },
);


/** The resting row has no action layers to style or animate. */
function SwipePanels({ offset, renderLeftActions, renderRightActions }: {
  offset: SharedValue<number>;
  renderLeftActions?: () => React.ReactNode;
  renderRightActions?: () => React.ReactNode;
}) {
  const leftStyle = useAnimatedStyle(() => ({ opacity: offset.value > 0 ? 1 : 0 }));
  const rightStyle = useAnimatedStyle(() => ({ opacity: offset.value < 0 ? 1 : 0 }));
  return <>
    {renderLeftActions ? <Motion overlay motion={leftStyle}>
      <XStack flex={1} overflow="hidden" flexDirection={I18nManager.isRTL ? 'row-reverse' : 'row'}>
        {renderLeftActions()}
      </XStack>
    </Motion> : null}
    {renderRightActions ? <Motion overlay motion={rightStyle}>
      <XStack flex={1} overflow="hidden" flexDirection={I18nManager.isRTL ? 'row' : 'row-reverse'}>
        {renderRightActions()}
      </XStack>
    </Motion> : null}
  </>;
}

const ACTION_WIDTH = 78;

export default TranscriptSwipeable;

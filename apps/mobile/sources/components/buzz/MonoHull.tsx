import React, { useEffect, useRef, useState } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { XStack, YStack, type YStackProps } from 'tamagui';
import {
  Easing,
  FadeInDown,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { hasMessageRevealed, markMessageRevealed } from '@/buzz/message-reveal';
import { Motion, T } from '@/ui/grammar';

export const motionTokens = {
  confirm: 240,
  loaderFrame: 133,
  liveCycle: 1120,
  /**
   * How long a settled row takes to dip and come back when it demotes out of
   * its live form. Measured against grok Build: its rollup row swaps from the
   * present participle to the past tense in 52-104ms, which on a terminal is a
   * single repaint and reads as instantaneous. A silent substitution at that
   * speed is invisible on a phone — the eye is elsewhere — so the swap is given
   * a dip the eye can catch, then restored on the shared reveal easing.
   */
  demoteDip: 90,
} as const;

const easeOutQuint = Easing.out(Easing.poly(5));

// Built once and cached so `entering` keeps one stable reference across
// re-renders: a new builder instance here would read as a new animation to
// Reanimated and restart the entrance mid-flight whenever a sibling
// re-render touches this row (presence tick, roster update). Built lazily,
// on first use, rather than at module scope, so importing this file never
// requires a full FadeInDown mock from callers that don't render this
// component.
let newMessageEntering: ReturnType<typeof buildNewMessageEntering> | undefined;
function buildNewMessageEntering() {
  return FadeInDown.duration(140)
    .easing(easeOutQuint)
    .reduceMotion(ReduceMotion.System)
    .withInitialValues({ opacity: 0, transform: [{ translateY: 3 }] });
}
function getNewMessageEntering() {
  return (newMessageEntering ??= buildNewMessageEntering());
}

type HullSurfaceProps = YStackProps & {
  children?: React.ReactNode;
  strength?: 'quiet' | 'raised' | 'code';
  testID?: string;
};

const SCRATCHES = [7, 15, 24, 31, 40, 48, 57, 66, 74, 83, 91];
/** A hairline rule: half a point, one device pixel on a 2x screen. */
const HAIRLINE = 0.5;

export function HullSurface({ children, strength = 'quiet', testID, ...props }: HullSurfaceProps) {
  return (
    <YStack position="relative" overflow="hidden" {...props} testID={testID}>
      <YStack pointerEvents="none" position="absolute" top={0} right={0} bottom={0} left={0}>
        {SCRATCHES.map((top, index) => (
          <YStack
            key={top}
            position="absolute"
            height={HAIRLINE}
            backgroundColor="strongStroke"
            opacity={0.03}
            left={`${(index * 17) % 31}%`}
            right={`${(index * 11) % 27}%`}
            top={`${top}%`}
          />
        ))}
        {strength !== 'quiet' && (
          <>
            <YStack position="absolute" width={1} height={2} backgroundColor="secondary" opacity={0.025} left="13%" top="27%" />
            <YStack position="absolute" width={1} height={2} backgroundColor="secondary" opacity={0.025} right="19%" top="64%" />
            <YStack position="absolute" top={0} right={0} left={0} height={HAIRLINE} backgroundColor="secondary" opacity={0.03} />
          </>
        )}
        {strength === 'code' && (
          <>
            <YStack position="absolute" width={8} height={2} backgroundColor="strongStroke" opacity={0.7} top={0} left={0} />
            <YStack position="absolute" width={8} height={2} backgroundColor="strongStroke" opacity={0.7} right={0} bottom={0} />
          </>
        )}
      </YStack>
      {children}
    </YStack>
  );
}

export function PixelLoader({ compact = false }: { compact?: boolean }) {
  const reducedMotion = useReducedMotion();
  const frame = useSharedValue(0);

  useEffect(() => {
    if (reducedMotion) return;
    frame.value = withRepeat(
      withTiming(4, {
        duration: motionTokens.loaderFrame * 4,
        easing: Easing.linear,
        reduceMotion: ReduceMotion.System,
      }),
      -1,
      false,
    );
  }, [frame, reducedMotion]);

  return (
    <XStack
      accessibilityLabel="Loading"
      accessibilityRole="progressbar"
      width={compact ? 32 : 42}
      height={compact ? 10 : 14}
      alignItems="center"
      gap="1"
    >
      {reducedMotion ? (
        <T v="code" color="ink">◇</T>
      ) : (
        [0, 1, 2, 3].map((index) => (
          <LoaderCell key={index} frame={frame} index={index} compact={compact} />
        ))
      )}
    </XStack>
  );
}

function LoaderCell({
  frame,
  index,
  compact,
}: {
  frame: SharedValue<number>;
  index: number;
  compact: boolean;
}) {
  const style = useAnimatedStyle(() => {
    const active = Math.floor(frame.value) % 4 === index;
    return { opacity: active ? 1 : 0.28 };
  });
  return (
    <Motion motion={style}>
      <YStack width={compact ? 5 : 7} height={compact ? 5 : 7} backgroundColor="ink" />
    </Motion>
  );
}

/**
 * The one continuous loop the app runs while it is on screen and unattended:
 * a linear 0→1 cycle other live primitives read a phase off. Kept here so
 * every "something is alive" signal in the product breathes on the same clock
 * and stops on the same conditions — reduced motion, or the app backgrounded.
 */
function useLiveCycle(active: boolean): { progress: SharedValue<number>; still: boolean } {
  const reducedMotion = useReducedMotion();
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const progress = useSharedValue(0);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      setAppActive(state === 'active');
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!active || !appActive || reducedMotion) {
      progress.value = 0;
      return;
    }
    progress.value = withRepeat(
      withTiming(1, {
        duration: motionTokens.liveCycle,
        easing: Easing.linear,
        reduceMotion: ReduceMotion.System,
      }),
      -1,
      false,
    );
  }, [active, appActive, progress, reducedMotion]);

  return { progress, still: Boolean(reducedMotion || !active) };
}

/** The dimmest the live pulse ever goes. High enough that the mark it carries
 * stays legible at every point in the cycle — a breath, not a blink. */
const LIVE_PULSE_FLOOR = 0.55;

/**
 * One slow sin² breath on whatever it wraps, on the live-cycle clock. It
 * exists so a dense index row can carry the "an agent is alive here" signal
 * at the size of one glyph.
 *
 * Motion is the redundant channel here, never the only one: what it wraps is
 * already the filled brass needs-you circle.
 * With reduced motion on, or the app backgrounded, it simply holds still.
 */
export function HullLivePulse({
  active = true,
  children,
}: {
  active?: boolean;
  children: React.ReactNode;
}) {
  const { progress, still } = useLiveCycle(active);
  const pulse = useAnimatedStyle(() => {
    if (still) return { opacity: 1 };
    return {
      opacity: LIVE_PULSE_FLOOR + (1 - LIVE_PULSE_FLOOR) * Math.sin(progress.value * Math.PI) ** 2,
    };
  });
  return <Motion motion={pulse}>{children}</Motion>;
}

export function NewMessageMaterialize({
  children,
  enabled = true,
  messageId,
}: {
  children: React.ReactNode;
  enabled?: boolean;
  /** Stable message id. The entrance plays at most once per id per app
   *  session — never again on re-render, scroll-back remount, or Room re-entry.
   */
  messageId?: string;
}) {
  // Decided ONCE per mounted instance: a re-render while the entrance is
  // playing (presence tick, roster update) must not flip the wrapper and cut
  // the animation short. Cross-instance replay (FlatList recycling the row,
  // navigating back into the Room) is closed by the session reveal registry.
  const animateRef = useRef<boolean | null>(null);
  if (animateRef.current === null) {
    // Reanimated's web entering layout can leave a message wrapper absolutely
    // positioned after reconciliation, collapsing its transcript row.
    animateRef.current =
      Platform.OS !== 'web' && enabled && (messageId === undefined || !hasMessageRevealed(messageId));
  }
  const animate = animateRef.current;
  // Mark after commit, not during render: a render that React discards must
  // not spend the message's one entrance.
  useEffect(() => {
    if (animate && messageId !== undefined) markMessageRevealed(messageId);
  }, [animate, messageId]);
  if (!animate) return <YStack>{children}</YStack>;
  return <Motion entering={getNewMessageEntering()}>{children}</Motion>;
}

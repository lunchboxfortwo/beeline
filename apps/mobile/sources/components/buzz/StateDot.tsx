import React, { useEffect } from 'react';
import { YStack } from 'tamagui';
import { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { Motion } from '@/ui/grammar';

/**
 * StateDot — the ONE instrument dot (board revision 2's `.gind`): an 8px
 * circle beside a state word that makes the state scannable down a list.
 * The word is the signal; the dot is never the only carrier:
 *
 *   - `'live'`    filled with the theme's success token — a settled, good state;
 *   - `'pulse'`   filled brass, gently pulsing — work in flight;
 *   - `'failed'`  filled with the dialog-danger token — a broken state.
 *
 * The pulse honors reduced motion the way `PulsingText` does: a still,
 * fully visible dot is the fallback.
 */
export type StateDotKind = 'live' | 'pulse' | 'failed';

function Dot({ kind, testID }: { kind: StateDotKind; testID?: string }) {
  return (
    <YStack
      width={8}
      height={8}
      borderRadius="full"
      flexShrink={0}
      backgroundColor={kind === 'live' ? 'added' : kind === 'pulse' ? 'needsYou' : 'removed'}
      testID={testID}
    />
  );
}

export function StateDot({ kind, testID }: { kind: StateDotKind; testID?: string }) {
  if (kind !== 'pulse') return <Dot kind={kind} testID={testID ? `${testID}-${kind}` : undefined} />;
  return <PulsingDot testID={testID ? `${testID}-pulse` : undefined} />;
}

function PulsingDot({ testID }: { testID?: string }) {
  const pulse = useSharedValue(1);

  useEffect(() => {
    pulse.value = withRepeat(withSequence(withTiming(0.35, { duration: 700 }), withTiming(1, { duration: 700 })), -1);
  }, [pulse]);

  const motion = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return <Motion motion={motion} testID={testID}><Dot kind="pulse" /></Motion>;
}

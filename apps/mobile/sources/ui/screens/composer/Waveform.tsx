import React from 'react';
import { getTokens, XStack, YStack } from 'tamagui';
import Animated, { useAnimatedStyle, useFrameCallback, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { advanceWaveform, initialWaveformMotion, waveformOffset, WAVEFORM_BARS, type WaveformMotion } from './waveform-motion';

/** More bars than the widest field holds; the oldest clip off the left edge. */
export { WAVEFORM_BARS } from './waveform-motion';
const BAR_MIN = 2;
const BAR_RANGE = 16;
const FIELD_HEIGHT = 26;

const AnimatedBar = Animated.createAnimatedComponent(YStack);

function WaveformBar({ index, motion, live, pitch }: { index: number; motion: SharedValue<WaveformMotion>; live: boolean; pitch: number }) {
    const style = useAnimatedStyle(() => {
        const height = motion.value.heights[index] ?? BAR_MIN;
        return {
            height,
            top: '50%',
            opacity: index < motion.value.heights.length ? 1 : 0,
            transform: [
                { translateX: waveformOffset(motion.value.phase, pitch) - (motion.value.heights.length - 1 - index) * pitch },
                { translateY: -height / 2 },
            ],
        };
    });
    return <AnimatedBar position="absolute" right={0} width={2} flexShrink={0} borderRadius="full"
        backgroundColor={live ? 'needsYou' : 'secondary'} style={style} />;
}

/** One bar's height for a level from 0 (silence) to 1 (loudest). */
export function barHeight(level: number): number {
    return BAR_MIN + Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0)) * BAR_RANGE;
}

/**
 * The speaking waveform (dictation and conversation mode): animation frames move
 * the history left at a steady speed; microphone readings only set the newest
 * bar's target height. Brass while it listens; frozen, it keeps its
 * last shape in secondary ink while the take is transcribed or the mic is muted.
 */
export function Waveform({ level, live, testID = 'waveform' }: { level: number; live: boolean; testID?: string }) {
    const motion = useSharedValue(initialWaveformMotion());
    const target = useSharedValue(barHeight(level));
    const listening = useSharedValue(live);
    const pitch = 2 + getTokens().space['1'].val;
    const animate = React.useCallback(({ timeSincePreviousFrame }: { timeSincePreviousFrame: number | null }) => {
        'worklet';
        if (!listening.value) return;
        motion.value = advanceWaveform(motion.value, timeSincePreviousFrame ?? 0, target.value);
    }, [listening, motion, target]);
    const frame = useFrameCallback(animate, false);
    React.useEffect(() => {
        if (live) target.value = barHeight(level);
    }, [level, live, target]);
    React.useEffect(() => {
        listening.value = live;
        frame.setActive(live);
        return () => { listening.value = false; frame.setActive(false); };
    }, [frame, listening, live]);
    return (
        <XStack flex={1} minWidth={0} height={FIELD_HEIGHT} alignItems="center" justifyContent="flex-end" gap="1" overflow="hidden"
            pointerEvents="none" aria-hidden testID={testID}>
            {Array.from({ length: WAVEFORM_BARS }, (_, index) => (
                <WaveformBar key={index} index={index} motion={motion} live={live} pitch={pitch} />
            ))}
        </XStack>
    );
}

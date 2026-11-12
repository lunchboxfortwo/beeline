import React from 'react';
import { XStack, YStack } from 'tamagui';

/** More bars than the widest field holds; the oldest clip off the left edge. */
export const WAVEFORM_BARS = 64;
const BAR_MIN = 2;
const BAR_RANGE = 16;
const FIELD_HEIGHT = 26;

type Bar = { key: number; height: number };

/** One bar's height for a level from 0 (silence) to 1 (loudest). */
export function barHeight(level: number): number {
    return BAR_MIN + Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0)) * BAR_RANGE;
}

/**
 * The speaking waveform (dictation and conversation mode): each level the
 * microphone reports adds one bar at the right edge, as tall as the voice was
 * loud, and the line moves left. Brass while it listens; frozen, it keeps its
 * last shape in secondary ink while the take is transcribed or the mic is muted.
 */
export function Waveform({ level, live, testID = 'waveform' }: { level: number; live: boolean; testID?: string }) {
    const [bars, setBars] = React.useState<readonly Bar[]>([]);
    const next = React.useRef(0);
    React.useEffect(() => {
        if (!live) return;
        const key = next.current++;
        setBars((current) => [...current, { key, height: barHeight(level) }].slice(-WAVEFORM_BARS));
    }, [level, live]);
    return (
        <XStack flex={1} minWidth={0} height={FIELD_HEIGHT} alignItems="center" justifyContent="flex-end" gap="1" overflow="hidden"
            pointerEvents="none" aria-hidden testID={testID}>
            {bars.map((bar) => (
                <YStack key={bar.key} width={2} height={bar.height} flexShrink={0} borderRadius="full" backgroundColor={live ? 'needsYou' : 'secondary'} />
            ))}
        </XStack>
    );
}

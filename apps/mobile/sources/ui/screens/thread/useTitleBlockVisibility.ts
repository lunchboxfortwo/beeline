import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, type View } from 'react-native';

type Measurable = { measureInWindow?(callback: (x: number, y: number, width: number, height: number) => void): void };

/** The phone transcript's position store: an inverted list, so offset 0 is the newest message. */
type TranscriptPositions = {
    subscribe(listener: () => void): () => void;
    getSnapshot(): { metrics: { offset: number } | null; position: number | null };
};

/**
 * Whether the full header shows after the reader moved from `from` to `to`,
 * both coordinates increasing toward older messages. A move toward older messages
 * shows it; a move toward newer messages hides it. Ignore rounding noise.
 */
export function headerRevealAfterScroll(revealed: boolean, from: number | null, to: number): boolean {
    if (from !== null && Math.abs(to - from) > 1) return to > from;
    return revealed;
}

/**
 * Whether a thread's title block has scrolled away under its bar (header B),
 * and whether the full header shows under the bar while it is away: the
 * block's window frame is compared with the bar's bottom edge on layout and
 * on every transcript scroll. Phone scrolls arrive through the transcript's
 * position store; web (and the desktop transcript) scrolls are caught at the
 * window in the capture phase. No timer, no polling.
 */
export function useTitleBlockVisibility(enabled: boolean, positions?: TranscriptPositions) {
    const blockRef = useRef<View | null>(null);
    const barRef = useRef<View | null>(null);
    const barBottom = useRef(0);
    const lastDistance = useRef<number | null>(null);
    const lastPosition = useRef<number | null>(null);
    const [collapsed, setCollapsed] = useState(false);
    const [revealed, setRevealed] = useState(false);
    const collapsedRef = useRef(false);
    const revealedRef = useRef(false);

    // Scroll frames update refs; React only sees an actual visibility change.
    const reveal = useCallback((shown: boolean) => {
        if (shown === revealedRef.current) return;
        revealedRef.current = shown;
        setRevealed(shown);
    }, []);

    const measure = useCallback(() => {
        if (!enabled) return;
        const block = blockRef.current as unknown as Measurable | null;
        block?.measureInWindow?.((_x, y, _width, height) => {
            if (!Number.isFinite(y) || !Number.isFinite(height)) return;
            const away = y + height <= barBottom.current;
            if (away !== collapsedRef.current) {
                collapsedRef.current = away;
                setCollapsed(away);
            }
            // Back in view, the block is the header again until the next scroll up.
            if (!away) reveal(false);
        });
    }, [enabled, reveal]);

    const onBarLayout = useCallback(() => {
        const bar = barRef.current as unknown as Measurable | null;
        bar?.measureInWindow?.((_x, y, _width, height) => {
            if (Number.isFinite(y) && Number.isFinite(height)) barBottom.current = y + height;
            measure();
        });
    }, [measure]);

    const observeDistance = useCallback((distance: number) => {
        const from = lastDistance.current;
        lastDistance.current = distance;
        reveal(collapsedRef.current && headerRevealAfterScroll(revealedRef.current, from, distance));
    }, [reveal]);

    useEffect(() => {
        if (!enabled) return;
        const stops: (() => void)[] = [];
        if (positions) {
            stops.push(positions.subscribe(() => {
                measure();
                const { metrics, position } = positions.getSnapshot();
                if (!metrics) return;
                // Only the reader's own scroll moves `position`; native anchoring
                // moves the offset alone, and must not read as a scroll up.
                if (position === lastPosition.current) {
                    lastDistance.current = metrics.offset;
                    return;
                }
                lastPosition.current = position;
                observeDistance(metrics.offset);
            }));
        }
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
            const onWindowScroll = (event: Event) => {
                measure();
                // The desktop transcript is a plain scroll view with the newest
                // message at its foot; it does not feed the position store.
                const node = event.target as HTMLElement | null;
                if (!positions?.getSnapshot().metrics && node?.getAttribute?.('data-testid') === 'chat-messages')
                    // Only the offset carries direction. Revealing the header
                    // resizes the viewport; history arrivals change content height.
                    observeDistance(-node.scrollTop);
            };
            window.addEventListener('scroll', onWindowScroll, true);
            stops.push(() => window.removeEventListener('scroll', onWindowScroll, true));
        }
        return () => stops.forEach((stop) => stop());
    }, [enabled, measure, observeDistance, positions]);

    const expand = useCallback(() => reveal(true), [reveal]);

    return {
        blockRef, barRef, onBlockLayout: measure, onBarLayout, expand,
        collapsed: enabled && collapsed,
        /** The full header shows under the bar: the block is away and the reader asked for it. */
        expanded: enabled && collapsed && revealed,
    };
}

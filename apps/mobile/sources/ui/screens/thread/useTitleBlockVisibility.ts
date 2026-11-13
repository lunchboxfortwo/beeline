import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, type View } from 'react-native';

type Measurable = { measureInWindow?(callback: (x: number, y: number, width: number, height: number) => void): void };

/** The phone transcript's position store: an inverted list, so offset 0 is the newest message. */
type TranscriptPositions = {
    subscribe(listener: () => void): () => void;
    getSnapshot(): { metrics: { offset: number } | null; position: number | null };
};

/** Within this distance of the newest message, the reader is at the end of the transcript. */
export const NEWEST_MESSAGE_SLOP = 50;

/**
 * Whether the full header shows after the reader moved from `from` to `to`,
 * both distances from the newest message. A move toward older messages
 * shows it; reaching the newest message hides it; any other move keeps it.
 */
export function headerRevealAfterScroll(revealed: boolean, from: number | null, to: number): boolean {
    if (to <= NEWEST_MESSAGE_SLOP) return false;
    if (from !== null && to - from > 1) return true;
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

    const measure = useCallback(() => {
        if (!enabled) return;
        const block = blockRef.current as unknown as Measurable | null;
        block?.measureInWindow?.((_x, y, _width, height) => {
            if (!Number.isFinite(y) || !Number.isFinite(height)) return;
            const away = y + height <= barBottom.current;
            setCollapsed(away);
            // Back in view, the block is the header again until the next scroll up.
            if (!away) setRevealed(false);
        });
    }, [enabled]);

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
        setRevealed((shown) => headerRevealAfterScroll(shown, from, distance));
    }, []);

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
                    observeDistance(node.scrollHeight - node.scrollTop - node.clientHeight);
            };
            window.addEventListener('scroll', onWindowScroll, true);
            stops.push(() => window.removeEventListener('scroll', onWindowScroll, true));
        }
        return () => stops.forEach((stop) => stop());
    }, [enabled, measure, observeDistance, positions]);

    const expand = useCallback(() => setRevealed(true), []);

    return {
        blockRef, barRef, onBlockLayout: measure, onBarLayout, expand,
        collapsed: enabled && collapsed,
        /** The full header shows under the bar: the block is away and the reader asked for it. */
        expanded: enabled && collapsed && revealed,
    };
}

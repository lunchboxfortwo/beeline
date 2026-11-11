import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, type View } from 'react-native';

type Measurable = { measureInWindow?(callback: (x: number, y: number, width: number, height: number) => void): void };

/**
 * Whether a thread's title block has scrolled away under its bar (header B):
 * the block's window frame is compared with the bar's bottom edge on layout
 * and on every transcript scroll. Phone scrolls arrive through the
 * transcript's position store; web (and the desktop transcript) scrolls are
 * caught at the window in the capture phase. No timer, no polling.
 */
export function useTitleBlockVisibility(enabled: boolean, positions?: { subscribe(listener: () => void): () => void }) {
    const blockRef = useRef<View | null>(null);
    const barRef = useRef<View | null>(null);
    const barBottom = useRef(0);
    const [collapsed, setCollapsed] = useState(false);

    const measure = useCallback(() => {
        if (!enabled) return;
        const block = blockRef.current as unknown as Measurable | null;
        block?.measureInWindow?.((_x, y, _width, height) => {
            if (Number.isFinite(y) && Number.isFinite(height)) setCollapsed(y + height <= barBottom.current);
        });
    }, [enabled]);

    const onBarLayout = useCallback(() => {
        const bar = barRef.current as unknown as Measurable | null;
        bar?.measureInWindow?.((_x, y, _width, height) => {
            if (Number.isFinite(y) && Number.isFinite(height)) barBottom.current = y + height;
            measure();
        });
    }, [measure]);

    useEffect(() => {
        if (!enabled) return;
        const stops: (() => void)[] = [];
        if (positions) stops.push(positions.subscribe(measure));
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
            window.addEventListener('scroll', measure, true);
            stops.push(() => window.removeEventListener('scroll', measure, true));
        }
        return () => stops.forEach((stop) => stop());
    }, [enabled, measure, positions]);

    return { blockRef, barRef, onBlockLayout: measure, onBarLayout, collapsed: enabled && collapsed };
}

import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const animation = vi.hoisted(() => ({ callback: null as null | ((frame: { timeSincePreviousFrame: number | null }) => void), active: false }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('react-native-reanimated', async () => {
    const React = await import('react');
    return {
        default: { createAnimatedComponent: (component: unknown) => component },
        useSharedValue: (value: unknown) => React.useRef({ value }).current,
        useAnimatedStyle: (factory: () => object) => new Proxy({}, { get: (_, key) => (factory() as any)[key] }),
        useFrameCallback: (callback: typeof animation.callback) => {
            animation.callback = callback;
            return React.useRef({ setActive: (active: boolean) => { animation.active = active; } }).current;
        },
    };
});
import { WAVEFORM_BARS, Waveform, barHeight } from './Waveform';
import { advanceWaveform, initialWaveformMotion, waveformOffset } from './waveform-motion';

let tree: any;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; animation.active = false; });
afterEach(() => { act(() => tree?.unmount()); tree = undefined; });
const bars = () => tree.root.findAll((node: any) => node.type === 'YStack' && node.props.width === 2);
const visible = () => bars().filter((bar: any) => bar.props.style.opacity === 1);
const tick = (elapsed: number | null) => act(() => { if (animation.active) animation.callback!({ timeSincePreviousFrame: elapsed }); });

it('scrolls between irregular readings and readings never move the history', () => {
    act(() => { tree = create(<Waveform level={0.2} live />); });
    tick(null);
    const x = () => visible()[0].props.style.transform[0].translateX;
    tick(16);
    expect(x()).toBeCloseTo(-1.2);
    const callback = animation.callback;
    act(() => tree.update(<Waveform level={0.9} live />));
    expect(animation.callback).toBe(callback);
    expect(x()).toBeCloseTo(-1.2);
    tick(9);
    expect(x()).toBeCloseTo(-1.875);
    act(() => tree.update(<Waveform level={0.1} live />));
    tick(55);
    expect(x()).toBeCloseTo(-6);
    tick(400);
    expect(x()).toBeCloseTo(-36);
    expect(visible()).toHaveLength(7);
});

it('eases heights toward the newest target without snapping on a reading', () => {
    act(() => { tree = create(<Waveform level={0} live />); });
    tick(null);
    act(() => tree.update(<Waveform level={1} live />));
    expect(visible()[0].props.style.height).toBe(barHeight(0));
    tick(16);
    const height = visible()[0].props.style.height;
    expect(height).toBeGreaterThan(barHeight(0));
    expect(height).toBeLessThan(barHeight(1));
    tick(16);
    expect(visible()[0].props.style.height).toBeGreaterThan(height);
});

it('freezes motion and heights in secondary ink while stopped, resumes without catch-up, and cleans up', () => {
    act(() => { tree = create(<Waveform level={0.8} live testID="take" />); });
    tick(41);
    const before = visible().map((bar: any) => [bar.props.style.height, bar.props.style.transform]);
    act(() => tree.update(<Waveform level={0} live={false} testID="take" />));
    expect(animation.active).toBe(false);
    tick(1000);
    // Also cover an already queued UI callback after deactivation.
    act(() => animation.callback!({ timeSincePreviousFrame: 1000 }));
    expect(visible().map((bar: any) => [bar.props.style.height, bar.props.style.transform])).toEqual(before);
    expect(bars().every((bar: any) => bar.props.backgroundColor === 'secondary')).toBe(true);
    expect(tree.root.findByProps({ testID: 'take' })).toBeDefined();
    act(() => tree.update(<Waveform level={0.4} live testID="take" />));
    tick(null);
    expect(visible().map((bar: any) => [bar.props.style.height, bar.props.style.transform])).toEqual(before);
    tick(16);
    expect(visible()[0].props.style.transform).not.toEqual(before[0][1]);
    act(() => tree.unmount());
    expect(animation.active).toBe(false);
});

it('retains the 64-bar limit and preserves positions across history rollover', () => {
    let motion = advanceWaveform(initialWaveformMotion(), 80 * WAVEFORM_BARS - 1, barHeight(1));
    expect(motion.heights).toHaveLength(WAVEFORM_BARS);
    const xBefore = waveformOffset(motion.phase, 6);
    const previousNewest = motion.heights.at(-1)!;
    motion = advanceWaveform(motion, 1, barHeight(1));
    expect(motion.heights).toHaveLength(WAVEFORM_BARS);
    expect(waveformOffset(motion.phase, 6) - 6 - xBefore).toBeCloseTo(-0.075);
    expect(motion.heights.at(-2)).toBeGreaterThan(previousNewest);
    expect(motion.heights.at(-1)).toBe(2);
});

it('produces the same motion and eased heights for equivalent elapsed time at different frame rates', () => {
    let fine = initialWaveformMotion();
    for (let index = 0; index < 100; index += 1) fine = advanceWaveform(fine, 10, 18);
    const coarse = advanceWaveform(initialWaveformMotion(), 1000, 18);
    expect(fine.phase).toBe(coarse.phase);
    fine.heights.forEach((height, index) => expect(height).toBeCloseTo(coarse.heights[index], 10));
});

it('clamps levels outside 0…1 and treats non-finite numbers as silence', () => {
    expect(barHeight(0)).toBe(2);
    expect(barHeight(1)).toBe(18);
    expect(barHeight(-1)).toBe(barHeight(0));
    expect(barHeight(3)).toBe(barHeight(1));
    expect(barHeight(Number.NaN)).toBe(barHeight(0));
    expect(barHeight(Infinity)).toBe(barHeight(0));
});

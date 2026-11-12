import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
import { WAVEFORM_BARS, Waveform, barHeight } from './Waveform';

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

const bars = (tree: any) => tree.root.findByProps({ testID: 'waveform' }).findAll((node: any) => node.type === 'YStack' && node.props.width === 2);

it('adds one brass bar per level, as tall as the voice was loud, newest last', () => {
    let tree: any;
    act(() => { tree = create(<Waveform level={0} live />); });
    act(() => tree.update(<Waveform level={1} live />));
    act(() => tree.update(<Waveform level={0.5} live />));
    expect(bars(tree).map((bar: any) => bar.props.height)).toEqual([barHeight(0), barHeight(1), barHeight(0.5)]);
    expect(bars(tree).every((bar: any) => bar.props.backgroundColor === 'needsYou')).toBe(true);
});

it('freezes in secondary ink and stops adding bars when it stops listening', () => {
    let tree: any;
    act(() => { tree = create(<Waveform level={0.2} live />); });
    act(() => tree.update(<Waveform level={0.9} live={false} />));
    expect(bars(tree)).toHaveLength(1);
    expect(bars(tree)[0].props.backgroundColor).toBe('secondary');
});

it('keeps only the newest bars', () => {
    let tree: any;
    act(() => { tree = create(<Waveform level={0} live />); });
    for (let index = 1; index <= WAVEFORM_BARS + 5; index += 1) act(() => tree.update(<Waveform level={index / 1000} live />));
    expect(bars(tree)).toHaveLength(WAVEFORM_BARS);
    expect(bars(tree).at(-1).props.height).toBe(barHeight((WAVEFORM_BARS + 5) / 1000));
});

it('clamps levels outside 0…1 and treats non-numbers as silence', () => {
    expect(barHeight(-1)).toBe(barHeight(0));
    expect(barHeight(3)).toBe(barHeight(1));
    expect(barHeight(Number.NaN)).toBe(barHeight(0));
});

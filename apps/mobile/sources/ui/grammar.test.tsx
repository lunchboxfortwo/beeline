import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

const dismiss = vi.hoisted(() => vi.fn());
vi.mock('@/ui/lower-keyboard', () => ({ lowerKeyboard: dismiss }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
const insets = vi.hoisted(() => ({ top: 24, bottom: 48, left: 0, right: 0 }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => insets }));
import { APP_UI_SIZE_SCALE } from '@/ui-size';
import { ChatName, Indent, PlaceHeader, SheetFrame, STEP, T, TextScaleContext, TYPE_SCALE, useStep } from './grammar';

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

const textOf = (tree: any) => tree.root.findAll((node: any) => node.type === 'Text')[0].props;

it.each(Object.entries(APP_UI_SIZE_SCALE))('Text size %s scales every type style and its line height', (_size, scale) => {
    for (const [v, { size, line }] of Object.entries(TYPE_SCALE)) {
        let tree: any;
        act(() => { tree = create(<TextScaleContext.Provider value={scale}><T v={v as any}>x</T></TextScaleContext.Provider>); });
        const props = textOf(tree);
        expect(props.fontSize).toBe(Math.round(size * scale));
        // Tamagui native reads a bare number as a multiple of fontSize (23 → 368 pt); points go as px.
        expect(props.lineHeight).toBe(`${Math.round(line * scale)}px`);
    }
});

it('scales spacing steps with Text size', () => {
    let seen: number[] = [];
    function Probe() { const step = useStep(); seen = [step('1'), step('3'), step('8')]; return null; }
    act(() => { create(<TextScaleContext.Provider value={1.2}><Probe /></TextScaleContext.Provider>); });
    expect(seen).toEqual([Math.round(STEP['1'] * 1.2), Math.round(STEP['3'] * 1.2), Math.round(STEP['8'] * 1.2)]);
});

it('gives chat titles their own title styles: 24 for a header, 19 for a list row', () => {
    expect(TYPE_SCALE.title.size).toBe(24);
    expect(TYPE_SCALE.listTitle.size).toBe(19);
});

it('wraps a place header title onto more lines instead of cutting it off, in list rows too', () => {
    const long = '#design-recheck-at-large-text-size';
    const titleLines = (node: React.ReactElement) => {
        let tree: any;
        act(() => { tree = create(node); });
        return tree.root.findAll((n: any) => n.type === 'Text')[0].props.numberOfLines;
    };
    expect(titleLines(<PlaceHeader title={long} safeTop={false} />)).toBeUndefined();
    expect(titleLines(<ChatName name={long} />)).toBeUndefined();
    expect(titleLines(<ChatName v="listTitle" name={long} />)).toBeUndefined();
});

it("draws a chat name's # in brass", () => {
    let tree: any;
    act(() => { tree = create(<ChatName v="listTitle" name="#beeline" />); });
    const texts = tree.root.findAll((node: any) => node.type === 'Text');
    expect(texts[1].props.color).toBe('needsYou');
    expect(texts[1].props.children).toBe('#');
    expect(texts[0].props.children).toContain('beeline');
});

const at = (scale: number, node: React.ReactElement) => {
    let tree: any;
    act(() => { tree = create(<TextScaleContext.Provider value={scale}>{node}</TextScaleContext.Provider>); });
    return tree;
};
const scaled = (s: keyof typeof STEP, scale: number) => Math.round(STEP[s] * scale);

it.each(Object.entries(APP_UI_SIZE_SCALE))('Text size %s scales the place header padding and gaps', (_size, scale) => {
    const tree = at(scale, <PlaceHeader title="Chat" back={vi.fn()} safeTop={false} testID="head" />);
    const row = tree.root.find((node: any) => node.type === 'XStack' && node.props.testID === 'head');
    expect([row.props.paddingHorizontal, row.props.paddingTop, row.props.paddingBottom, row.props.gap])
        .toEqual([scaled('3', scale), scaled('3', scale), scaled('2', scale), scaled('2', scale)]);
    const titleRow = tree.root.findAll((node: any) => node.type === 'XStack' && node.props.flex === 1)[0];
    expect(titleRow.props.gap).toBe(scaled('3', scale));
});

it.each(Object.entries(APP_UI_SIZE_SCALE))('Text size %s scales the sheet padding and keeps it clear of the bottom system bar', (_size, scale) => {
    const tree = at(scale, <SheetFrame open close={vi.fn()} title="Attach"><T>row</T></SheetFrame>);
    const body = tree.root.findAll((node: any) => node.type === 'YStack' && node.props.paddingBottom !== undefined)[0];
    expect([body.props.padding, body.props.paddingTop, body.props.gap])
        .toEqual([scaled('4', scale), scaled('3', scale), scaled('2', scale)]);
    // The physical inset is added after the scaled step, unscaled.
    expect(body.props.paddingBottom).toBe(scaled('6', scale) + insets.bottom);
    const head = tree.root.findAll((node: any) => node.type === 'XStack' && node.props.minHeight !== undefined)[0];
    expect([head.props.gap, head.props.paddingBottom]).toEqual([scaled('2', scale), scaled('2', scale)]);
});

it.each(Object.entries(APP_UI_SIZE_SCALE))('Text size %s indents nested list levels 16 a level at any depth', (_size, scale) => {
    for (const depth of [0, 1, 2, 3, 5]) {
        const tree = at(scale, <Indent depth={depth}><T>item</T></Indent>);
        const box = tree.root.find((node: any) => node.type === 'YStack');
        expect(box.props.paddingLeft).toBe(depth * scaled('4', scale));
    }
});

it('lowers the keyboard as a sheet opens, so the sheet is never drawn under it', () => {
    dismiss.mockClear();
    let tree: any;
    act(() => { tree = create(<SheetFrame open={false} close={() => undefined} title="Attach"><></></SheetFrame>); });
    expect(dismiss).not.toHaveBeenCalled();
    act(() => { tree.update(<SheetFrame open close={() => undefined} title="Attach"><></></SheetFrame>); });
    expect(dismiss).toHaveBeenCalledTimes(1);
});

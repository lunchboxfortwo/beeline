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
import { Btn, ChatName, HEIGHT, Indent, PlaceHeader, SheetFrame, STEP_PRESETS, T, TextSizeContext, TYPE_SCALE, useStep, type TextSize } from './grammar';

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

const textOf = (tree: any) => tree.root.findAll((node: any) => node.type === 'Text')[0].props;

// The approved Small, Medium and Large presets: size/line per type style, and spacing steps.
const PRESETS: Record<TextSize, { type: Record<string, [number, number]>; steps: Record<string, number> }> = {
    small: {
        type: { title: [22, 29], listTitle: [18, 24], heading: [16, 23], body: [15, 22], meta: [12, 18], metaStrong: [12, 18], code: [13, 19] },
        steps: { '0': 0, '0.5': 2, '1': 4, '2': 8, '3': 8, '4': 12, '5': 16, '6': 20, '8': 24 },
    },
    medium: {
        type: { title: [24, 31], listTitle: [19, 25], heading: [16, 23], body: [16, 23], meta: [13, 19], metaStrong: [13, 19], code: [13, 19] },
        steps: { '0': 0, '0.5': 2, '1': 4, '2': 8, '3': 12, '4': 16, '5': 20, '6': 24, '8': 32 },
    },
    large: {
        type: { title: [26, 34], listTitle: [21, 28], heading: [19, 27], body: [19, 28], meta: [15, 22], metaStrong: [15, 22], code: [15, 22] },
        steps: { '0': 0, '0.5': 2, '1': 4, '2': 8, '3': 16, '4': 20, '5': 24, '6': 28, '8': 36 },
    },
};
const SIZES = Object.keys(PRESETS) as TextSize[];

it.each(SIZES)('Text size %s draws every type style at its preset size and line height', (textSize) => {
    for (const [v, [size, line]] of Object.entries(PRESETS[textSize].type)) {
        let tree: any;
        act(() => { tree = create(<TextSizeContext.Provider value={textSize}><T v={v as any}>x</T></TextSizeContext.Provider>); });
        const props = textOf(tree);
        expect([v, props.fontSize]).toEqual([v, size]);
        // Tamagui native reads a bare number as a multiple of fontSize (23 → 368 pt); points go as px.
        expect([v, props.lineHeight]).toEqual([v, `${line}px`]);
    }
});

it.each(SIZES)('Text size %s spaces with its preset steps', (textSize) => {
    let seen: Record<string, number> = {};
    function Probe() { const step = useStep(); seen = Object.fromEntries(Object.keys(STEP_PRESETS.medium).map((s) => [s, step(s as any)])); return null; }
    act(() => { create(<TextSizeContext.Provider value={textSize}><Probe /></TextSizeContext.Provider>); });
    expect(seen).toEqual(PRESETS[textSize].steps);
});

it('keeps control heights fixed at every Text size', () => {
    expect(HEIGHT).toEqual({ control: 44, primary: 48, tabBar: 52, sheetRow: 56 });
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

const at = (textSize: TextSize, node: React.ReactElement) => {
    let tree: any;
    act(() => { tree = create(<TextSizeContext.Provider value={textSize}>{node}</TextSizeContext.Provider>); });
    return tree;
};
const scaled = (s: string, textSize: TextSize) => PRESETS[textSize].steps[s];

it.each(SIZES)('Text size %s spaces the place header with its preset steps', (scale) => {
    const tree = at(scale, <PlaceHeader title="Chat" back={vi.fn()} safeTop={false} testID="head" />);
    const row = tree.root.find((node: any) => node.type === 'XStack' && node.props.testID === 'head');
    expect([row.props.paddingHorizontal, row.props.paddingTop, row.props.paddingBottom, row.props.gap])
        .toEqual([scaled('3', scale), scaled('3', scale), scaled('2', scale), scaled('2', scale)]);
    const titleRow = tree.root.findAll((node: any) => node.type === 'XStack' && node.props.flex === 1)[0];
    expect(titleRow.props.gap).toBe(scaled('3', scale));
});

it.each(SIZES)('Text size %s pads the sheet with its preset steps and keeps it clear of the bottom system bar', (scale) => {
    const tree = at(scale, <SheetFrame open close={vi.fn()} title="Attach"><T>row</T></SheetFrame>);
    const body = tree.root.findAll((node: any) => node.type === 'YStack' && node.props.paddingBottom !== undefined)[0];
    expect([body.props.padding, body.props.paddingTop, body.props.gap])
        .toEqual([scaled('4', scale), scaled('3', scale), scaled('2', scale)]);
    // The physical inset is added after the preset step, unchanged.
    expect(body.props.paddingBottom).toBe(scaled('6', scale) + insets.bottom);
    const head = tree.root.findAll((node: any) => node.type === 'XStack' && node.props.minHeight !== undefined)[0];
    expect([head.props.gap, head.props.paddingBottom]).toEqual([scaled('2', scale), scaled('2', scale)]);
});

it.each(SIZES)('Text size %s indents nested list levels one gutter a level at any depth', (scale) => {
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

it('mounts a sheet body on first opening and retains its state through dismissal', () => {
    const mounted = vi.fn(), unmounted = vi.fn();
    function Body() {
        React.useEffect(() => { mounted(); return unmounted; }, []);
        return <T>Sheet contents</T>;
    }
    let tree: any;
    const sheet = (open: boolean) => <SheetFrame open={open} close={() => undefined} title="Attach"><Body /></SheetFrame>;
    act(() => { tree = create(sheet(false)); });
    expect(mounted).not.toHaveBeenCalled();
    act(() => { tree.update(sheet(true)); });
    expect(mounted).toHaveBeenCalledTimes(1);
    act(() => { tree.update(sheet(false)); });
    expect(unmounted).not.toHaveBeenCalled();
    act(() => { tree.update(sheet(true)); });
    expect(mounted).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
    expect(unmounted).toHaveBeenCalledTimes(1);
});

it('preserves the inset viewer face inside its existing bordered target', () => {
    let tree: any;
    act(() => { tree = create(<Btn kind="icon" label="Talk to agent" viewerInset />); });
    expect(tree.root.findByType('Button').props.minHeight).toBe(42);
    act(() => { tree.update(<Btn kind="icon" label="Close" />); });
    expect(tree.root.findByType('Button').props.minHeight).toBe(44);
});

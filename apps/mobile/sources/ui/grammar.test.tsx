import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

const dismiss = vi.hoisted(() => vi.fn());
const viewport = vi.hoisted(() => ({ height: 844, width: 390 }));
vi.mock('@/ui/lower-keyboard', () => ({ lowerKeyboard: dismiss }));
vi.mock('@/ui/window-dimensions', () => ({ useWindowDimensions: () => viewport }));
vi.mock('react-native', () => ({ useWindowDimensions: () => viewport }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
const insets = vi.hoisted(() => ({ top: 24, bottom: 48, left: 0, right: 0 }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => insets }));
import { CornerDownRight, Hash } from 'lucide-react-native';
import { Btn, ChatName, Glyph, HEIGHT, Indent, Inked, OverlaySheet, PlaceHeader, ScreenHeader, SheetFrame, STEP_PRESETS, T, TextSizeContext, ThreadGlyph, TYPE_SCALE, useStep, type TextSize } from './grammar';

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    viewport.width = 390;
    viewport.height = 844;
});

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

it('renders optional eyebrow text above the PlaceHeader and ScreenHeader title', () => {
    let tree: any;
    act(() => { tree = create(<ScreenHeader title="Workflows" eyebrow="#beeline" back={vi.fn()} safeTop={false} testID="head" />); });
    const texts = tree.root.findAll((node: any) => node.type === 'Text');
    expect(texts[0].props.children).toBe('#beeline');
    expect(texts[0].props.fontSize).toBe(13);
    expect(texts[1].props.children).toBe('Workflows');
    expect(texts[1].props.fontSize).toBe(24);
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

it.each(SIZES)('Text size %s pads the phone sheet with its preset steps and keeps it clear of the bottom system bar', (scale) => {
    const tree = at(scale, <SheetFrame open close={vi.fn()} title="Attach"><T>row</T></SheetFrame>);
    const modal = tree.root.findByType('HullModal');
    expect(modal.props.placement).toBe('bottom');
    const surface = tree.root.findByType('HullFloatingSurface');
    expect([surface.props.borderTopLeftRadius, surface.props.borderTopRightRadius]).toEqual(['viewer', 'viewer']);
    expect(tree.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === 'sheet-grip')).toHaveLength(1);
    const body = tree.root.findAll((node: any) => node.type === 'YStack' && node.props.paddingBottom !== undefined)[0];
    // The grip above the body is the top edge's space.
    expect([body.props.padding, body.props.paddingTop, body.props.gap])
        .toEqual([scaled('4', scale), 0, scaled('2', scale)]);
    // The physical inset is added after the preset step, unchanged.
    expect(body.props.paddingBottom).toBe(scaled('6', scale) + insets.bottom);
    const head = tree.root.findAll((node: any) => node.type === 'XStack' && node.props.minHeight !== undefined)[0];
    expect([head.props.gap, head.props.paddingBottom]).toEqual([scaled('2', scale), scaled('2', scale)]);
});

it('UI-SHEET-1: centers OverlaySheet on desktop without a drag grip using 3px house radius and shared HullModal stacking', () => {
    viewport.width = 1440;
    viewport.height = 900;
    const close = vi.fn();
    const tree = at('medium', <OverlaySheet open close={close} title="Task" testID="work-sheet"><T>body</T></OverlaySheet>);
    expect(SheetFrame).toBe(OverlaySheet);
    const modal = tree.root.findByType('HullModal');
    expect(modal.props.visible).toBe(true);
    expect(modal.props.placement).toBe('center');
    expect(modal.props.contentMaxWidth).toBe(480);
    expect(modal.props.onRequestClose).toBe(close);
    const surface = tree.root.findByType('HullFloatingSurface');
    expect(surface.props.testID).toBe('work-sheet');
    expect(surface.props.borderRadius).toBe('house');
    expect(surface.props.borderColor).toBe('strongStroke');
    expect(tree.root.findAll((node: any) => node.props.testID === 'work-sheet-grip')).toHaveLength(0);
    const closeBtn = tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'work-sheet-close');
    act(() => closeBtn.props.onPress());
    expect(close).toHaveBeenCalledTimes(1);
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

it('does not mount a sheet body before first opening and toggles HullModal visibility cleanly', () => {
    const mounted = vi.fn(), unmounted = vi.fn();
    function Body() {
        React.useEffect(() => { mounted(); return unmounted; }, []);
        return <T>Sheet contents</T>;
    }
    let tree: any;
    const sheet = (open: boolean) => <SheetFrame open={open} close={() => undefined} title="Attach"><Body /></SheetFrame>;
    act(() => { tree = create(sheet(false)); });
    expect(mounted).not.toHaveBeenCalled();
    expect(tree.root.findAllByType('HullModal')).toHaveLength(0);
    act(() => { tree.update(sheet(true)); });
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(tree.root.findByType('HullModal').props.visible).toBe(true);
    act(() => { tree.update(sheet(false)); });
    expect(tree.root.findByType('HullModal').props.visible).toBe(false);
    act(() => { tree.update(sheet(true)); });
    expect(tree.root.findByType('HullModal').props.visible).toBe(true);
    act(() => tree.unmount());
    expect(unmounted).toHaveBeenCalled();
});

it('preserves the inset viewer face inside its existing bordered target and uses house radius on boxed buttons', () => {
    let tree: any;
    act(() => { tree = create(<Btn kind="icon" label="Talk to agent" viewerInset />); });
    expect(tree.root.findByType('Button').props.minHeight).toBe(42);
    act(() => { tree.update(<Btn kind="icon" label="Close" />); });
    expect(tree.root.findByType('Button').props.minHeight).toBe(44);
    for (const kind of ['primary', 'secondary', 'destructive', 'accent', 'quiet'] as const) {
        act(() => { tree.update(<Btn kind={kind} label="Action">Action</Btn>); });
        expect(tree.root.findByType('Button').props.borderRadius).toBe('house');
    }
});

it('bounds a scrolling sheet below the safe top and keeps its header outside the scroll body', () => {
    const tree = at('medium', <SheetFrame open close={vi.fn()} title="Reviewer" scrollable testID="sheet-reviewer"><T>Last agent</T></SheetFrame>);
    const scroll = tree.root.findByType('ScrollView');
    expect(scroll.props.flexShrink).toBe(1);
    expect(scroll.props.minHeight).toBe(0);
    expect(scroll.props.nestedScrollEnabled).toBe(true);
    const texts = scroll.findAll((node: any) => node.type === 'Text').map((node: any) => node.props.children);
    expect(texts).toContain('Last agent');
    expect(texts).not.toContain('Reviewer');
    const body = tree.root.findAll((node: any) => node.type === 'View' && Array.isArray(node.props.style))
        .find((node: any) => node.props.style.some((style: any) => style?.maxHeight !== undefined));
    expect(body.props.style[0].maxHeight).toBe(844 - insets.top - scaled('6', 'medium'));
});

it('disables native includeFontPadding on T while preserving points() and keeping web DOM styles clean', () => {
    let nativeTree: any;
    act(() => { nativeTree = create(<T v="title">release-corner</T>); });
    const nativeProps = textOf(nativeTree);
    expect(nativeProps.lineHeight).toBe('31px');
    expect(nativeProps.style).toEqual({ includeFontPadding: false });
    act(() => nativeTree.unmount());

    const hadDocument = 'document' in globalThis;
    const prevDocument = (globalThis as any).document;
    (globalThis as any).document = {};
    try {
        let webTree: any;
        act(() => { webTree = create(<T v="title">release-corner</T>); });
        const webProps = textOf(webTree);
        expect(webProps.lineHeight).toBe('31px');
        expect(webProps.style).toBeUndefined();
        act(() => webTree.unmount());
    } finally {
        if (hadDocument) (globalThis as any).document = prevDocument;
        else delete (globalThis as any).document;
    }
});

it('centers ThreadGlyph horizontal arrow shaft and arrowhead tip at y=12 without clipping strong strokes, and routes CornerDownRight through both Glyph and Inked', () => {
    const assertCenteredSvg = (tree: any, size: number, strokeWidth: number, expectedColor?: string) => {
        const svg = tree.root.findByType('Svg');
        expect(svg.props).toMatchObject({ viewBox: '0 0 24 24', width: size, height: size });
        const paths = svg.findAllByType('Path');
        expect(paths).toHaveLength(2);
        const [head, stem] = paths;
        expect(head.props.d).toBe('M15 7L20 12L15 17');
        expect(stem.props.d).toBe('M4 1.5v6.5a4 4 0 0 0 4 4h12');
        for (const p of paths) {
            expect(p.props).toMatchObject({ fill: 'none', strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round' });
            if (expectedColor) expect(p.props.stroke).toBe(expectedColor);
        }
        // Top stem cap stays inside the 24x24 viewBox even at strong strokeWidth (2.3).
        const stemStartY = Number(stem.props.d.match(/^M4\s+([\d.]+)/)?.[1]);
        expect(stemStartY - strokeWidth / 2).toBeGreaterThan(0);
    };

    let direct: any;
    act(() => { direct = create(<ThreadGlyph size={18} strokeWidth={2.3} color="ink" />); });
    assertCenteredSvg(direct, 18, 2.3, 'ink');
    act(() => direct.unmount());

    let viaGlyph: any;
    act(() => { viaGlyph = create(<Glyph icon={CornerDownRight} size={16} />); });
    assertCenteredSvg(viaGlyph, 16, 1.7, 'secondary');
    act(() => viaGlyph.unmount());

    let viaStrongGlyph: any;
    act(() => { viaStrongGlyph = create(<Glyph icon={CornerDownRight} size={18} accent strong />); });
    assertCenteredSvg(viaStrongGlyph, 18, 2.3, 'needsYou');
    act(() => viaStrongGlyph.unmount());

    let viaInked: any;
    act(() => { viaInked = create(<Inked glyph={CornerDownRight} color="secondary" size={13} strokeWidth={1.7} />); });
    assertCenteredSvg(viaInked, 13, 1.7, 'secondary');
    act(() => viaInked.unmount());

    // Non-thread icons continue passing through unchanged.
    let hashTree: any;
    act(() => { hashTree = create(<Glyph icon={Hash} size={16} />); });
    expect(hashTree.root.findAll((n: any) => n.type === 'Icon.Hash')).toHaveLength(1);
    expect(hashTree.root.findAll((n: any) => n.type === 'Svg')).toHaveLength(0);
    act(() => hashTree.unmount());
});

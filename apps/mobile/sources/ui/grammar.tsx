import React, { useEffect, useState } from 'react';
import { lowerKeyboard } from '@/ui/lower-keyboard';
import {
    Button as TButton,
    Card,
    ListItem,
    ScrollView,
    Separator,
    Sheet,
    Text,
    Theme,
    XStack,
    YStack,
    useTheme,
    useThemeName,
} from 'tamagui';
import { ArrowLeft, Check, ChevronRight, Copy as CopyIcon, MessagesSquare } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { type AnimatedProps, type AnimatedStyle } from 'react-native-reanimated';
import type { ViewProps, ViewStyle } from 'react-native';
import { QR_INK, QR_PAPER, SCRIM } from '@/buzz/groknight';

/**
 * The one design grammar (build spec → "The grammar (one page)"). Six type
 * styles, ten colour tokens plus one scrim, eight spacing steps, four radii,
 * fixed control heights and one icon style. `scripts/check-mobile-grammar.mjs`
 * fails CI on any value outside it.
 */

export { SCRIM };

/** Control heights: every control, the one primary action, the tab bar, a sheet row. */
export const HEIGHT = { control: 44, primary: 48, tabBar: 52, sheetRow: 56 } as const;

export type Variant = 'title' | 'listTitle' | 'heading' | 'body' | 'meta' | 'metaStrong' | 'code';
// Loaded font faces (app/_layout.tsx); Tamagui types only know its font tokens.
const REGULAR = 'SpaceGrotesk-Regular' as any;
const SEMIBOLD = 'SpaceGrotesk-SemiBold' as any;
const MONO = 'IBMPlexMono-Regular' as any;
/**
 * Size and line height at Medium. `title` heads a page (the chat header, every
 * pushed page, every sheet); `listTitle` names a chat in a list.
 */
export const TYPE_SCALE: Record<Variant, { size: number; line: number; face: any }> = {
    title: { size: 24, line: 31, face: SEMIBOLD },
    listTitle: { size: 19, line: 25, face: SEMIBOLD },
    heading: { size: 16, line: 23, face: SEMIBOLD },
    body: { size: 16, line: 23, face: REGULAR },
    meta: { size: 13, line: 19, face: REGULAR },
    metaStrong: { size: 13, line: 19, face: SEMIBOLD },
    code: { size: 13, line: 19, face: MONO },
};

/** Settings → You → Text size: 0.86, 1 or 1.2. GrammarProvider supplies it. */
export const TextScaleContext = React.createContext(1);
export function useTextScale(): number {
    return React.useContext(TextScaleContext);
}

/** One type style at a text scale. */
export function typeStyle(v: Variant, scale: number) {
    const { size, line, face } = TYPE_SCALE[v];
    return { fontSize: Math.round(size * scale), lineHeight: Math.round(line * scale), fontFamily: face };
}

/**
 * A style for a Tamagui Text. Its native renderer reads a bare-number
 * lineHeight as a multiple of fontSize (23 → 23 × 16 pt), so points go as px.
 */
export function points<S>(style: S): S {
    if (Array.isArray(style)) return style.map(points) as S;
    const line = (style as { lineHeight?: unknown } | null)?.lineHeight;
    return typeof line === 'number' ? { ...style, lineHeight: `${line}px` } : style;
}

export type Step = '0' | '0.5' | '1' | '2' | '3' | '4' | '5' | '6' | '8';
/** Spacing steps in points at Medium. */
export const STEP: Record<Step, number> = { '0': 0, '0.5': 2, '1': 4, '2': 8, '3': 12, '4': 16, '5': 20, '6': 24, '8': 32 };
/**
 * Spacing that follows Text size. Text rows (chat list, transcript, settings
 * rows) space themselves with `step('3')` so their gaps scale with their type.
 */
export function useStep(): (s: Step) => number {
    const scale = useTextScale();
    return React.useCallback((s: Step) => Math.round(STEP[s] * scale), [scale]);
}

type TextProps = React.ComponentProps<typeof Text>;
/** The whole type scale. Nothing else may set a font, size or weight. */
export function T({ v = 'body', children, ...rest }: { v?: Variant; children?: React.ReactNode } & Omit<TextProps, 'fontSize' | 'fontFamily' | 'fontWeight' | 'lineHeight'>) {
    const style = points(typeStyle(v, useTextScale()));
    return <Text {...style} fontWeight="400" flexShrink={1} color="ink" {...rest}>{children}</Text>;
}

/** Body or meta copy in ink, secondary or brass. */
export function Copy({ children, quiet = false, small = false, strong = false, accent = false, ...rest }: {
    children?: React.ReactNode; quiet?: boolean; small?: boolean; strong?: boolean; accent?: boolean;
} & Omit<TextProps, 'fontSize' | 'fontFamily' | 'fontWeight' | 'lineHeight'>) {
    const v: Variant = small ? (strong ? 'metaStrong' : 'meta') : strong ? 'heading' : 'body';
    return <T v={v} color={accent ? 'needsYou' : quiet ? 'secondary' : 'ink'} {...rest}>{children}</T>;
}

type IconComponent = React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;
/** Icons: lucide outline at 16 or 20, 1.7 stroke, secondary; brass when it means you. */
export function Glyph({ icon: Icon, size = 20, accent = false, color }: { icon: IconComponent; size?: 14 | 16 | 18 | 20; accent?: boolean; color?: 'ink' | 'primaryInk' | 'removed' }) {
    const t = useTheme() as Record<string, { val: string } | undefined>;
    const ink = color ? t[color]?.val : accent ? t.needsYou?.val : t.secondary?.val;
    return <Icon size={size} color={ink} strokeWidth={1.7} />;
}

export type ButtonKind = 'primary' | 'secondary' | 'icon' | 'quiet' | 'destructive' | 'accent';
type ButtonProps = React.ComponentProps<typeof TButton>;
/**
 * Buttons: primary (one per view, 48), secondary (bordered), icon (round 44),
 * quiet (no frame), destructive (removed ink), accent (brass frame).
 */
export function Btn({ kind = 'secondary', label, children, disabled, ...rest }: {
    kind?: ButtonKind; label: string; children?: React.ReactNode;
} & Omit<ButtonProps, 'children' | 'aria-label'>) {
    const shape: Partial<ButtonProps> =
        kind === 'primary' ? { theme: 'button' as any, minHeight: HEIGHT.primary }
            : kind === 'icon' ? { size: 'sm' as any, circular: true, minWidth: HEIGHT.control, minHeight: HEIGHT.control, backgroundColor: 'transparent', borderWidth: 0 }
                : kind === 'quiet' ? { size: 'sm' as any, minHeight: HEIGHT.control, backgroundColor: 'transparent', borderWidth: 0 }
                    : kind === 'destructive' ? { minHeight: HEIGHT.control, borderWidth: 1, borderColor: 'removed', backgroundColor: 'canvas' }
                        : kind === 'accent' ? { size: 'sm' as any, minHeight: HEIGHT.control, borderWidth: 1, borderColor: 'needsYou' }
                            : { minHeight: HEIGHT.control, borderWidth: 1, borderColor: 'strongStroke' };
    const content = typeof children === 'string'
        ? <T v="heading" color={kind === 'primary' ? 'primaryInk' : kind === 'destructive' ? 'removed' : 'ink'}>{children}</T>
        : children;
    return (
        <TButton
            fontFamily={SEMIBOLD}
            fontWeight="400"
            aria-label={label}
            accessibilityLabel={label}
            disabled={disabled}
            opacity={disabled ? 0.5 : 1}
            {...shape}
            {...rest}
        >
            {content}
        </TButton>
    );
}

/** A section label over a card of rows. */
export function Section({ title, children, note, testID }: { title: string; children: React.ReactNode; note?: string; testID?: string }) {
    const step = useStep();
    return (
        <YStack gap={step('2')} testID={testID}>
            <XStack gap={step('2')} alignItems="baseline" flexWrap="wrap">
                <T v="metaStrong" color="secondary">{title}</T>
                {note ? <Copy small quiet>{note}</Copy> : null}
            </XStack>
            <Card backgroundColor="raised" borderWidth={1} borderColor="stroke" paddingHorizontal={step('3')} paddingVertical={step('1')}>{children}</Card>
        </YStack>
    );
}

/** Label, value or second line, chevron if it opens. */
export function Row({ label, value, detail, icon, leading, onPress, last, right, testID, tone }: {
    label: string; value?: string; detail?: string; icon?: IconComponent; leading?: React.ReactNode;
    onPress?: () => void; last?: boolean; right?: React.ReactNode; testID?: string; tone?: 'removed';
}) {
    const step = useStep();
    const body = (
        <XStack gap={step('3')} alignItems="flex-start" paddingVertical={step('3')} flexGrow={1} flexShrink={1} minWidth={0}>
            {leading}
            {icon ? <YStack paddingTop="0.5"><Glyph icon={icon} size={18} /></YStack> : null}
            <YStack flex={1} minWidth={0} gap={step('1')}>
                {tone ? <T v="heading" color={tone}>{label}</T> : <Copy>{label}</Copy>}
                {detail ? <Copy small quiet>{detail}</Copy> : null}
            </YStack>
            {value ? <YStack maxWidth="50%"><Copy quiet>{value}</Copy></YStack> : null}
            {right}
            {onPress ? <YStack paddingTop="0.5"><Glyph icon={ChevronRight} size={16} /></YStack> : null}
        </XStack>
    );
    return (
        <>
            {onPress
                ? <ListItem padding="0" minHeight={HEIGHT.control} backgroundColor="raised" onPress={onPress} aria-label={label} accessibilityRole="button" testID={testID}>{body}</ListItem>
                : <YStack testID={testID}>{body}</YStack>}
            {last ? null : <Separator borderColor="stroke" />}
        </>
    );
}

/**
 * The header of a place (a chat, its info, a pushed page): Back, an optional
 * mark, the title with an optional quiet line under it, then actions. A chat
 * and every page it opens share this frame, so entering one never shifts the
 * title. Takes the device's top inset on phones.
 */
export function PlaceHeader({ title, back, backLabel = 'Back', backTestID, mark, meta, right, safeTop = true, testID }: {
    title: React.ReactNode; back?: () => void; backLabel?: string; backTestID?: string; mark?: React.ReactNode; meta?: React.ReactNode;
    right?: React.ReactNode; safeTop?: boolean; testID?: string;
}) {
    const step = useStep();
    return (
        <YStack backgroundColor="canvas">
            {safeTop ? <SafeTop /> : null}
            <XStack paddingHorizontal={step('3')} paddingTop={step('3')} paddingBottom={step('2')} gap={step('2')} alignItems="center" testID={testID}>
                {back ? <Btn kind="icon" label={backLabel} onPress={back} testID={backTestID}><Glyph icon={ArrowLeft} /></Btn> : null}
                <XStack flex={1} minWidth={0} gap={step('3')} alignItems="center">
                    {mark}
                    <YStack flex={1} minWidth={0}>
                        {typeof title === 'string' ? <T v="title">{title}</T> : title}
                        {meta}
                    </YStack>
                </XStack>
                {right}
            </XStack>
        </YStack>
    );
}

/** Back and title on pushed pages (phone); desktop panels close with the same control. */
export function ScreenHeader({ title, back, right, backLabel = 'Back', safeTop = false }: { title: string; back?: () => void; right?: React.ReactNode; backLabel?: string; safeTop?: boolean }) {
    return (
        <>
            <PlaceHeader title={title} back={back} right={right} backLabel={backLabel} safeTop={safeTop} />
            <Separator borderColor="stroke" />
        </>
    );
}

/** A pushed page: header (or a place's own `header`), then a scrolling column of sections. */
export function Screen({ title, back, children, testID, right, header }: { title: string; back?: () => void; children: React.ReactNode; testID?: string; right?: React.ReactNode; header?: React.ReactNode }) {
    const step = useStep();
    return (
        <YStack flex={1} minHeight={0} backgroundColor="canvas" testID={testID}>
            {header ?? <ScreenHeader title={title} back={back} right={right} safeTop />}
            {/* The column grows to the page's height so a page loader centres in it. */}
            <ScrollView flex={1} minHeight={0} keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1 }}>
                <YStack flexGrow={1} padding={step('4')} gap={step('5')} paddingBottom={step('8')}>{children}</YStack>
            </ScrollView>
        </YStack>
    );
}

/** A chat's mark: the chat glyph on its own plate (a chat has no picture of its own). */
export function ChatMark({ size = 36 }: { size?: 36 | 28 }) {
    return (
        <YStack width={size} height={size} borderRadius="sm" backgroundColor="highlight" alignItems="center" justifyContent="center" testID="chat-mark">
            <Glyph icon={MessagesSquare} size={size === 36 ? 20 : 16} />
        </YStack>
    );
}

/** A chat's name in a title style, its leading # in brass. */
export function ChatName({ name, v = 'title', testID }: { name: string; v?: 'title' | 'listTitle'; testID?: string }) {
    const hash = name.startsWith('#');
    return (
        <T v={v} testID={testID}>
            {hash ? <T v={v} color="needsYou">#</T> : null}
            {hash ? name.slice(1) : name}
        </T>
    );
}

/** A nested list level: 16 a level at Medium, at any depth, following Text size. */
export function Indent({ depth, children }: { depth: number; children: React.ReactNode }) {
    const step = useStep();
    return <YStack width="100%" paddingLeft={Math.max(0, depth) * step('4')}>{children}</YStack>;
}

/** The one sheet frame: scrim, handle, title, one step deep with Back. */
export function SheetFrame({ open, close, title, testID, children, back }: {
    open: boolean; close: () => void; title: string; testID?: string; children: React.ReactNode; back?: () => void;
}) {
    const theme = useThemeName();
    // Android's 3-button bar and the iOS home indicator sit over the sheet's foot.
    const insets = useSafeAreaInsets();
    const step = useStep();
    // The sheet draws in the app window, under the keyboard: opening it from a
    // focused composer would leave its scrim taking every tap with the sheet
    // itself hidden. Lower the keyboard as it opens.
    useEffect(() => { if (open) lowerKeyboard(); }, [open]);
    return (
        <Theme name={theme}>
            <Sheet modal open={open} onOpenChange={(o: boolean) => { if (!o) close(); }} snapPointsMode="fit" dismissOnSnapToBottom>
                <Sheet.Overlay backgroundColor={SCRIM} />
                <Sheet.Handle backgroundColor="secondary" opacity={0.5} />
                <Sheet.Container maxWidth={480} width="100%" alignSelf="center" testID={testID}>
                    <Sheet.Background backgroundColor="raised" borderTopLeftRadius="lg" borderTopRightRadius="lg" borderWidth={1} borderColor="stroke" />
                    {/* Text-size steps, then the device's physical bottom inset. */}
                    <YStack padding={step('4')} paddingTop={step('3')} paddingBottom={step('6') + insets.bottom} gap={step('2')}>
                        <XStack gap={step('2')} alignItems="center" paddingBottom={step('2')} minHeight={HEIGHT.control}>
                            {back ? <Btn kind="icon" label="Back" onPress={back}><Glyph icon={ArrowLeft} /></Btn> : null}
                            <T v="title" flex={1}>{title}</T>
                        </XStack>
                        {children}
                    </YStack>
                </Sheet.Container>
            </Sheet>
        </Theme>
    );
}

/** One sheet row: an icon column, a label and an optional quiet line, then a chevron when it opens a step. */
export function SheetRow({ icon, label, detail, onPress, testID, right, chevron = false }: {
    icon: React.ReactNode; label: string; detail?: string; onPress: () => void; testID?: string; right?: React.ReactNode; chevron?: boolean;
}) {
    const step = useStep();
    return (
        <ListItem minHeight={HEIGHT.sheetRow} paddingHorizontal="0" paddingVertical={step('2')} gap={step('3')} justifyContent="flex-start" backgroundColor="raised" onPress={onPress} aria-label={label} accessibilityRole="button" testID={testID}>
            <YStack width={28} alignItems="center">{icon}</YStack>
            <YStack flex={1} minWidth={0} gap={step('1')}>
                <Copy>{label}</Copy>
                {detail ? <Copy small quiet>{detail}</Copy> : null}
            </YStack>
            {right}
            {chevron ? <Glyph icon={ChevronRight} size={16} /> : null}
        </ListItem>
    );
}

/** One copyable line (a link, a command, a join line): the whole row copies it. */
export function CopyLine({ line, label, onCopy }: { line: string; label: string; onCopy: (line: string) => void | Promise<void> }) {
    const [copied, setCopied] = useState(false);
    return (
        <ListItem padding="3" gap="2" borderRadius="md" borderWidth={1} borderColor="strongStroke" backgroundColor="canvas" aria-label={label} accessibilityRole="button" onPress={async () => { await onCopy(line); setCopied(true); }}>
            <YStack flex={1} minWidth={0}><T v="code">{line}</T></YStack>
            <Glyph icon={copied ? Check : CopyIcon} size={16} accent={copied} />
            <T v="metaStrong" color={copied ? 'needsYou' : 'secondary'}>{copied ? 'Copied' : 'Copy'}</T>
        </ListItem>
    );
}

/** A brass count (Tags). */
export function CountPill({ n }: { n: number }) {
    return (
        <YStack minWidth={24} height={24} paddingHorizontal="2" borderRadius="full" backgroundColor="needsYou" alignItems="center" justifyContent="center" testID="count-pill">
            <T v="metaStrong" color="canvas">{n}</T>
        </YStack>
    );
}

/** Unread is a solid brass dot; a tag adds a ring around it. */
export function StatusMark({ unread, tagged }: { unread: boolean; tagged: boolean }) {
    if (!unread && !tagged) return null;
    return (
        <YStack width={16} height={16} borderRadius="full" borderWidth={tagged ? 1 : 0} borderColor="needsYou" alignItems="center" justifyContent="center" aria-label={tagged ? 'Tagged you' : 'Unread'} testID="status-mark">
            <YStack width={8} height={8} borderRadius="full" backgroundColor="needsYou" />
        </YStack>
    );
}


/** Device safe-area spacers: the only place a screen takes an inset that is not a grammar step. */
export function SafeTop() {
    const insets = useSafeAreaInsets();
    return <YStack height={insets.top} backgroundColor="canvas" />;
}
export function SafeBottom() {
    const insets = useSafeAreaInsets();
    return <YStack height={insets.bottom} backgroundColor="canvas" />;
}

/** What motion may change: opacity, transforms and the size it animates through. */
export type MotionStyle = AnimatedStyle<Pick<ViewStyle, 'opacity' | 'transform' | 'width' | 'height' | 'maxHeight'>>;
type MotionProps = Pick<AnimatedProps<ViewProps>, 'entering' | 'exiting' | 'layout' | 'pointerEvents' | 'testID' | 'onLayout' | 'children'>;
/**
 * The one animated surface. Motion values come from Reanimated; layout stays in
 * the Tamagui stacks it wraps. `fill` takes the parent's space, `overlay` lies
 * over it, `row` lays children out across.
 */
export function Motion({ motion, fill = false, overlay = false, row = false, ...rest }: MotionProps & {
    motion?: MotionStyle | MotionStyle[]; fill?: boolean; overlay?: boolean; row?: boolean;
}) {
    const frame: ViewStyle = {
        ...(fill ? { flex: 1, minHeight: 0 } : null),
        ...(overlay ? { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } : null),
        ...(row ? { flexDirection: 'row', alignItems: 'center' } : null),
    };
    return <Animated.View {...rest} style={[frame, ...(Array.isArray(motion) ? motion : [motion])]} />;
}

/** Takes the device's left and right safe-area insets (landscape notches). */
export function SafeSides({ children }: { children: React.ReactNode }) {
    const insets = useSafeAreaInsets();
    return <YStack flex={1} paddingLeft={insets.left} paddingRight={insets.right}>{children}</YStack>;
}

/**
 * Third-party views that only take a style object (markdown renderers, images,
 * WebView) get it from a named component below; `useTypeStyle` is one type
 * style in one colour token as a plain, memoised TextStyle for them.
 */
export type ColorToken = 'canvas' | 'raised' | 'highlight' | 'stroke' | 'strongStroke' | 'ink' | 'secondary'
    | 'needsYou' | 'added' | 'removed' | 'primaryFill' | 'primaryInk' | 'transparent';
function useTypeStyle(v: Variant, color: ColorToken = 'ink'): import('react-native').TextStyle {
    const scale = useTextScale();
    const ink = (useTheme() as Record<string, { val: string } | undefined>)[color]?.val;
    return React.useMemo(() => ({ ...typeStyle(v, scale), fontWeight: '400' as const, color: ink }), [v, scale, ink]);
}

/**
 * A drawn glyph (react-native-svg, ActivityIndicator, a third-party icon) that
 * takes its ink as a colour string: draws `glyph` with the theme value of the
 * `color` token. `<Inked color="secondary" glyph={ChevronGlyph} size={14} />`.
 */
export function Inked<P extends { color?: string }>({ color, glyph: Glyph, ...rest }: { color: ColorToken; glyph: React.ComponentType<P> } & Omit<P, 'color'>) {
    const ink = (useTheme() as Record<string, { val: string } | undefined>)[color]?.val;
    return <Glyph {...(rest as unknown as P)} color={ink} />;
}

/**
 * Motion as an in-window layer: `overlay`, stacked above its siblings. For a
 * modal drawn inside the current screen (Android Room sheets) whose exit must
 * animate on the layer itself.
 */
export function MotionLayer({ motion, ...rest }: MotionProps & { motion?: MotionStyle | MotionStyle[] }) {
    return <Animated.View {...rest} style={[{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 1000 }, ...(Array.isArray(motion) ? motion : [motion])]} />;
}

/**
 * A third-party view that only takes a style object (WebView, expo-image)
 * filling its frame on one colour token: `<FillView view={Image} source={…} backgroundColor="canvas" />`.
 */
export function FillView<P extends { style?: unknown }>({ view: View, backgroundColor = 'transparent', ...rest }: { view: React.ComponentType<P>; backgroundColor?: ColorToken } & Omit<P, 'style'>) {
    const ground = (useTheme() as Record<string, { val: string } | undefined>)[backgroundColor]?.val;
    const style = React.useMemo(() => ({ width: '100%', height: '100%', backgroundColor: ground }), [ground]);
    return <View {...(rest as unknown as P)} style={style} />;
}

/**
 * Web only: an iframe filling its frame with no border. `src` for a document
 * that paints its own page; `srcDoc` + `sandbox` for an author's markup, which
 * reads on `paper` (a white page, as a browser tab would draw it).
 */
export function DocumentFrame({ src, srcDoc, sandbox, title, testID, paper = false }: {
    src?: string; srcDoc?: string; sandbox?: string; title: string; testID?: string; paper?: boolean;
}) {
    return React.createElement('iframe', {
        src, srcDoc, sandbox, title, 'data-testid': testID,
        style: { border: 'none', width: '100%', height: '100%', ...(paper ? { backgroundColor: QR_PAPER } : null) },
    });
}

/**
 * A text renderer that takes its body as a `textStyle` object (MonoMarkdown):
 * draws `view` with one type style in one colour token.
 * `<TypedView view={MonoMarkdown} v="body" markdown={text} document />`.
 */
export function TypedView<P extends { textStyle: import('react-native').TextStyle }>({ view: View, v = 'body', color = 'ink', ...rest }: {
    view: React.ComponentType<P>; v?: Variant; color?: ColorToken;
} & Omit<P, 'textStyle'>) {
    const textStyle = useTypeStyle(v, color);
    return <View {...(rest as unknown as P)} textStyle={textStyle} />;
}

/**
 * A pass-through list wrapper whose caller hands it a content-container layout
 * (RoomSendList forwarding a FlatList API): draws `list` with `container` as its
 * contentContainerStyle and forwards the ref.
 * `<ContainedList list={FlatList} container={[a, b]} ref={ref} data={…} … />`.
 */
type ContainedListProps<P> = { list: React.ComponentType<P>; container: unknown } & Omit<P, 'contentContainerStyle'>;
export const ContainedList = React.forwardRef(function ContainedList<P extends { contentContainerStyle?: unknown }>(
    { list: List, container, ...rest }: ContainedListProps<P>,
    ref: React.Ref<unknown>,
) {
    return <List {...(rest as unknown as P)} ref={ref} contentContainerStyle={container} />;
}) as <P extends { contentContainerStyle?: unknown }>(props: ContainedListProps<P> & { ref?: React.Ref<any> }) => React.ReactElement | null;

/**
 * A list (FlatList, or a wrapper that forwards its props) with its content
 * padded on the grammar's steps: `x`/`y` pad the content; `top` replaces the
 * top pad with a measured inset in points (an inverted transcript's visual
 * tail); `emptyGrow` lets an empty list's content fill it through the
 * wrapper's `emptyContentContainerStyle`. `<ListPad list={FlatList} x="4" … />`.
 */
export function ListPad<P extends object>({ list: List, x = '0', y = '0', top, emptyGrow = false, ...rest }: {
    list: React.ComponentType<P>; x?: Step; y?: Step; top?: number; emptyGrow?: boolean;
} & Omit<P, 'contentContainerStyle' | 'emptyContentContainerStyle'>) {
    const content = React.useMemo(
        () => ({ paddingHorizontal: STEP[x], paddingVertical: STEP[y], ...(top === undefined ? null : { paddingTop: top }) }),
        [x, y, top],
    );
    const pad = { contentContainerStyle: content, ...(emptyGrow ? { emptyContentContainerStyle: LIST_GROW } : null) };
    return <List {...(rest as unknown as P)} {...pad} />;
}
const LIST_GROW = { flexGrow: 1 } as const;

/**
 * A view that sizes only through a `style` object (an image or media view
 * owned by another module): draws `view` filling the Tamagui frame it sits
 * in. `<YStack width={44} height={44}><Filled view={ArtifactImage} … /></YStack>`.
 */
export function Filled<P extends object>({ view: View, ...rest }: { view: React.ComponentType<P> } & Omit<P, 'style'>) {
    return <View {...(rest as unknown as P)} style={FILLED} />;
}
const FILLED = { width: '100%', height: '100%' } as const;

/**
 * Desktop web only: a scrolling column over real DOM (no VirtualizedList),
 * overflow-y auto, with the browser's own scroll anchoring off so the
 * transcript's follow logic alone decides where the reader rests.
 */
export function DesktopScroll(props: React.ComponentProps<typeof YStack>) {
    return <YStack flex={1} overflowX="hidden" overflowY="auto" {...props} style={NO_SCROLL_ANCHOR as any} />;
}
const NO_SCROLL_ANCHOR = { overflowAnchor: 'none' } as const;

/**
 * The scrim as one press target that closes what lies over it (an in-window
 * overlay such as the desktop Workspace switcher): fills its parent in SCRIM.
 * `<ScrimButton label="Close Workspace switcher" onPress={close} />`.
 */
export function ScrimButton({ label, onPress, testID }: { label: string; onPress: () => void; testID?: string }) {
    return (
        <YStack position="absolute" top={0} right={0} bottom={0} left={0} backgroundColor={SCRIM}
            onPress={onPress} aria-label={label} accessibilityLabel={label} accessibilityRole="button" testID={testID} />
    );
}

/**
 * A scrolling page whose content is at least as tall as the view, so a column
 * inside can pin a mark to the top and its copy to the foot (an update gate).
 * `<GrowScroll><YStack flexGrow={1}>…</YStack></GrowScroll>`.
 */
export function GrowScroll(props: Omit<React.ComponentProps<typeof ScrollView>, 'contentContainerStyle'>) {
    return <ScrollView {...props} contentContainerStyle={GROW_CONTENT} />;
}
const GROW_CONTENT = { flexGrow: 1 } as const;

/**
 * An emoji-only glyph at one type style's size and no line height: on Android
 * an explicit line height sizes the line box from the first font alone and
 * clips the fallback emoji font's taller glyph.
 */
export function EmojiGlyph({ v = 'body', children, ...rest }: { v?: Variant; children?: React.ReactNode } & Omit<TextProps, 'fontSize' | 'fontFamily' | 'fontWeight' | 'lineHeight'>) {
    const { fontSize, fontFamily } = typeStyle(v, useTextScale());
    return <Text fontSize={fontSize} fontFamily={fontFamily} fontWeight="400" color="ink" {...rest}>{children}</Text>;
}

/**
 * Outsets a clipping child (a swipeable transcript row) by one step on each
 * side: the gutter a live identity ring (`ALIVE_RING_PAD`, 4 pt) paints
 * outside its tile. Pad the content back inside with `paddingHorizontal="1"`
 * so the copy column never moves.
 */
export function RingOutset({ children }: { children: React.ReactNode }) {
    return <YStack marginHorizontal={-STEP['1']}>{children}</YStack>;
}

/**
 * A run of prose over a body style its caller owns (MonoMarkdown and the live
 * draft take `textStyle` from TypedView): draws `body`, then the named `marks`
 * in order, then a document heading `level`'s type style, then `fade` (the
 * arriving tail's own style). With no `body` the run inherits its parent run.
 * Marks: `strong` semibold ink, `emphasis` semibold, `code` mono secondary,
 * `link` underlined, `brass` needsYou, `viewer` semibold on highlight, `quiet`
 * secondary. `<ProseRun body={textStyle} marks={['quiet']} selectable>…</ProseRun>`.
 */
export type ProseMark = 'strong' | 'emphasis' | 'code' | 'link' | 'brass' | 'viewer' | 'quiet';
const HEADING_LEVELS: ReadonlyArray<[Variant, ColorToken]> = [
    ['title', 'ink'], ['heading', 'ink'], ['heading', 'secondary'], ['body', 'secondary'], ['metaStrong', 'secondary'], ['meta', 'secondary'],
];
export function ProseRun({ body, marks, level, fade, children, ...rest }: Omit<TextProps, 'style'> & {
    body?: import('react-native').StyleProp<import('react-native').TextStyle>;
    marks?: ReadonlyArray<ProseMark | false | null | undefined>;
    level?: 1 | 2 | 3 | 4 | 5 | 6;
    fade?: import('react-native').TextStyle;
    children?: React.ReactNode;
}) {
    const t = useTheme() as Record<string, { val: string } | undefined>;
    const scale = useTextScale();
    const marked = (marks ?? []).map(mark => {
        switch (mark) {
            case 'strong': return { fontFamily: SEMIBOLD, color: t.ink?.val };
            case 'emphasis': return { fontFamily: SEMIBOLD };
            case 'code': return { fontFamily: MONO, color: t.secondary?.val };
            case 'link': return { textDecorationLine: 'underline' as const };
            case 'brass': return { color: t.needsYou?.val };
            case 'viewer': return { fontFamily: SEMIBOLD, backgroundColor: t.highlight?.val };
            case 'quiet': return { color: t.secondary?.val };
            default: return null;
        }
    });
    const heading = level ? HEADING_LEVELS[level - 1] : undefined;
    const levelStyle = heading ? { ...typeStyle(heading[0], scale), color: t[heading[1]]?.val } : null;
    return <Text {...rest} style={points([body, ...marked, levelStyle, fade]) as any}>{children}</Text>;
}

/**
 * A native text field owned by another module (HullDialogInput) that takes its
 * placeholder ink as a colour string: draws `input` with the theme value of
 * `placeholderInk` (default secondary). `<Placeheld input={HullDialogInput} placeholder="Search" … />`.
 */
export function Placeheld<P extends { placeholderTextColor?: unknown }>({ input: Input, placeholderInk = 'secondary', ...rest }: {
    input: React.ComponentType<P>; placeholderInk?: ColorToken;
} & Omit<P, 'placeholderTextColor'>) {
    const ink = (useTheme() as Record<string, { val: string } | undefined>)[placeholderInk]?.val;
    return <Input {...(rest as unknown as P)} placeholderTextColor={ink} />;
}

/**
 * A scannable code: dark modules on a white plate in every theme (a scanner
 * needs the contrast, so these inks are not chrome). `count` modules a side,
 * `dark(row, col)` says which are set, `module` is a module's size in points
 * and the quiet zone is one module. With no `dark`, the same-size empty plate.
 * `<QrTiles count={m.size} dark={(r, c) => m.get(r, c) === 1} module={6} />`.
 */
export function QrTiles({ count, dark, module, size, testID }: {
    count: number; dark?: (row: number, col: number) => boolean; module: number; size?: number; testID?: string;
}) {
    if (!dark) {
        return <YStack width={size} height={size} backgroundColor={QR_PAPER} borderRadius="sm" borderWidth={0.5} borderColor="secondary" testID={testID} />;
    }
    return (
        <YStack backgroundColor={QR_PAPER} padding={module} borderRadius="sm" testID={testID}>
            {Array.from({ length: count }, (_, row) => (
                <XStack key={row}>
                    {Array.from({ length: count }, (_, col) => (
                        <YStack key={col} width={module} height={module} backgroundColor={dark(row, col) ? QR_INK : QR_PAPER} />
                    ))}
                </XStack>
            ))}
        </YStack>
    );
}

/**
 * Letters drawn as art inside an SVG (react-native-svg `Text`, e.g. a person's
 * initial on their tile): one type style's face at a size in the drawing's own
 * viewBox units, so it scales with the tile, not with Text size.
 * `<DrawnType view={SvgText} v="heading" size={56} x={50} y={69} fill={…}>M</DrawnType>`.
 */
export function DrawnType<P extends object>({ view: View, v = 'heading', size, ...rest }: {
    view: React.ComponentType<P>; v?: Variant; size: number;
} & Omit<P, 'fontSize' | 'fontFamily'>) {
    return <View {...(rest as unknown as P)} fontSize={size} fontFamily={TYPE_SCALE[v].face} />;
}

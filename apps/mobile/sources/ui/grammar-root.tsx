import React from 'react';
import * as Native from 'react-native';
import { View, type ViewProps } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Reanimated, { useAnimatedStyle } from 'react-native-reanimated';
import { canvasColor } from '@/buzz/groknight';
import { useTheme } from 'tamagui';
import { typeStyle, useTextScale, type ColorToken, type Variant } from './grammar';

/**
 * The app root, mounted above the grammar's theme (part of the grammar, kept
 * apart so screens and their tests do not load the gesture runtime): fills the
 * window on the canvas colour of the current mode and colour set. Desktop
 * windows keep their own chrome.
 */
export function AppRoot({ children, desktop, mode, palette, ...rest }: React.ComponentProps<typeof GestureHandlerRootView> & { desktop: boolean; mode: 'light' | 'dark'; palette: 'brass' | 'stone' }) {
    const canvas = canvasColor(mode, palette);
    return <GestureHandlerRootView {...rest} style={desktop ? { flex: 1 } : { flex: 1, backgroundColor: canvas }}>{children}</GestureHandlerRootView>;
}

/**
 * A list's own cell host (FlatList `CellRendererComponent`): a plain view that
 * forwards the layout props the list hands its cells untouched.
 */
export function ListCell(props: ViewProps) {
    return <View {...props} />;
}

/**
 * A screen's keyboard-avoiding body: fills the space under the header and pads
 * its bottom by the keyboard, on every platform. It never moves, so nothing in
 * it draws over the header or takes the header's taps while the keyboard opens.
 * The padding reads the app-wide keyboard height, which is live even for a
 * screen that mounts while the keyboard is still closing, so no inset from the
 * previous screen is left behind.
 */
export function KeyboardBody({ children }: { children?: React.ReactNode }) {
    const { height } = useReanimatedKeyboardAnimation();
    const pad = useAnimatedStyle(() => ({ paddingBottom: -height.value }));
    return <Reanimated.View style={[KEYBOARD_BODY, pad]}>{children}</Reanimated.View>;
}
const KEYBOARD_BODY = { flex: 1 } as const;

/**
 * A raw React Native text field, and its hidden measuring twin, in one grammar
 * type style: for a field that reads its own native line metrics (the message
 * composer). `line` keeps the style's line height ('type'), unsets it
 * ('unset': Android inline spans re-measure per span) or sets one below the
 * face's glyph bounds (a number, web). `centered` drops Android's font padding
 * and centres the line; `hidden` lays it out of sight under another view.
 */
type NativeTypeProps = { v?: Variant; line?: 'type' | 'unset' | number; color?: ColorToken; centered?: boolean };
function nativeType({ v = 'body', line = 'type', color = 'ink' }: NativeTypeProps, scale: number, theme: Record<string, { val: string } | undefined>) {
    const type = typeStyle(v, scale);
    return {
        ...type,
        fontWeight: '400' as const,
        color: theme[color]?.val,
        lineHeight: line === 'type' ? type.lineHeight : line === 'unset' ? undefined : line,
    };
}
export function NativeTypeInput({ v, line, color, centered = false, hidden = false, box, translateY = 0, ref, ...rest }:
    Omit<Native.TextInputProps, 'style' | 'placeholderTextColor'> & NativeTypeProps & {
        ref?: React.Ref<Native.TextInput>; hidden?: boolean; translateY?: number;
        /** The field's own height bounds in points (it grows with its text). */
        box?: { height?: number; minHeight?: number; maxHeight?: number };
    }) {
    const theme = useTheme() as Record<string, { val: string } | undefined>;
    const scale = useTextScale();
    return (
        <Native.TextInput
            ref={ref}
            placeholderTextColor={theme.secondary?.val}
            {...rest}
            style={[
                nativeType({ v, line, color }, scale, theme),
                { minWidth: 0, paddingVertical: 0, textAlignVertical: 'top', outlineStyle: 'none', ...box } as unknown as Native.TextStyle,
                centered ? { includeFontPadding: false, textAlignVertical: 'center' } : null,
                { transform: [{ translateY }] },
                hidden ? { position: 'absolute', left: 0, right: 0, top: 0, opacity: 0 } : null,
            ]}
        />
    );
}
export function NativeTypeMeasure({ v, line, color, centered = false, fill = false, ...rest }:
    Omit<Native.TextProps, 'style'> & NativeTypeProps & {
        /** Lay out at the parent's full width, so the text wraps where the field does. */
        fill?: boolean;
    }) {
    const theme = useTheme() as Record<string, { val: string } | undefined>;
    const scale = useTextScale();
    return (
        <Native.Text
            {...rest}
            style={[
                nativeType({ v, line, color }, scale, theme),
                { position: 'absolute', opacity: 0 },
                fill ? { left: 0, right: 0 } : null,
                centered ? { includeFontPadding: false, textAlignVertical: 'center' } : null,
            ]}
        />
    );
}

/**
 * A pane's drag handle (PanResponder handlers need a React Native view): a
 * 7 pt column the parent's full height, straddling `edge` points from the
 * parent's left, under the col-resize cursor, stacked at `zIndex`.
 * `<PaneResizer edge={width} zIndex={10} {...pan.panHandlers} />`.
 */
export function PaneResizer({ edge, zIndex, ...rest }: Omit<ViewProps, 'style'> & { edge: number; zIndex: number }) {
    return <View {...rest} style={{ position: 'absolute', top: 0, bottom: 0, left: edge - 3, width: 7, cursor: 'col-resize', zIndex } as unknown as ViewProps['style']} />;
}

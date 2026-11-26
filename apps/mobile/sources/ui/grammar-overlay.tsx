import React, { useEffect } from 'react';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useWindowDimensions } from './window-dimensions';
import { lowerKeyboard } from '@/ui/lower-keyboard';
import { ListItem, ScrollView, Separator, XStack, YStack } from 'tamagui';
import { ArrowLeft, ChevronRight, X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { HullFloatingSurface, HullModal, useIsDesktop } from './overlay-host';
import { Btn, Copy, Glyph, HEIGHT, T, useStep } from './grammar';

const DESKTOP_SHEET_MAX_HEIGHT_FRACTION = 0.82;

/**
 * A screen's keyboard-avoiding body: fills the space under the header and pads
 * its bottom by the keyboard, on every platform. It never moves, so nothing in
 * it draws over the header or takes the header's taps while the keyboard opens.
 * The padding reads the app-wide keyboard height, which is live even for a
 * screen that mounts while the keyboard is still closing, so no inset from the
 * previous screen is left behind. Pass maxHeight for a content-sized sheet: its
 * scroll body shrinks when keyboard padding consumes the available height.
 */
export function KeyboardBody({ children, maxHeight }: { children?: React.ReactNode; maxHeight?: number }) {
    const { height } = useReanimatedKeyboardAnimation();
    const pad = useAnimatedStyle(() => ({ paddingBottom: -height.value }));
    return <Animated.View style={[maxHeight === undefined ? KEYBOARD_BODY : { maxHeight, flexShrink: 1 }, pad]}>{children}</Animated.View>;
}
const KEYBOARD_BODY = { flex: 1 } as const;

/** Measure a sheet only after opening, alongside its keyboard-aware body. */
function SheetKeyboardBody({ children }: { children: React.ReactNode }) {
    const { height } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const step = useStep();
    return <KeyboardBody maxHeight={height - insets.top - step('6')}>{children}</KeyboardBody>;
}

export type OverlaySheetProps = {
    open: boolean;
    close: () => void;
    title: string;
    testID?: string;
    children: React.ReactNode;
    back?: () => void;
    scrollable?: boolean;
    /** Optional footer pinned beneath the sheet body. */
    footer?: React.ReactNode;
    /** Optional maximum panel width (defaults to 480; desktop panels stay within 480–560px). */
    maxWidth?: number;
};

/**
 * The one unified sheet surface across phone and desktop:
 * - Compact phone viewports render a bottom-anchored sheet with 14px top corners,
 *   a 34x3px drag grip, safe-area padding, and live keyboard avoidance.
 * - Desktop/web viewports (`useIsDesktop`) render a centered, grip-less panel
 *   with 3px house corners, a strongStroke border, Escape/scrim dismissal, and
 *   shared React Native Modal stacking so `HullDialog` prompts always appear
 *   above open sheets without per-caller z-index overrides.
 */
export function OverlaySheet({
    open,
    close,
    title,
    testID,
    children,
    back,
    scrollable = false,
    footer,
    maxWidth = 480,
}: OverlaySheetProps) {
    const desktop = useIsDesktop();
    const insets = useSafeAreaInsets();
    const { height } = useWindowDimensions();
    const step = useStep();
    // Lower the keyboard as a sheet opens so a focused composer never covers it.
    useEffect(() => { if (open) lowerKeyboard(); }, [open]);
    const opened = React.useRef(false);
    if (open) opened.current = true;
    // Retain an opened sheet wrapper for native dismissal; unopened sheets mount nothing.
    if (!opened.current) return null;

    const content = scrollable ? (
        <ScrollView
            flexShrink={1}
            minHeight={0}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            testID={testID ? `${testID}-scroll` : undefined}
        >
            {children}
        </ScrollView>
    ) : children;

    return (
        <HullModal
            visible={open}
            onRequestClose={close}
            placement={desktop ? 'center' : 'bottom'}
            contentMaxWidth={maxWidth}
            contentMaxHeight={desktop ? Math.round(height * DESKTOP_SHEET_MAX_HEIGHT_FRACTION) : undefined}
            animationType={desktop ? 'fade' : 'slide'}
            keyboardAvoiding={desktop}
            accessibilityLabel={title ? `Close ${title}` : 'Close sheet'}
            testID={testID ? `${testID}-modal` : undefined}
        >
            {desktop ? (
                <HullFloatingSurface
                    width="100%"
                    borderRadius="house"
                    borderWidth={1}
                    borderColor="strongStroke"
                    testID={testID}
                >
                    <XStack
                        flexShrink={0}
                        gap={step('2')}
                        alignItems="center"
                        paddingHorizontal={step('4')}
                        paddingVertical={step('3')}
                        minHeight={HEIGHT.control}
                    >
                        {back ? <Btn kind="icon" label="Back" onPress={back}><Glyph icon={ArrowLeft} /></Btn> : null}
                        <T v="heading" flex={1} numberOfLines={1}>{title}</T>
                        <Btn kind="icon" label="Close" onPress={close} testID={testID ? `${testID}-close` : undefined}>
                            <Glyph icon={X} size={18} />
                        </Btn>
                    </XStack>
                    <Separator borderColor="stroke" />
                    <YStack flexShrink={1} minHeight={0} padding={step('4')} gap={step('2')}>
                        {content}
                    </YStack>
                    {footer ? (
                        <>
                            <Separator borderColor="stroke" />
                            <YStack paddingHorizontal={step('4')} paddingVertical={step('2')}>
                                {footer}
                            </YStack>
                        </>
                    ) : null}
                </HullFloatingSurface>
            ) : (
                <HullFloatingSurface
                    width="100%"
                    borderTopLeftRadius="viewer"
                    borderTopRightRadius="viewer"
                    borderBottomLeftRadius={0}
                    borderBottomRightRadius={0}
                    borderColor="stroke"
                    testID={testID}
                >
                    {/* The grip sits on the phone sheet's top edge. */}
                    <YStack
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                        height={18}
                        alignItems="center"
                        justifyContent="center"
                        testID={testID ? `${testID}-grip` : 'sheet-grip'}
                    >
                        <YStack width={34} height={3} borderRadius="house" backgroundColor="secondary" opacity={0.55} />
                    </YStack>
                    <SheetKeyboardBody>
                        {/* Text-size steps, then the device's physical bottom inset. */}
                        <YStack flexShrink={1} minHeight={0} padding={step('4')} paddingTop={0} paddingBottom={step('6') + insets.bottom} gap={step('2')}>
                            <XStack flexShrink={0} gap={step('2')} alignItems="center" paddingBottom={step('2')} minHeight={HEIGHT.control}>
                                {back ? <Btn kind="icon" label="Back" onPress={back}><Glyph icon={ArrowLeft} /></Btn> : null}
                                <T v="title" flex={1}>{title}</T>
                            </XStack>
                            {content}
                            {footer}
                        </YStack>
                    </SheetKeyboardBody>
                </HullFloatingSurface>
            )}
        </HullModal>
    );
}

/** Alias for `OverlaySheet`, kept for existing grammar callers. */
export const SheetFrame = OverlaySheet;

/** Scroll the detail body while its composer stays reachable below it. */
export function SheetScroll({ children }: { children: React.ReactNode }) {
    const { height } = useWindowDimensions();
    return <ScrollView flexShrink={1} minHeight={0} maxHeight={height * 0.7} keyboardShouldPersistTaps="handled">{children}</ScrollView>;
}

/** One sheet row: an optional icon column, a label and an optional quiet line, then a chevron when it opens a step. */
export function SheetRow({ icon, label, detail, onPress, testID, right, chevron = false, selected }: {
    /** The leading column; omit it for a row with no leading mark. */
    icon?: React.ReactNode; label: string; detail?: string; onPress: () => void; testID?: string; right?: React.ReactNode; chevron?: boolean; selected?: boolean;
}) {
    const step = useStep();
    return (
        <ListItem minHeight={HEIGHT.sheetRow} paddingHorizontal="0" paddingVertical={step('2')} gap={step('3')} justifyContent="flex-start" backgroundColor="raised" onPress={onPress} aria-label={selected !== undefined && detail ? `${label}, ${detail}` : label} accessibilityRole={selected === undefined ? 'button' : 'radio'} role={selected === undefined ? 'button' : 'radio'} aria-checked={selected} testID={testID}>
            {icon === undefined ? null : <YStack width={28} alignItems="center">{icon}</YStack>}
            <YStack flex={1} minWidth={0} gap={step(selected === undefined ? '1' : '0')}>
                <Copy>{label}</Copy>
                {detail ? <Copy small quiet>{detail}</Copy> : null}
            </YStack>
            {right}
            {chevron ? <Glyph icon={ChevronRight} size={16} /> : null}
        </ListItem>
    );
}

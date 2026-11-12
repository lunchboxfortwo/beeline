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
import { ArrowLeft, Check, ChevronRight, Copy as CopyIcon } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SCRIM } from '@/buzz/groknight';

/**
 * The one design grammar (build spec → "The grammar (one page)"). Six type
 * styles, ten colour tokens plus one scrim, eight spacing steps, four radii,
 * fixed control heights and one icon style. `scripts/check-mobile-grammar.mjs`
 * fails CI on any value outside it.
 */

export { SCRIM };

/** Control heights: every control, the one primary action, the tab bar, a sheet row. */
export const HEIGHT = { control: 44, primary: 48, tabBar: 52, sheetRow: 56 } as const;

export type Variant = 'title' | 'heading' | 'body' | 'meta' | 'metaStrong' | 'code';
// Loaded font faces (app/_layout.tsx); Tamagui types only know its font tokens.
const REGULAR = 'SpaceGrotesk-Regular' as any;
const SEMIBOLD = 'SpaceGrotesk-SemiBold' as any;
const MONO = 'IBMPlexMono-Regular' as any;
const scale: Record<Variant, { fontSize: any; lineHeight: any; fontFamily: any }> = {
    title: { fontSize: '2xl', lineHeight: '2xl', fontFamily: SEMIBOLD },
    heading: { fontSize: 'base', lineHeight: 'base', fontFamily: SEMIBOLD },
    body: { fontSize: 'base', lineHeight: 'base', fontFamily: REGULAR },
    meta: { fontSize: 'sm', lineHeight: 'sm', fontFamily: REGULAR },
    metaStrong: { fontSize: 'sm', lineHeight: 'sm', fontFamily: SEMIBOLD },
    code: { fontSize: 'sm', lineHeight: 'sm', fontFamily: MONO },
};

type TextProps = React.ComponentProps<typeof Text>;
/** The whole type scale. Nothing else may set a font, size or weight. */
export function T({ v = 'body', children, ...rest }: { v?: Variant; children?: React.ReactNode } & Omit<TextProps, 'fontSize' | 'fontFamily' | 'fontWeight' | 'lineHeight'>) {
    return <Text {...scale[v]} fontWeight="400" flexShrink={1} color="ink" {...rest}>{children}</Text>;
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
    return (
        <YStack gap="2" testID={testID}>
            <XStack gap="2" alignItems="baseline" flexWrap="wrap">
                <T v="metaStrong" color="secondary">{title}</T>
                {note ? <Copy small quiet>{note}</Copy> : null}
            </XStack>
            <Card backgroundColor="raised" borderWidth={1} borderColor="stroke" paddingHorizontal="3" paddingVertical="1">{children}</Card>
        </YStack>
    );
}

/** Label, value or second line, chevron if it opens. */
export function Row({ label, value, detail, icon, leading, onPress, last, right, testID, tone }: {
    label: string; value?: string; detail?: string; icon?: IconComponent; leading?: React.ReactNode;
    onPress?: () => void; last?: boolean; right?: React.ReactNode; testID?: string; tone?: 'removed';
}) {
    const body = (
        <XStack gap="3" alignItems="flex-start" paddingVertical="3" flexGrow={1} flexShrink={1} minWidth={0}>
            {leading}
            {icon ? <YStack paddingTop="0.5"><Glyph icon={icon} size={18} /></YStack> : null}
            <YStack flex={1} minWidth={0} gap="1">
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

/** Back and title on pushed pages (phone); desktop panels close with the same control. */
export function ScreenHeader({ title, back, right, backLabel = 'Back' }: { title: string; back?: () => void; right?: React.ReactNode; backLabel?: string }) {
    return (
        <>
            <XStack paddingHorizontal="3" paddingTop="3" paddingBottom="2" gap="2" alignItems="center" backgroundColor="canvas">
                {back ? <Btn kind="icon" label={backLabel} onPress={back}><Glyph icon={ArrowLeft} /></Btn> : null}
                <XStack flex={1} minWidth={0}><Copy strong numberOfLines={1}>{title}</Copy></XStack>
                {right}
            </XStack>
            <Separator borderColor="stroke" />
        </>
    );
}

/** A pushed page: header, then a scrolling column of sections. */
export function Screen({ title, back, children, testID, right }: { title: string; back?: () => void; children: React.ReactNode; testID?: string; right?: React.ReactNode }) {
    return (
        <YStack flex={1} minHeight={0} backgroundColor="canvas" testID={testID}>
            <ScreenHeader title={title} back={back} right={right} />
            <ScrollView flex={1} minHeight={0} keyboardShouldPersistTaps="handled">
                <YStack padding="4" gap="5" paddingBottom="8">{children}</YStack>
            </ScrollView>
        </YStack>
    );
}

/** The one sheet frame: scrim, handle, title, one step deep with Back. */
export function SheetFrame({ open, close, title, testID, children, back }: {
    open: boolean; close: () => void; title: string; testID?: string; children: React.ReactNode; back?: () => void;
}) {
    const theme = useThemeName();
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
                    <YStack padding="4" paddingTop="3" paddingBottom="6" gap="2">
                        <XStack gap="2" alignItems="center" paddingBottom="2" minHeight={HEIGHT.control}>
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
    return (
        <ListItem minHeight={HEIGHT.sheetRow} paddingHorizontal="0" paddingVertical="2" gap="3" justifyContent="flex-start" backgroundColor="raised" onPress={onPress} aria-label={label} accessibilityRole="button" testID={testID}>
            <YStack width={28} alignItems="center">{icon}</YStack>
            <YStack flex={1} minWidth={0} gap="1">
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

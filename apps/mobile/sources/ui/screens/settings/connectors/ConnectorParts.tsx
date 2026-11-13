import React from 'react';
import { Card, ListItem, ScrollView, Separator, XStack, YStack } from 'tamagui';
import { ChevronDown, ChevronRight, ChevronUp, Search } from 'lucide-react-native';
import { Btn, Copy, Glyph, HEIGHT, SafeBottom, SafeTop, ScreenHeader, T } from '@/ui/grammar';
import { desktopColumnWidths } from '@/buzz/desktop-layout-tokens';
import { useIsDesktop } from '@/utils/responsive';

/**
 * Settings → Connectors pages (build spec → Settings, KeyScreen frame): one
 * pushed-page frame, one row and one inline confirmation, all from the grammar.
 */
export function ConnectorFrame({ title, back, backLabel = 'Back', testID, scrollTestID, children, footer, scroll = true }: {
    title: string; back?: () => void; backLabel?: string; testID?: string; scrollTestID?: string;
    children: React.ReactNode; footer?: React.ReactNode; scroll?: boolean;
}) {
    const desktop = useIsDesktop();
    return (
        <YStack flex={1} minHeight={0} backgroundColor="canvas" testID={testID}>
            {desktop ? null : <SafeTop />}
            <YStack flex={1} minHeight={0} width="100%" maxWidth={desktop ? desktopColumnWidths.detail : undefined} alignSelf="center">
                <ScreenHeader title={title} back={back} backLabel={backLabel} />
                {scroll
                    ? <ScrollView flex={1} minHeight={0} keyboardShouldPersistTaps="handled" testID={scrollTestID}>
                        <YStack padding="4" gap="5" paddingBottom="8">{children}</YStack>
                    </ScrollView>
                    : <YStack flex={1} minHeight={0}>{children}</YStack>}
                {footer}
            </YStack>
            {desktop ? null : <SafeBottom />}
        </YStack>
    );
}

/** A footer under a page: the one primary action and its note. */
export function ConnectorFooter({ children }: { children: React.ReactNode }) {
    return (
        <>
            <Separator borderColor="stroke" />
            <YStack padding="4" gap="2" backgroundColor="canvas">{children}</YStack>
        </>
    );
}

export type ConnectorRowProps = {
    title: string;
    description?: string;
    descriptionTone?: 'danger';
    /** Replaces the second line when it needs more than plain text. */
    descriptionContent?: React.ReactNode;
    leading?: React.ReactNode;
    value?: string;
    valueTone?: 'danger' | 'accent';
    /** One word on a button, for a row that acts on the thing it names (Reconnect, Connect). */
    action?: string;
    chevron?: 'right' | 'up' | 'down';
    tone?: 'destructive' | 'quiet';
    disabled?: boolean;
    onPress?: () => void;
    trailing?: React.ReactNode;
    last?: boolean;
    testID?: string;
};

const CHEVRONS = { right: ChevronRight, up: ChevronUp, down: ChevronDown } as const;

/** Mark, name, second line, value or action, chevron when it opens. */
export function ConnectorRow({ title, description, descriptionTone, descriptionContent, leading, value, valueTone, action, chevron, tone, disabled, onPress, trailing, last, testID }: ConnectorRowProps) {
    // With an action on the right, the value (an error) moves under the name.
    const valueLine = <T v="meta" color={valueTone === 'danger' ? 'removed' : valueTone === 'accent' ? 'needsYou' : 'secondary'}>{value}</T>;
    const body = (
        <XStack gap="3" alignItems="center" paddingVertical="3" flexGrow={1} flexShrink={1} minWidth={0}>
            {leading}
            <YStack flex={1} minWidth={0} gap="1">
                {tone === 'destructive' ? <T v="heading" color="removed">{title}</T> : <Copy quiet={tone === 'quiet'}>{title}</Copy>}
                {descriptionContent ?? (description ? <T v="meta" color={descriptionTone === 'danger' ? 'removed' : 'secondary'}>{description}</T> : null)}
                {action && value ? valueLine : null}
            </YStack>
            {action
                ? <Btn kind="primary" size="sm" minHeight={HEIGHT.control} label={`${action} ${title}`} disabled={disabled} onPress={onPress}>{action}</Btn>
                : value ? <YStack maxWidth="50%">{valueLine}</YStack> : null}
            {trailing}
            {chevron && onPress ? <Glyph icon={CHEVRONS[chevron]} size={16} /> : null}
        </XStack>
    );
    return (
        <>
            {onPress
                ? <ListItem padding="0" minHeight={HEIGHT.control} backgroundColor="raised" disabled={disabled} opacity={disabled ? 0.5 : 1}
                    onPress={onPress} aria-label={title} accessibilityRole="button" testID={testID}>{body}</ListItem>
                : <YStack testID={testID}>{body}</YStack>}
            {last ? null : <Separator borderColor="stroke" />}
        </>
    );
}

/** A card of rows with no section label (a page's top status row). */
export function ConnectorCard({ children, testID }: { children: React.ReactNode; testID?: string }) {
    return <Card backgroundColor="raised" borderWidth={1} borderColor="stroke" paddingHorizontal="3" paddingVertical="1" testID={testID}>{children}</Card>;
}

/** A quiet line under or between sections. */
export function ConnectorNote({ children, testID, tone }: { children: React.ReactNode; testID?: string; tone?: 'danger' }) {
    return <T v="meta" color={tone === 'danger' ? 'removed' : 'secondary'} testID={testID}>{children}</T>;
}

/** The pressable search field that opens the search sheet. */
export function ConnectorSearchField({ label, onPress, testID }: { label: string; onPress: () => void; testID?: string }) {
    return (
        <ListItem padding="0" paddingHorizontal="3" gap="2" minHeight={HEIGHT.control} borderRadius="md" borderWidth={1} borderColor="strongStroke"
            backgroundColor="canvas" onPress={onPress} aria-label={label} accessibilityRole="search" testID={testID}>
            <Glyph icon={Search} size={16} />
            <YStack flex={1} minWidth={0}><Copy quiet numberOfLines={1}>{label}</Copy></YStack>
        </ListItem>
    );
}

/** An inline confirmation card: the question, Cancel, and the destructive action. */
export function ConfirmCard({ question, confirmLabel, busy, onCancel, onConfirm, testID }: {
    question: string; confirmLabel: string; busy?: boolean; onCancel: () => void; onConfirm: () => void; testID?: string;
}) {
    return (
        <Card backgroundColor="raised" borderWidth={1} borderColor="strongStroke" padding="4" gap="3" testID={testID}>
            <Copy>{question}</Copy>
            <XStack gap="2" justifyContent="flex-end">
                <Btn label="Cancel" disabled={busy} onPress={onCancel} testID={testID ? `${testID}-no` : undefined}>Cancel</Btn>
                <Btn kind="destructive" label={confirmLabel} disabled={busy} onPress={onConfirm} testID={testID ? `${testID}-yes` : undefined}>{confirmLabel}</Btn>
            </XStack>
        </Card>
    );
}

/** Loading: the page's loading mark (SurfaceGlyphLoader), centred, with an optional line. */
export function ConnectorLoading({ children, testID, label }: { children: React.ReactNode; testID?: string; label?: string }) {
    return (
        <YStack alignItems="center" justifyContent="center" gap="2" paddingVertical="8" testID={testID}>
            {children}
            {label ? <ConnectorNote>{label}</ConnectorNote> : null}
        </YStack>
    );
}

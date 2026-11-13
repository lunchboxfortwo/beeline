import React from 'react';
import { Card, ListItem, XStack, YStack } from 'tamagui';
import { X } from 'lucide-react-native';
import { Btn, Glyph, HEIGHT, T } from '@/ui/grammar';

/**
 * The composer's suggestion card (build spec → Composer and suggestions): a
 * plain-sentence header over rows of a 28 px mark, a name and one quiet line.
 * It sits above the field; the six-row cap lives in the suggestion hooks.
 * Above the keyboard the card shrinks first, so the field never drops under it.
 */

/** One row's fixed height, also the unit of a menu's scroll window. */
export const SUGGESTION_ROW_HEIGHT = HEIGHT.sheetRow;

type IconComponent = React.ComponentProps<typeof Glyph>['icon'];

export function SuggestionCard({ title, label, testID, onDismiss, dismissTestID, overflow, overflowTestID, children }: {
    title: string; label: string; testID: string; onDismiss?: () => void; dismissTestID?: string;
    overflow?: number; overflowTestID?: string; children: React.ReactNode;
}) {
    return (
        <Card backgroundColor="canvas" borderWidth={1} borderColor="strongStroke" borderRadius="md" paddingHorizontal="3" paddingVertical="2" marginBottom="2" overflow="hidden" flexShrink={1} minHeight={0} aria-label={label} testID={testID}>
            <XStack alignItems="center" gap="2">
                <YStack flex={1} minWidth={0} paddingVertical="1"><T v="metaStrong" color="secondary" numberOfLines={1}>{title}</T></YStack>
                {onDismiss ? <Btn kind="icon" label="Dismiss commands" onPress={onDismiss} testID={dismissTestID}><Glyph icon={X} size={16} /></Btn> : null}
            </XStack>
            {children}
            {overflow ? (
                <YStack paddingTop="1" testID={overflowTestID}>
                    <T v="meta" color="secondary">and {overflow} {overflow === 1 ? 'other' : 'others'}</T>
                </YStack>
            ) : null}
        </Card>
    );
}

/** A token's mark: a small framed glyph, brass because it inserts what you pick. */
export function SuggestionGlyph({ icon }: { icon: IconComponent }) {
    return (
        <YStack width={28} height={28} borderRadius="sm" borderWidth={1} borderColor="strongStroke" alignItems="center" justifyContent="center">
            <Glyph icon={icon} size={14} accent />
        </YStack>
    );
}

export function SuggestionRow({ mark, name, nameAccent = false, detail, trailing, selected, first, label, role = 'button', state, onPress, testID }: {
    mark?: React.ReactNode; name: string; nameAccent?: boolean; detail?: string; trailing?: React.ReactNode;
    selected: boolean; first: boolean; label: string; role?: 'button' | 'checkbox' | 'switch';
    state: { selected?: boolean; checked?: boolean }; onPress: () => void; testID: string;
}) {
    return (
        <ListItem
            minHeight={HEIGHT.sheetRow}
            height={SUGGESTION_ROW_HEIGHT}
            padding="0"
            paddingHorizontal={mark ? "1" : "0"}
            gap="3"
            alignItems="center"
            justifyContent="flex-start"
            borderRadius="sm"
            borderTopWidth={first ? 0 : 1}
            borderColor="stroke"
            backgroundColor={selected ? 'highlight' : 'canvas'}
            onPress={onPress}
            aria-label={label}
            accessibilityRole={role}
            accessibilityState={state}
            testID={testID}
        >
            {mark ? <YStack width={28} alignItems="center">{mark}</YStack> : null}
            <YStack flex={1} minWidth={0}>
                <T v="metaStrong" color={nameAccent ? 'needsYou' : 'ink'} numberOfLines={1}>{name}</T>
                {detail ? <T v="meta" color="secondary" numberOfLines={1}>{detail}</T> : null}
            </YStack>
            {trailing}
        </ListItem>
    );
}

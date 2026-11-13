import React from 'react';
import { Separator, XStack, YStack } from 'tamagui';
import { Copy, T } from '@/ui/grammar';

/** The day caption over a day's first row: meta, secondary, sentence case ("Today"). */
export function DayCaption({ label }: { label: string }) {
    return (
        <YStack paddingVertical="3">
            <Copy small quiet testID="ledger-day-caption">{label}</Copy>
        </YStack>
    );
}

/** Where the unread run begins: brass "New" on a stroke rule. */
export function NewMessagesRule() {
    return (
        <XStack gap="2" alignItems="center" paddingVertical="3" accessibilityLabel="Unread messages begin here" accessibilityRole="text" testID="new-messages-divider">
            <T v="metaStrong" color="needsYou">New</T>
            <Separator flex={1} borderColor="stroke" />
        </XStack>
    );
}

/** Paging state inside the transcript: one quiet centred line. */
export function HistoryLine({ text }: { text: string }) {
    return (
        <YStack paddingVertical="3" alignItems="center" testID="transcript-history-status">
            <Copy small quiet>{text}</Copy>
        </YStack>
    );
}

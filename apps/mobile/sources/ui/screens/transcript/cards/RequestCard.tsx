import { WorkStateMark } from '@/ui/screens/tags/WorkMarks';
import React from 'react';
import { AtSign } from 'lucide-react-native';
import { Card, XStack, YStack } from 'tamagui';
import { Copy, Glyph, T, typeStyle, useTextSize } from '@/ui/grammar';

/**
 * An agent's question to you (build spec, thread frame): a card on the
 * highlight surface whose first line is the ask, in brass after an @ glyph;
 * what the ask carries (an attached image or file) stacks under it.
 */
export function RequestFrame({ ask, children, testID }: { ask: string; children?: React.ReactNode; testID?: string }) {
    const bodyLine = typeStyle('body', useTextSize()).lineHeight;
    return (
        <Card backgroundColor="highlight" borderWidth={1} borderColor="stroke" borderRadius="md" padding="3" gap="3" testID={testID}>
            <XStack gap="2" alignItems="flex-start">
                <YStack height={bodyLine} justifyContent="center"><Glyph icon={AtSign} size={16} accent /></YStack>
                <YStack flex={1} minWidth={0}><Copy accent>{ask}</Copy></YStack>
            </XStack>
            {children}
        </Card>
    );
}

export function SettledLine({ children, failed = false, testID }: { children: React.ReactNode; failed?: boolean; testID?: string }) {
    const metaLine = typeStyle('meta', useTextSize()).lineHeight;
    return (
        <XStack gap="2" alignItems="flex-start">
            {failed ? null : <YStack height={metaLine} justifyContent="center"><WorkStateMark state="done" size={16} /></YStack>}
            <YStack flex={1} minWidth={0}>
                {failed ? <T v="meta" color="removed" testID={testID}>{children}</T> : <Copy small quiet testID={testID}>{children}</Copy>}
            </YStack>
        </XStack>
    );
}

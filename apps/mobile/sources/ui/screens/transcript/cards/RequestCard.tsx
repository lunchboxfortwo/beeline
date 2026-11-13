import React from 'react';
import { Card, XStack, YStack } from 'tamagui';
import { AtSign, Check } from 'lucide-react-native';
import { Copy, Glyph, T } from '@/ui/grammar';

/**
 * An agent's question to you (build spec, thread frame): a card on the
 * highlight surface whose first line is the ask, in brass after an @ glyph;
 * what the ask carries (an attached image or file) stacks under it.
 */
export function RequestFrame({ ask, children, testID }: { ask: string; children?: React.ReactNode; testID?: string }) {
    return (
        <Card backgroundColor="highlight" borderWidth={1} borderColor="stroke" borderRadius="md" padding="3" gap="3" testID={testID}>
            <XStack gap="2" alignItems="flex-start">
                <YStack paddingTop="0.5"><Glyph icon={AtSign} size={16} accent /></YStack>
                <YStack flex={1} minWidth={0}><Copy accent>{ask}</Copy></YStack>
            </XStack>
            {children}
        </Card>
    );
}

/** A decided request's one quiet line: a check, then who decided and when. */
export function SettledLine({ children, failed = false, testID }: { children: React.ReactNode; failed?: boolean; testID?: string }) {
    return (
        <XStack gap="2" alignItems="center">
            {failed ? null : <Glyph icon={Check} size={16} />}
            <YStack flex={1} minWidth={0}>
                {failed ? <T v="meta" color="removed" testID={testID}>{children}</T> : <Copy small quiet testID={testID}>{children}</Copy>}
            </YStack>
        </XStack>
    );
}

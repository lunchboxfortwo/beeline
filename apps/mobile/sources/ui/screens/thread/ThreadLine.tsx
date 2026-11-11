import React from 'react';
import { ListItem, YStack } from 'tamagui';
import { CornerDownRight } from 'lucide-react-native';
import type { CornerState } from '@beeline/api-contract/phone';
import { Copy, Glyph, HEIGHT } from '@/ui/grammar';
import { threadListWord } from './thread-status';

/** One thread under its chat: ↳, the title, and its state word (brass when it waits on you). */
export function ThreadLine({ title, state, onPress, testID }: {
    title: string; state: CornerState; onPress: () => void; testID?: string;
}) {
    const brass = state === 'waiting';
    const word = threadListWord(state);
    return (
        <ListItem
            padding="0" paddingVertical="2" gap="2" minHeight={HEIGHT.control}
            alignItems="flex-start" justifyContent="flex-start" backgroundColor="transparent"
            onPress={onPress} aria-label={`Thread ${title}, ${word}`} accessibilityRole="button" testID={testID}
        >
            <YStack paddingTop="0.5"><Glyph icon={CornerDownRight} size={16} accent={brass} /></YStack>
            <YStack flex={1} minWidth={0} gap="1">
                <Copy>{title}</Copy>
                <Copy small accent={brass} quiet={!brass}>{word}</Copy>
            </YStack>
        </ListItem>
    );
}

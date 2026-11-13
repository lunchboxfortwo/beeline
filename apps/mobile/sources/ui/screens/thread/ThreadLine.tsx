import { RepositoryMark } from '@/components/buzz/RepositoryMark';
import React from 'react';
import { ListItem, YStack } from 'tamagui';
import { CornerDownRight } from 'lucide-react-native';
import type { CornerBlocker, CornerState, CornerStateReason } from '@beeline/api-contract/phone';
import { Copy, Glyph, HEIGHT } from '@/ui/grammar';
import { threadListLabel } from './thread-status';

/**
 * One thread under its chat: repository mark or ↳, the title, and its state
 * line. A thread waiting on this viewer reads "waiting on you" in semibold;
 * one waiting on anyone else names them, quiet.
 */
export function ThreadLine({ title, state, blocker, reason, viewer, onPress, testID, avatarUrl, faviconUrl }: {
    avatarUrl?: string; faviconUrl?: string;
    title: string; state: CornerState; blocker?: CornerBlocker; reason?: CornerStateReason;
    /** The viewer's identity id; the waiting line names them "you". */
    viewer?: string;
    onPress: () => void; testID?: string;
}) {
    const { word, you: brass } = threadListLabel({ state, blocker, reason }, viewer);
    return (
        <ListItem
            padding="0" paddingVertical="2" gap="2" minHeight={HEIGHT.control}
            alignItems="flex-start" justifyContent="flex-start" backgroundColor="transparent"
            onPress={onPress} aria-label={`Thread ${title}, ${word}`} accessibilityRole="button" testID={testID}
        >
            <YStack paddingTop="0.5">{avatarUrl || faviconUrl ? <RepositoryMark avatarUrl={avatarUrl} faviconUrl={faviconUrl} size={16} /> : <Glyph icon={CornerDownRight} size={16} accent={brass} />}</YStack>
            <YStack flex={1} minWidth={0} gap="1">
                <Copy>{title}</Copy>
                <Copy small strong={brass} accent={brass} quiet={!brass}>{word}</Copy>
            </YStack>
        </ListItem>
    );
}

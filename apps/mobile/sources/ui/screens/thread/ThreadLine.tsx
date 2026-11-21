import React from 'react';
import { ListItem, YStack } from 'tamagui';
import { CornerDownRight } from 'lucide-react-native';
import type { CornerBlocker, CornerState, CornerStateReason, WorkState } from '@beeline/api-contract/phone';
import { Copy, Glyph, HEIGHT, MARK, typeStyle, useTextSize } from '@/ui/grammar';
import { WorkStateMark } from '@/ui/screens/tags/WorkMarks';
import { threadRow } from '@/ui/screens/chats/chat-tree-model';

/**
 * One thread in a chat's thread list: ↳, the title and its state line, then its state mark
 * on the right, both centred on the title's line. A thread waiting on this viewer reads
 * "waiting on you" in semibold; one waiting on anyone else names them, quiet.
 */
export function ThreadLine({ title, state, workState, blocker, reason, viewer, onPress, testID }: {
    title: string; state: CornerState; workState?: WorkState; blocker?: CornerBlocker; reason?: CornerStateReason;
    /** The viewer's identity id; the waiting line names them "you". */
    viewer?: string;
    onPress: () => void; testID?: string;
}) {
    const mark = threadRow({ state, workState, blocker, reason }, viewer);
    const { word, you: brass } = mark;
    const line = typeStyle('body', useTextSize()).lineHeight;
    return (
        <ListItem
            padding="0" paddingVertical="2" gap="2" minHeight={HEIGHT.control}
            alignItems="flex-start" justifyContent="flex-start" backgroundColor="transparent"
            onPress={onPress} aria-label={`Thread ${title}, ${word}`} accessibilityRole="button" testID={testID}
        >
            <YStack height={line} justifyContent="center"><Glyph icon={CornerDownRight} size={16} /></YStack>
            <YStack flex={1} minWidth={0} gap="1">
                <Copy>{title}</Copy>
                <Copy small strong={brass} accent={brass} quiet={!brass}>{word}</Copy>
            </YStack>
            <YStack width={MARK} height={line} flexShrink={0} alignItems="center" justifyContent="center" testID={testID ? `${testID}-state` : undefined}>
                <WorkStateMark state={mark.state} idle={mark.idle} />
            </YStack>
        </ListItem>
    );
}

import React from 'react';
import { XStack, YStack } from 'tamagui';
import { Bookmark } from 'lucide-react-native';
import { Glyph, HEIGHT, T } from '@/ui/grammar';
import { IdentityMark } from '@/components/buzz/IdentityMark';

/** The transcript face: 28 px, in a 44 px tap target (build spec → grammar, Heights). */
export const TRANSCRIPT_FACE_SIZE = 28;

export type TranscriptSenderMark = {
    /** The speaker's stable seed (pubkey); same seed, same mark as everywhere. */
    seed: string;
    kind: 'agent' | 'human';
    face?: string;
    avatarUrl?: string;
    /** Agents only: working right now → the ring. */
    alive?: boolean;
};

/** Who opens a sender group: face, name and time. Follow-ups omit it. */
export type TranscriptSender = {
    name?: string;
    stamp: string;
    mark?: TranscriptSenderMark;
    onOpenProfile?: () => void;
    /** Claims a long press before the face's own press can turn it into a tap. */
    onLongPress?: () => void;
    bookmarked?: boolean;
    feedbackReported?: boolean;
    /** True only for the viewer's own turn: the name is brass, the body stays ink. */
    isViewer?: boolean;
};

function SenderFace({ sender }: { sender: TranscriptSender }) {
    const mark = sender.mark;
    const face = mark ? (
        mark.kind === 'agent' ? (
            <IdentityMark seed={mark.seed} kind="agent" face={mark.face} avatarUrl={mark.avatarUrl} alive={Boolean(mark.alive)}
                name={sender.name} size={TRANSCRIPT_FACE_SIZE} testID="chat-byline-mark" />
        ) : (
            <IdentityMark seed={mark.seed} kind="human" face={mark.face} avatarUrl={mark.avatarUrl}
                name={sender.name} size={TRANSCRIPT_FACE_SIZE} testID="chat-byline-mark" />
        )
    ) : null;
    if (!sender.onOpenProfile) {
        return <YStack width={HEIGHT.control} alignItems="flex-start">{face}</YStack>;
    }
    return (
        <YStack
            width={HEIGHT.control}
            minHeight={HEIGHT.control}
            alignItems="flex-start"
            cursor="pointer"
            onPress={sender.onOpenProfile}
            onLongPress={sender.onLongPress}
            accessibilityRole="button"
            aria-label={`Open ${sender.name ?? 'agent'} profile`}
            testID="chat-byline-profile"
        >
            {face}
        </YStack>
    );
}

/**
 * One transcript line: the same rule for people and agents. The face, the name
 * (metaStrong) and the time (meta, secondary) open a sender group; follow-ups
 * sit in the same column under it with an empty face column.
 */
export function TranscriptLine({ sender, children, testID }: {
    sender?: TranscriptSender;
    children?: React.ReactNode;
    testID?: string;
}) {
    return (
        // The 28 px face sits at the column edge inside its 44 px tap area, which
        // also spaces the words from it.
        <XStack gap="0" alignItems="flex-start" width="100%" minWidth={0} testID={testID}>
            {sender ? <SenderFace sender={sender} /> : <YStack width={HEIGHT.control} />}
            <YStack flex={1} minWidth={0} gap="2">
                {sender ? (
                    <XStack gap="2" alignItems="baseline" minWidth={0} testID="chat-byline-words">
                        {sender.name ? (
                            <T v="metaStrong" color={sender.isViewer ? 'needsYou' : 'ink'} numberOfLines={1} testID="chat-byline-name">{sender.name}</T>
                        ) : null}
                        <T v="meta" color="secondary" numberOfLines={1} testID="chat-byline-stamp">{sender.stamp}</T>
                        {sender.feedbackReported ? (
                            <T v="meta" color="secondary" aria-label="Reported to Beeline" testID="chat-reported-marker">Reported</T>
                        ) : null}
                        {sender.bookmarked ? (
                            <YStack aria-label="Bookmarked" testID="chat-bookmark-marker"><Glyph icon={Bookmark} size={14} accent /></YStack>
                        ) : null}
                    </XStack>
                ) : null}
                {children}
            </YStack>
        </XStack>
    );
}

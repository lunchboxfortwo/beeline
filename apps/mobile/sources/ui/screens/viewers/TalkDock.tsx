import React from 'react';
import { Card, ScrollView, XStack, YStack } from 'tamagui';
import { MessagesSquare } from 'lucide-react-native';
import { Btn, Copy, Glyph, HEIGHT, T } from '@/ui/grammar';

export type TalkDockEntry = { id: string; speaker: string; text: string; mine: boolean; context?: string };

/**
 * Talk to agent (build spec → Viewers): a pill at the bottom right that opens
 * into a raised card with the recent conversation, what the viewer is looking
 * at, and the field. Positions come from the mechanics file, which owns the
 * keyboard lift.
 */
export function TalkDock({ open, onToggle, bottom, maxTranscriptHeight, heading, entries, showTranscript, error, contextLabel, composer }: {
    open: boolean;
    onToggle: () => void;
    /** Distance from the viewer's bottom edge, keyboard and home indicator included. */
    bottom: number;
    maxTranscriptHeight: number;
    heading: string;
    entries: readonly TalkDockEntry[];
    showTranscript: boolean;
    error: string | null;
    /** What this viewer shows, said with the message. */
    contextLabel?: string;
    composer: React.ReactNode;
}) {
    const scroll = React.useRef<{ scrollToEnd(options?: { animated?: boolean }): void } | null>(null);
    const lines = entries.map((entry) => (
        <YStack key={entry.id} gap="1" testID="viewer-conversation-entry">
            <Copy small numberOfLines={open ? undefined : 2}>
                <T v="metaStrong" color={entry.mine ? 'needsYou' : 'ink'}>{`${entry.speaker}: `}</T>
                {entry.text}
            </Copy>
            {entry.context ? <ContextChip text={entry.context} /> : null}
        </YStack>
    ));
    return (
        <YStack position="absolute" top={0} left={0} right={0} bottom={0} zIndex={20} pointerEvents="box-none" testID="viewer-conversation-dock">
            <YStack position="absolute" right={12} left={open ? 12 : undefined} bottom={bottom} alignItems="flex-end" gap="2" pointerEvents="box-none">
                {showTranscript || open ? (
                    <Card backgroundColor="raised" borderWidth={1} borderColor="strongStroke" padding="3" gap="2" alignSelf="stretch" testID="viewer-conversation-transcript">
                        {showTranscript ? (
                            <>
                                <Copy small quiet>{heading}</Copy>
                                {open ? (
                                    <ScrollView ref={scroll as never} maxHeight={maxTranscriptHeight} keyboardShouldPersistTaps="handled"
                                        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })} testID="viewer-conversation-scroll">
                                        <YStack gap="2">{lines}</YStack>
                                    </ScrollView>
                                ) : lines}
                                {error ? <T v="meta" color="removed" testID="viewer-conversation-error">{error}</T> : null}
                            </>
                        ) : null}
                        {open && contextLabel ? <ContextChip text={contextLabel} /> : null}
                        {open ? composer : null}
                    </Card>
                ) : null}
                <Btn kind="primary" label={open ? 'Collapse conversation' : 'Talk to agent'} accessibilityState={{ expanded: open }}
                    borderRadius="full" minHeight={HEIGHT.control} onPress={onToggle} testID="viewer-conversation-toggle">
                    <XStack gap="2" alignItems="center">
                        <Glyph icon={MessagesSquare} size={16} color="primaryInk" />
                        <T v="heading" color="primaryInk">{open ? 'Collapse' : 'Talk to agent'}</T>
                    </XStack>
                </Btn>
            </YStack>
        </YStack>
    );
}

/** What the reader was looking at when they spoke. */
export function ContextChip({ text }: { text: string }) {
    return (
        <XStack alignSelf="flex-start" paddingHorizontal="2" paddingVertical="1" borderRadius="full" borderWidth={1} borderColor="stroke">
            <Copy small quiet numberOfLines={1}>{text}</Copy>
        </XStack>
    );
}

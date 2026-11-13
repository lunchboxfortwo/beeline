import React from 'react';
import { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { Platform } from 'react-native';
import { ConversationGlyph } from '@/components/buzz/MicGlyph';
import { MonoMarkdown } from '@/components/buzz/MonoMarkdown';
import { Card, ScrollView, XStack, YStack } from 'tamagui';
import { MessagesSquare } from 'lucide-react-native';
import { Btn, Copy, Glyph, HEIGHT, T, Inked, Motion, TypedView } from '@/ui/grammar';

export type TalkDockEntry = { id: string; speaker: string; text: string; mine: boolean; context?: string };

/**
 * Talk to agent: a floating glyph for the browser, or a pill for artifacts, opening
 * into a raised card with the recent conversation, what the viewer is looking
 * at, and the field. Positions come from the mechanics file, which owns the
 * keyboard lift.
 */
export function TalkDock({ open, onToggle, bottom, maxTranscriptHeight, heading, entries, showTranscript, error, contextLabel, composer, compact, onPillHeightChange }: {
    open: boolean;
    compact?: boolean;
    onPillHeightChange?: (height: number) => void;
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
    const [availableWidth, setAvailableWidth] = React.useState(366);
    const [pillHeight, setPillHeight] = React.useState(44);
    const width = useSharedValue(44);
    React.useEffect(() => { width.value = withTiming(open ? Math.max(44, availableWidth) : 44, { duration: 220 }); }, [open, availableWidth, width]);
    const pillStyle = useAnimatedStyle(() => ({ width: width.value }));
    const scrollToNewest = () => { const run = () => scroll.current?.scrollToEnd({ animated: false }); if (Platform.OS === 'web') run(); else requestAnimationFrame(run); };
    const lines = entries.map((entry) => (
        <YStack key={entry.id} gap="1" testID="viewer-conversation-entry">
            <Copy small numberOfLines={open ? undefined : 2}>
                <T v="metaStrong" color={entry.mine ? 'needsYou' : 'ink'}>{`${entry.speaker}: `}</T>
                {entry.text}
            </Copy>
            {entry.context ? <ContextChip text={entry.context} /> : null}
        </YStack>
    ));
    if (compact) return (
        <YStack position="absolute" top={0} left={0} right={0} bottom={0} zIndex={20} pointerEvents="box-none" testID="viewer-conversation-dock"
            onLayout={event => setAvailableWidth(event.nativeEvent.layout.width - 24)}>
            {showTranscript ? <YStack position="absolute" left={16} right={16} bottom={bottom + pillHeight + 9} maxHeight={maxTranscriptHeight}
                padding="4" borderRadius="transcript" borderWidth={1} borderColor="strongStroke" backgroundColor="raised" overflow="hidden" testID="viewer-conversation-transcript">
                <Copy small quiet>{heading}</Copy>
                <ScrollView ref={scroll as never} maxHeight={maxTranscriptHeight} keyboardShouldPersistTaps="handled" onLayout={scrollToNewest} onContentSizeChange={scrollToNewest} testID="viewer-conversation-scroll">
                    {entries.map(entry => <YStack key={entry.id} marginTop="1" testID="viewer-conversation-entry"><T v="code" color="needsYou">{entry.speaker}</T>
                        {open ? <TypedView view={MonoMarkdown} v="body" markdown={entry.text}/> : <Copy numberOfLines={2}>{entry.text}</Copy>}
                        {entry.context ? <T v="code" color="secondary">{entry.context}</T> : null}</YStack>)}
                    {error ? <T color="removed">{error}</T> : null}
                </ScrollView>
            </YStack> : null}
            <YStack position="absolute" right={12} bottom={bottom} minHeight={44} borderRadius="viewer" overflow="hidden">
              <Motion motion={pillStyle} testID="viewer-conversation-pill"
                onLayout={event => { setPillHeight(event.nativeEvent.layout.height); onPillHeightChange?.(event.nativeEvent.layout.height); }}>
                <XStack flex={1} minHeight={44} borderRadius="viewer" borderWidth={1} borderColor="strongStroke" backgroundColor="raised" overflow="hidden" alignItems="center">
                    <Btn kind="icon" label={open ? 'Collapse conversation' : 'Talk to agent'} accessibilityState={{ expanded: open }} onPress={onToggle}
                        width={open ? 44 : 42} minWidth={open ? 44 : 42} height={open ? 'auto' : 42} viewerInset alignSelf="stretch" borderRadius={open ? 0 : 'viewer'}
                        borderRightWidth={open ? 1 : 0} borderColor="strongStroke" backgroundColor={open ? 'transparent' : 'canvas'} padding={0} testID="viewer-conversation-toggle">
                        <Inked glyph={ConversationGlyph} color={open ? 'needsYou' : 'ink'} size={20}/>
                    </Btn>
                    {open ? <YStack flex={1} minWidth={0}>{composer}</YStack> : null}
                </XStack>
              </Motion>
            </YStack>
        </YStack>
    );
    return (
        <YStack position="absolute" top={0} left={0} right={0} bottom={0} zIndex={20} pointerEvents="box-none" testID="viewer-conversation-dock">
            <YStack position="absolute" right={compact ? 24 : 12} left={open ? 12 : undefined} bottom={bottom} alignItems="flex-end" gap="2" pointerEvents="box-none">
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
                <Btn kind={compact ? 'icon' : 'primary'} label={open ? 'Collapse conversation' : 'Talk to agent'} accessibilityState={{ expanded: open }}
                    borderRadius="full" minHeight={HEIGHT.control} backgroundColor={compact ? 'raised' : undefined}
                    borderWidth={compact ? 1 : undefined} borderColor={compact ? 'strongStroke' : undefined}
                    onPress={onToggle} testID="viewer-conversation-toggle">
                    <XStack gap="2" alignItems="center">
                        <Glyph icon={MessagesSquare} size={16} color={compact ? 'ink' : 'primaryInk'} />
                        {compact ? null : <T v="heading" color="primaryInk">{open ? 'Collapse' : 'Talk to agent'}</T>}
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

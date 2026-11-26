import React from 'react';
import { ListItem, XStack, YStack } from 'tamagui';
import { ChevronRight } from 'lucide-react-native';
import { Glyph, HEIGHT, T, Spinner } from '@/ui/grammar';
import type { TranscriptCardChoice } from '@/components/buzz/ChoicePlate';

/**
 * One option of a question or poll, as the mock's decision card draws it:
 * a framed row, brass when it is the pick, its letter and label. An option has no sub label.
 * A closed poll keeps its vote count and a highlight wash for its share.
 */
export function ChoiceOption({ choice, closed }: { choice: TranscriptCardChoice; closed: boolean }) {
    const share = closed ? Math.max(0, Math.min(1, choice.share ?? 0)) : 0;
    const disabled = Boolean(choice.disabled || choice.busy);
    const testID = choice.testID ?? `transcript-card-choice-${choice.id}`;
    const body = (
        <XStack position="relative" gap="3" alignItems="flex-start" flex={1} minWidth={0}>
            <YStack width={28} height={28} borderRadius="sm" borderWidth={1}
                borderColor={choice.selected ? 'needsYou' : choice.costly ? 'removed' : 'strongStroke'}
                alignItems="center" justifyContent="center" testID={`transcript-card-choice-letter-${choice.id}`}>
                {choice.mark === 'chevron' ? <Glyph icon={ChevronRight} size={16} accent={choice.selected} />
                    : choice.mark === 'none' ? null
                        : <T v="metaStrong" color={choice.selected ? 'needsYou' : choice.costly ? 'removed' : 'ink'}>{choice.letter}</T>}
            </YStack>
            <XStack flex={1} minWidth={0} alignItems="center">
                <YStack width={0} height={28} />
                <T flex={1} minWidth={0} v={choice.leader ? 'heading' : 'body'} color={choice.disabled && !choice.busy ? 'secondary' : 'ink'}>{choice.label}</T>
            </XStack>
            {choice.busy ? (
                <YStack height={28} justifyContent="center">
                    <Spinner size="small" />
                </YStack>
            ) : null}
            {closed && choice.votes !== undefined ? (
                <YStack height={28} justifyContent="center">
                    <T v="meta" color={choice.leader ? 'needsYou' : 'secondary'} testID={`transcript-card-choice-count-${choice.id}`}>{choice.votes}</T>
                </YStack>
            ) : null}
        </XStack>
    );
    const pressable = Boolean(choice.onPress);
    const Frame = (pressable ? ListItem : XStack) as typeof XStack;
    return (
        <Frame position="relative" padding="3" borderRadius="md" borderWidth={1} overflow="hidden" alignItems="center"
            borderColor={choice.selected ? 'needsYou' : closed ? 'stroke' : 'strongStroke'}
            backgroundColor={choice.selected ? 'highlight' : 'canvas'}
            minHeight={pressable ? HEIGHT.control : undefined}
            onPress={choice.onPress} disabled={pressable ? disabled : undefined}
            opacity={choice.disabled && !choice.busy ? 0.5 : 1}
            accessibilityRole={pressable ? 'button' : undefined}
            aria-label={pressable ? `${choice.letter}. ${choice.label}` : undefined}
            aria-busy={pressable ? choice.busy === true : undefined}
            testID={testID}>
            {share > 0 ? (
                <YStack pointerEvents="none" position="absolute" top={0} bottom={0} left={0} width={`${Math.round(share * 100)}%`}
                    backgroundColor="highlight" testID={`transcript-card-choice-wash-${choice.id}`} />
            ) : null}
            {body}
        </Frame>
    );
}

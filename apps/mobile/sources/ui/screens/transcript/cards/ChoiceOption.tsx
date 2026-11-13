import React from 'react';
import { ListItem, Spinner, XStack, YStack } from 'tamagui';
import { ChevronRight } from 'lucide-react-native';
import { Copy, Glyph, HEIGHT, T } from '@/ui/grammar';
import type { TranscriptCardChoice } from '@/components/buzz/ChoicePlate';

/**
 * One option of a question or poll, as the mock's decision card draws it:
 * a framed row, brass when it is the pick, its letter, label and quiet detail.
 * A closed poll keeps its vote count and a highlight wash for its share.
 */
export function ChoiceOption({ choice, closed }: { choice: TranscriptCardChoice; closed: boolean }) {
    const share = closed ? Math.max(0, Math.min(1, choice.share ?? 0)) : 0;
    const disabled = Boolean(choice.disabled || choice.busy);
    const testID = choice.testID ?? `transcript-card-choice-${choice.id}`;
    const body = (
        <XStack gap="3" alignItems="flex-start" flex={1} minWidth={0}>
            {share > 0 ? (
                <YStack position="absolute" top={0} bottom={0} left={0} width={`${Math.round(share * 100)}%`}
                    backgroundColor="highlight" borderRadius="md" testID={`transcript-card-choice-wash-${choice.id}`} />
            ) : null}
            <YStack width={28} height={28} borderRadius="sm" borderWidth={1}
                borderColor={choice.selected ? 'needsYou' : choice.costly ? 'removed' : 'strongStroke'}
                alignItems="center" justifyContent="center" testID={`transcript-card-choice-letter-${choice.id}`}>
                {choice.mark === 'chevron' ? <Glyph icon={ChevronRight} size={16} accent={choice.selected} />
                    : choice.mark === 'none' ? null
                        : <T v="metaStrong" color={choice.selected ? 'needsYou' : choice.costly ? 'removed' : 'ink'}>{choice.letter}</T>}
            </YStack>
            <YStack flex={1} minWidth={0} gap="1">
                <T v={choice.leader ? 'heading' : 'body'} color={choice.disabled && !choice.busy ? 'secondary' : 'ink'}>{choice.label}</T>
                {choice.consequence ? <Copy small quiet>{choice.consequence}</Copy> : null}
            </YStack>
            {choice.busy ? <Spinner size="small" color="needsYou" /> : null}
            {closed && choice.votes !== undefined ? (
                <T v="meta" color={choice.leader ? 'needsYou' : 'secondary'} testID={`transcript-card-choice-count-${choice.id}`}>{choice.votes}</T>
            ) : null}
        </XStack>
    );
    const pressable = Boolean(choice.onPress);
    const Frame = (pressable ? ListItem : XStack) as typeof XStack;
    return (
        <Frame padding="3" borderRadius="md" borderWidth={1} overflow="hidden"
            borderColor={choice.selected ? 'needsYou' : closed ? 'stroke' : 'strongStroke'}
            backgroundColor={choice.selected ? 'highlight' : 'canvas'}
            minHeight={pressable ? HEIGHT.control : undefined}
            onPress={choice.onPress} disabled={pressable ? disabled : undefined}
            opacity={choice.disabled && !choice.busy ? 0.5 : 1}
            accessibilityRole={pressable ? 'button' : undefined}
            aria-label={pressable ? `${choice.letter}. ${choice.label}. ${choice.consequence}` : undefined}
            aria-busy={pressable ? choice.busy === true : undefined}
            testID={testID}>
            {body}
        </Frame>
    );
}

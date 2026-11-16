import React from 'react';
import { XStack, YStack } from 'tamagui';
import { Inked, T } from '@/ui/grammar';
import { PixelLoader } from './MonoHull';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from './ChevronGlyph';

export type TranscriptCardChoice = {
  id: string;
  /** The plate's letter or number; screen readers always read it. */
  letter: string;
  /**
   * A drawn mark shown in place of the letter: `chevron` for a choice that
   * applies something, `none` for the current one its selected box marks.
   */
  mark?: 'chevron' | 'none';
  label: string;
  consequence: string;
  costly?: boolean;
  votes?: number;
  share?: number;
  leader?: boolean;
  selected?: boolean;
  /** The tapped option while its decision sends. */
  busy?: boolean;
  /** Another option is sending; this one cannot be tapped. */
  disabled?: boolean;
  testID?: string;
  onPress?(): void;
};

/**
 * One lettered option plate (docs/DESIGN.md: choice options are plates). A Room's
 * choice card and the Tray share it, so a choice reads the same everywhere.
 */
export function TranscriptCardChoicePlate({
  choice,
  closed,
}: {
  choice: TranscriptCardChoice;
  closed: boolean;
}) {
  const [pressed, setPressed] = React.useState(false);
  const washWidth = closed ? Math.max(0, Math.min(1, choice.share ?? 0)) : 0;
  const inner = (
    <>
      {washWidth > 0 ? (
        <YStack
          pointerEvents="none"
          position="absolute"
          top={0}
          bottom={0}
          left={0}
          width={`${Math.round(washWidth * 100)}%`}
          backgroundColor="needsYou"
          opacity={choice.leader ? 0.28 : 0.18}
          testID={`transcript-card-choice-wash-${choice.id}`}
        />
      ) : null}
      <XStack position="relative" alignItems="flex-start" gap="2" paddingVertical="2" paddingHorizontal="4">
        <YStack
          minWidth={26}
          padding="1"
          borderWidth={1}
          borderColor={choice.costly ? 'removed' : choice.selected ? 'needsYou' : 'strongStroke'}
          borderRadius="sm"
          alignItems="center"
          justifyContent="center"
          overflow="hidden"
          testID={`transcript-card-choice-letter-${choice.id}`}
        >
          {choice.selected ? (
            <YStack pointerEvents="none" position="absolute" top={0} right={0} bottom={0} left={0} backgroundColor="needsYou" opacity={0.18} />
          ) : null}
          {choice.mark === 'chevron' ? (
            <Inked
              color={choice.costly ? 'removed' : choice.selected ? 'needsYou' : 'ink'}
              glyph={ChevronGlyph}
              size={CHEVRON_ROW_SIZE}
            />
          ) : choice.mark === 'none' ? (
            <YStack width={16} height={16} />
          ) : (
            <T v="heading" color={choice.costly ? 'removed' : choice.selected ? 'needsYou' : 'ink'}>
              {choice.letter}
            </T>
          )}
        </YStack>
        <YStack flex={1} minWidth={0}>
          <T
            v={choice.leader ? 'heading' : 'body'}
            color={choice.disabled && !choice.busy ? 'secondary' : 'ink'}
          >
            {choice.label}
          </T>
          {choice.consequence ? (
            <T v="meta" color="secondary" marginTop="1">{choice.consequence}</T>
          ) : null}
        </YStack>
        {choice.busy ? (
          <YStack justifyContent="center" height={26}>
            <PixelLoader compact />
          </YStack>
        ) : null}
        {closed && choice.votes !== undefined ? (
          <T
            v={choice.leader ? 'metaStrong' : 'code'}
            color={choice.leader ? 'needsYou' : 'secondary'}
            fontVariant={['tabular-nums']}
            paddingTop="1"
            minWidth={16}
            textAlign="right"
            testID={`transcript-card-choice-count-${choice.id}`}
          >
            {choice.votes}
          </T>
        ) : null}
      </XStack>
    </>
  );
  const testID = choice.testID ?? `transcript-card-choice-${choice.id}`;
  const disabled = Boolean(choice.disabled || choice.busy);
  const pressable = Boolean(choice.onPress);
  return (
    <YStack
      position="relative"
      overflow="hidden"
      minHeight={52}
      borderWidth={1}
      borderRadius="sm"
      borderColor={choice.disabled && !choice.busy ? 'stroke' : choice.selected ? 'needsYou' : closed ? 'stroke' : 'strongStroke'}
      backgroundColor={closed ? 'transparent' : 'highlight'}
      opacity={pressable && pressed && !disabled ? 0.85 : 1}
      testID={testID}
      {...(pressable
        ? {
            accessibilityRole: 'button' as const,
            accessibilityLabel: `${choice.letter}. ${choice.label}. ${choice.consequence}`,
            accessibilityState: { disabled, busy: choice.busy === true },
            'aria-busy': choice.busy === true,
            cursor: disabled ? 'default' : 'pointer',
            onPressIn: () => setPressed(true),
            onPressOut: () => setPressed(false),
            onPress: disabled ? undefined : choice.onPress,
          }
        : null)}
    >
      {inner}
    </YStack>
  );
}

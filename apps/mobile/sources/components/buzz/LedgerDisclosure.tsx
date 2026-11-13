import React from 'react';
import { XStack, YStack, type YStackProps } from 'tamagui';
import { HEIGHT, Inked, T } from '@/ui/grammar';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from './ChevronGlyph';

/** Shared steps, repository-event and system-line disclosure row. */
export function LedgerDisclosure({
  expanded,
  onPress,
  children,
  rowTestID,
  accessibilityLabel,
  accessibilityState,
  textToggle = false,
}: {
  /** Rich system text that ends in its own more/less word, so no chevron. */
  textToggle?: boolean;
  expanded: boolean;
  onPress: NonNullable<YStackProps['onPress']>;
  children: React.ReactNode;
  rowTestID?: string;
  accessibilityLabel: string;
  accessibilityState: { expanded: boolean };
}) {
  if (textToggle)
    return (
      <YStack
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={accessibilityState}
        aria-expanded={expanded}
        onPress={onPress}
        minHeight={HEIGHT.control}
        minWidth={44}
        testID={rowTestID}
      >
        {children}
      </YStack>
    );
  return (
    <XStack
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      aria-expanded={expanded}
      onPress={onPress}
      minHeight={HEIGHT.control}
      minWidth={44}
      justifyContent="center"
      alignItems="center"
      gap="2"
      testID={rowTestID}
    >
      <YStack width={CHEVRON_ROW_SIZE} flexShrink={0} justifyContent="center">
        <Inked
          color="secondary"
          glyph={ChevronGlyph}
          direction={expanded ? 'down' : 'right'}
          size={CHEVRON_ROW_SIZE}
        />
      </YStack>
      <T v="meta" color="secondary" flex={1} minWidth={0}>
        {children}
      </T>
    </XStack>
  );
}
/** Shared container without additional transcript spacing. */
export function LedgerLogGroup(props: YStackProps) {
  return <YStack {...props} />;
}

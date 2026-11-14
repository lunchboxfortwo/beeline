import React from 'react';
import { XStack, YStack } from 'tamagui';
import { Inked, T } from '@/ui/grammar';

import { ConversationGlyph } from './MicGlyph';

/** Clamped provenance preview; the reply body itself wraps in full. */
export function TranscriptReference({ children, viewer = false, onPress, accessibilityLabel, testID }: {
  children: React.ReactNode; viewer?: boolean; onPress?: () => void;
  accessibilityLabel?: string; testID?: string;
}) {
  const contents = viewer ? <XStack alignItems="center" gap="1" minWidth={0}>
    <Inked color="needsYou" glyph={ConversationGlyph} size={14} />
    <T v="code" color="secondary" numberOfLines={1} flexShrink={1} minWidth={0}>{children}</T>
  </XStack> : <T v="code" color="secondary" numberOfLines={2}>{children}</T>;
  return onPress ? <YStack accessibilityRole="button" accessibilityLabel={accessibilityLabel}
    onPress={onPress} cursor="pointer" minWidth={0} marginBottom="1" testID={testID}>{contents}</YStack>
    : <YStack minWidth={0} marginBottom="1" testID={testID}>{contents}</YStack>;
}

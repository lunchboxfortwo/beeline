import React from 'react';
import { XStack, YStack } from 'tamagui';
import { T } from '@/ui/grammar';
import { CloseButton } from './CloseGlyph';
import type { RepoCandidate } from '@/buzz/room-repo-picker';

/** The existing secondary pill treatment, with a full-size remove target. */
export function SelectedRepositoryPill({ repository, onClear, disabled, testIDPrefix }: {
  repository: RepoCandidate | null;
  onClear: () => void;
  disabled?: boolean;
  testIDPrefix: string;
}) {
  if (!repository) return null;
  return (
    <YStack alignSelf="flex-start" maxWidth="100%" testID={`${testIDPrefix}-pill`}>
      <XStack borderRadius="full" borderWidth={1} borderColor="stroke" backgroundColor="raised"
        paddingLeft="3" maxWidth="100%" gap="1" alignItems="center">
        <T v="meta" flexShrink={1}>{repository.name}</T>
        <CloseButton accessibilityLabel={`Clear repository ${repository.name}`} onPress={onClear} disabled={disabled}
          flexShrink={0} testID={`${testIDPrefix}-clear`} />
      </XStack>
    </YStack>
  );
}

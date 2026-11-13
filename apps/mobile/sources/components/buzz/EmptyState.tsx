import React from 'react';
import { YStack } from 'tamagui';
import { T } from '@/ui/grammar';
import { Button } from './Button';

/**
 * The one empty state: what is missing, one short line on how to fill it,
 * and at most one secondary action.
 */
export function EmptyState({
  action,
  description,
  testID,
  title,
}: {
  action?: { accessibilityLabel?: string; label: string; onPress: () => void; testID?: string };
  description?: string;
  testID?: string;
  title: string;
}) {
  return (
    <YStack accessibilityLiveRegion="polite" alignItems="center" paddingHorizontal="6" paddingVertical="8" gap="1" testID={testID}>
      <T v="body" textAlign="center">{title}</T>
      {description ? <T v="meta" color="secondary" textAlign="center">{description}</T> : null}
      {action ? (
        <Button
          accessibilityLabel={action.accessibilityLabel ?? action.label}
          label={action.label}
          onPress={action.onPress}
          marginTop="4"
          testID={action.testID}
          variant="secondary"
        />
      ) : null}
    </YStack>
  );
}

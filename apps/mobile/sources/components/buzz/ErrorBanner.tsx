import React from 'react';
import { XStack } from 'tamagui';
import { T } from '@/ui/grammar';
import { Button, type ButtonDestination, type ButtonVariant } from './Button';

/**
 * Shared contextual failure sentence and its existing actions. Whole-page
 * and list failures use IndexRow; no framed error-banner variant remains.
 */
export function ErrorBanner({
  icon,
  description,
  onRetry,
  retryLabel = 'Retry',
  retryDestination,
  retrying = false,
  retryTestID,
  retryVariant = 'secondary',
  testID,
  secondaryAction,
  title,
  titleTestID,
}: {
  inline?: true;
  icon?: React.ReactNode;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
  /** Where the retry goes when it leaves this screen (`Button.destination`). */
  retryDestination?: ButtonDestination;
  retrying?: boolean;
  retryTestID?: string;
  retryVariant?: ButtonVariant;
  testID?: string;
  secondaryAction?: {
    label: string;
    onPress(): void;
    disabled?: boolean;
    testID?: string;
    icon?: React.ReactNode;
    iconOnly?: boolean;
    accessibilityLabel?: string;
  };
  title: string;
  titleTestID?: string;
}) {
  return (
    <XStack
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      flexWrap="wrap"
      alignItems="center"
      columnGap="2"
      testID={testID}
    >
      {icon}
      <T v="meta" color="removed" flexShrink={1} testID={titleTestID}>
        {description ? `${title} ${description}` : title}
      </T>
      {onRetry || secondaryAction ? (
        <XStack maxWidth="100%" flexWrap="wrap" alignItems="center" gap="4">
          {onRetry ? (
            <Button
              size="inline"
              label={retryLabel}
              destination={retryDestination}
              loading={retrying}
              onPress={onRetry}
              testID={retryTestID ?? (testID ? `${testID}-retry` : undefined)}
              variant={retryVariant}
            />
          ) : null}
          {secondaryAction ? (
            <Button
              size="inline"
              label={secondaryAction.label}
              icon={secondaryAction.icon}
              iconOnly={secondaryAction.iconOnly}
              accessibilityLabel={secondaryAction.accessibilityLabel}
              onPress={secondaryAction.onPress}
              disabled={secondaryAction.disabled}
              testID={secondaryAction.testID ?? (testID ? `${testID}-secondary` : undefined)}
              variant="quiet"
            />
          ) : null}
        </XStack>
      ) : null}
    </XStack>
  );
}

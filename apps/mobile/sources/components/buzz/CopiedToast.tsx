import React, { useCallback, useEffect, useState } from 'react';
import { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { XStack, YStack } from 'tamagui';
import { Motion, STEP, T } from '@/ui/grammar';
import { layout } from '@/buzz/groknight';

/** How long a copy confirmation stays up before it dismisses itself. */
export const COPIED_TOAST_MS = 2000;

/**
 * The viewer's copy feedback (copy-feedback mockup, option 2): a small raised
 * plate that rises from the bottom of the viewer and dismisses itself — a
 * check when the copy landed, a danger mark when it failed.
 */
export function useCopiedToast(testID: string): {
  showCopied(message: string): void;
  showCopyFailed(message: string): void;
  toast: React.ReactNode;
} {
  const insets = useSafeAreaInsets();
  const [shown, setShown] = useState<{
    message: string;
    failed: boolean;
    at: number;
  } | null>(null);
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(null), COPIED_TOAST_MS);
    return () => clearTimeout(timer);
  }, [shown]);
  const showCopied = useCallback((message: string) => {
    setShown({ message, failed: false, at: Date.now() });
  }, []);
  const showCopyFailed = useCallback((message: string) => {
    setShown({ message, failed: true, at: Date.now() });
  }, []);
  const toast = shown ? (
    // Rides one row above the viewer's foot so it clears the image zoom bar
    // and the home indicator.
    <YStack
      pointerEvents="none"
      position="absolute"
      left={0}
      right={0}
      alignItems="center"
      bottom={insets.bottom + layout.row + STEP['4']}
    >
      <Motion entering={FadeInDown} exiting={FadeOutDown}>
        <XStack
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          alignItems="center"
          gap="2"
          paddingVertical="2"
          paddingHorizontal="4"
          borderRadius="sm"
          borderWidth={1}
          borderColor="stroke"
          backgroundColor="raised"
          testID={testID}
        >
          <YStack
            width={CHECK_SIZE}
            height={CHECK_SIZE}
            borderRadius="full"
            alignItems="center"
            justifyContent="center"
            backgroundColor={shown.failed ? 'removed' : 'added'}
          >
            <T v="meta" color="canvas">{shown.failed ? '!' : '✓'}</T>
          </YStack>
          <T v="meta">{shown.message}</T>
        </XStack>
      </Motion>
    </YStack>
  ) : null;
  return { showCopied, showCopyFailed, toast };
}

const CHECK_SIZE = 18;

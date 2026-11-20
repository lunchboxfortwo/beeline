import React from 'react';
import { YStack } from 'tamagui';
import { Spinner } from '@/ui/grammar';

/**
 * The one in-app load gate: the ring spinner, the same mark as every other
 * loading and working-now state. The Beeline mark is the brand, never a
 * loader. The page loader fills the space its page gives it and sits in the
 * middle of it; a compact loader sits inline.
 */
export function SurfaceGlyphLoader({
  compact = false,
  testID = 'surface-glyph-loader',
  size,
  onLayout,
}: {
  compact?: boolean;
  testID?: string;
  size?: number;
  onLayout?: React.ComponentProps<typeof YStack>['onLayout'];
}) {
  return (
    <YStack
      flex={compact ? undefined : 1}
      alignSelf={compact ? undefined : 'stretch'}
      backgroundColor={compact ? undefined : 'canvas'}
      onLayout={onLayout}
      alignItems="center"
      justifyContent="center"
      testID={testID}
    >
      <Spinner
        size={size ?? (compact ? 'small' : 'large')}
        testID={testID ? `${testID}-glyph` : undefined}
      />
    </YStack>
  );
}

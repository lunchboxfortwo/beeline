import React from 'react';
import { YStack } from 'tamagui';
import { MARK_CELL, SURFACE_GLYPH_SIZE } from '@/buzz/beeline-glyph';
import { BeelineGlyphPaint } from './BeelineGlyphPaint';

/**
 * The one in-app load-gate treatment: the same self-painting glyph as splash
 * and the thinking line. Duration is unknown, so this uses the release loop —
 * it never holds a completed stroke as progress toward a finish. The page loader
 * is the one every page shows while it loads: it fills the space its page
 * gives it and sits in the middle of it. A compact loader sits inline.
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
      accessibilityLabel="Loading"
      accessibilityRole="progressbar"
      testID={testID}
    >
      <BeelineGlyphPaint
        framing="cell"
        live
        loop="release"
        size={size ?? (compact ? MARK_CELL : SURFACE_GLYPH_SIZE)}
        testID={testID ? `${testID}-glyph` : undefined}
      />
    </YStack>
  );
}

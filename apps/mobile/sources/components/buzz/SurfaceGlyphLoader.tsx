import React from 'react';
import { YStack } from 'tamagui';
import { MARK_CELL, SURFACE_GLYPH_SIZE } from '@/buzz/beeline-glyph';
import { BeelineGlyphPaint } from './BeelineGlyphPaint';

/**
 * The one in-app load-gate treatment: the same self-painting glyph as splash
 * and the thinking line. Duration is unknown, so this uses the release loop —
 * it never holds a completed stroke as progress toward a finish. A page loader
 * fills the space its page gives it and sits in the middle of it; a compact
 * loader sits inline.
 */
export function SurfaceGlyphLoader({
  compact = false,
  testID = 'surface-glyph-loader',
  size,
}: {
  compact?: boolean;
  testID?: string;
  size?: number;
}) {
  return (
    <YStack
      flex={compact ? undefined : 1}
      alignSelf={compact ? undefined : 'stretch'}
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

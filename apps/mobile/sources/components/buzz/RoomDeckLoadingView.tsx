import React from 'react';
import { YStack } from 'tamagui';
import { SURFACE_GLYPH_SIZE } from '@/buzz/beeline-glyph';
import { T } from '@/ui/grammar';
import { SurfaceGlyphLoader } from './SurfaceGlyphLoader';

/**
 * The Room-deck page loader. The native launch splash hands directly to the
 * real app, so this treatment appears only when Rooms themselves are loading.
 * It fills the page and centres the glyph in it.
 */
export function RoomDeckLoadingView({ onLayout }: { onLayout?: React.ComponentProps<typeof YStack>['onLayout'] }) {
  return (
    <YStack flex={1} alignSelf="stretch" alignItems="center" justifyContent="center" gap="4" paddingHorizontal="8"
      backgroundColor="canvas" testID="rooms-loader-gate" onLayout={onLayout}>
      <SurfaceGlyphLoader compact size={SURFACE_GLYPH_SIZE} testID="rooms-loader" />
      <T v="meta" color="secondary">Loading chats</T>
    </YStack>
  );
}

import React from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { YStack } from 'tamagui';
import { HEIGHT, Motion, SafeTop, T } from '@/ui/grammar';
import { composerBottomPadding } from '@/buzz/composer-keyboard';
import { CORNER_LABEL, ROOM_LABEL } from '@/buzz/vocabulary';
import { SurfaceGlyphLoader } from './SurfaceGlyphLoader';

/** The existing loading surface, without mounting an empty transcript. */
export function ChatOpeningSurface({ isCorner }: { isCorner: boolean }) {
  const insets = useSafeAreaInsets();
  return (
    <YStack flex={1} backgroundColor="canvas">
      <SafeTop />
      <YStack flex={1} alignItems="center" justifyContent="center">
        <SurfaceGlyphLoader testID="room-surface-loader" />
      </YStack>
      <YStack minHeight={HEIGHT.control} alignItems="center" justifyContent="center" testID="room-loading-footer">
        <T v="meta" color="secondary" testID="room-loading-caption">
          LOADING {(isCorner ? CORNER_LABEL : ROOM_LABEL).toUpperCase()}
        </T>
      </YStack>
      <Motion motion={{ height: composerBottomPadding(Platform.OS, insets.bottom, 0) }} testID="room-loading-safe-bottom" />
    </YStack>
  );
}


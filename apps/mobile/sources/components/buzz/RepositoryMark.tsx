import React, { useState } from 'react';
import { Image } from 'react-native';
import { YStack } from 'tamagui';
import { Hash } from 'lucide-react-native';
import { Filled, Glyph } from '@/ui/grammar';

/** The stored owner picture, its site's favicon, then the existing generic chat mark. */
export function RepositoryMark({ avatarUrl, faviconUrl, size = 36 }: {
  avatarUrl?: string; faviconUrl?: string; size?: number;
}) {
  const [failed, setFailed] = useState<readonly string[]>([]);
  const uri = [avatarUrl, faviconUrl].find(url => url && !failed.includes(url));
  return <YStack width={size} height={size} borderRadius="sm" overflow="hidden" backgroundColor="highlight"
    alignItems="center" justifyContent="center" testID="repository-mark">
    {uri ? <Filled view={Image} source={{ uri }} resizeMode="cover"
      onError={() => setFailed(values => [...values, uri])} testID="repository-mark-image" />
      : <Glyph icon={Hash} size={size >= 36 ? 20 : 16} />}
  </YStack>;
}

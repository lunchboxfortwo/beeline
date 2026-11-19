import React, { useState } from 'react';
import { RepositoryImage } from './RepositoryImage';
import { YStack } from 'tamagui';
import { Hash } from 'lucide-react-native';
import { Filled, Glyph } from '@/ui/grammar';

/** Homepage icon, stored owner picture, GitHub favicon, then the generic chat mark. */
export function RepositoryMark({ homepageIconUrl, avatarUrl, faviconUrl, size = 36 }: {
  homepageIconUrl?: string; avatarUrl?: string; faviconUrl?: string; size?: number;
}) {
  const [failed, setFailed] = useState<readonly string[]>([]);
  const uri = [homepageIconUrl, avatarUrl, faviconUrl].find(url => url && !failed.includes(url));
  return <YStack width={size} height={size} borderRadius="sm" overflow="hidden" backgroundColor="highlight"
    alignItems="center" justifyContent="center" testID="repository-mark">
    {uri ? <Filled view={RepositoryImage} source={{ uri }} size={size} homepage={uri === homepageIconUrl} resizeMode="contain"
      onError={() => setFailed(values => [...values, uri])} testID="repository-mark-image" />
      : <Glyph icon={Hash} size={size >= 36 ? 20 : 16} />}
  </YStack>;
}

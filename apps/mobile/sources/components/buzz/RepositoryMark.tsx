import React, { useState, type ReactNode } from 'react';
import { RepositoryImage } from './RepositoryImage';
import { YStack } from 'tamagui';
import { Hash } from 'lucide-react-native';
import { Filled, Glyph } from '@/ui/grammar';

/** A chat's stored repository icon (`homepageIconUrl`, the server's one pick), or for a repository picker the owner
 * picture then GitHub favicon; then the generic chat mark (or `fallback`). */
export function RepositoryMark({ homepageIconUrl, avatarUrl, faviconUrl, size = 36, fallback }: {
  homepageIconUrl?: string; avatarUrl?: string; faviconUrl?: string; size?: number; fallback?: ReactNode;
}) {
  const [failed, setFailed] = useState<readonly string[]>([]);
  const uri = [homepageIconUrl, avatarUrl, faviconUrl].find(url => url && !failed.includes(url));
  if (!uri && fallback) return <>{fallback}</>;
  return <YStack width={size} height={size} borderRadius="sm" overflow="hidden" backgroundColor="highlight"
    alignItems="center" justifyContent="center" testID="repository-mark">
    {uri ? <Filled view={RepositoryImage} source={{ uri }} size={size} homepage={uri === homepageIconUrl} resizeMode="contain"
      onError={() => setFailed(values => [...values, uri])} testID="repository-mark-image" />
      : <Glyph icon={Hash} size={size >= 36 ? 20 : 16} />}
  </YStack>;
}

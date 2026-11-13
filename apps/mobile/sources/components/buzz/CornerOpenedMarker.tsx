import React from 'react';
import { YStack } from 'tamagui';

import { RepositoryLifecycleRow } from './PrLifecycleCard';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { lifecycleItem } from '@/buzz/pr-lifecycle';

/** Each requested corner keeps its own visible line and stable key. */
export function CornerOpenedMarkers({
  message,
  onOpenCorner,
  onOpenUrl,
}: {
  message: ChatDisplayMessage;
  onOpenCorner(id: string): void;
  onOpenUrl(url: string): void;
}) {
  const items = (message.cornerMarkers ?? []).flatMap((marker) => {
    const item = lifecycleItem(marker);
    return item ? [item] : [];
  });
  if (!items.length) return null;
  return (
    <YStack>
      {items.map((item) => (
        <RepositoryLifecycleRow
          key={item.id}
          item={item}
          testID={`corner-opened-marker-${item.cornerId}`}
          onOpenCorner={onOpenCorner}
          onOpenUrl={onOpenUrl}
        />
      ))}
    </YStack>
  );
}

import React from 'react';
import { XStack } from 'tamagui';
import { T } from '@/ui/grammar';
import { CORNER_META_SIZE, CornerGlyph } from './CornerGlyph';

/** The only two places a Room's scheduled work can run. */
export function ScheduledWorkWhere({ corner, isDirectMessage = false }: { corner?: { id: string; name: string } | null; isDirectMessage?: boolean }) {
  if (!corner) return <T v="meta" color="secondary" numberOfLines={1} flexShrink={0}>{isDirectMessage ? 'this DM' : 'this chat'}</T>;
  return <XStack alignItems="center" gap="1" flexShrink={0} maxWidth="75%">
    <CornerGlyph size={CORNER_META_SIZE} />
    <T v="meta" color="secondary" numberOfLines={1} minWidth={0}>{corner.name}</T>
  </XStack>;
}

import React from 'react';
import { YStack } from 'tamagui';
import { Inked, T } from '@/ui/grammar';
import { ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import { compactNewMessageCount } from '@/buzz/room-new-message-boundary';
import { TURN_LINE_BAR_MARGIN_BOTTOM, TURN_LINE_ROW_MIN_HEIGHT } from '@/buzz/room-bottom-chrome';

/**
 * The jump control is a 44pt disc — the one round box in the transcript,
 * because it is the one control that floats over the ledger rather than
 * sitting in chrome, and a circle is what reads as liftable there. The plate
 * IS the hit box: 44 is the minimum touch target, so nothing is gained by
 * drawing smaller inside it.
 */
const DISC_SIZE = 44;
const CHEVRON_SIZE = 20;
const BADGE_SIZE = 18;

/**
 * Everything a reader who is behind gets, drawn over the transcript by
 * `_chat-surface.tsx` from one hook (`buzz/use-new-message-control.ts`):
 *
 * - the disc, a way back to the newest message. It shows whenever that row is
 *   off screen, with or without unread mail behind it, and it always lands on
 *   the tail. The `N new` pill it replaces appeared only for unread mail and
 *   landed on the first unread row, so a reader who had scrolled up to re-read
 *   something had no way back down but their own thumb;
 * - the badge on that disc, a counter capped at `9+`, cleared by reaching the
 *   newest row rather than by a press. The disc outlives the badge;
 */
export function RoomUnreadControls({
  corner,
  bottomInset,
  badgeCount,
  discVisible,
  onJumpToNewest,
}: {
  corner: boolean;
  bottomInset?: number;
  badgeCount: number;
  discVisible: boolean;
  onJumpToNewest: () => void;
}) {
  const badgeShown = !corner && badgeCount > 0;
  return (
    <>
      {discVisible && (
        <YStack
          accessibilityLabel={
            badgeShown
              ? `${badgeCount} new ${badgeCount === 1 ? 'message' : 'messages'}. Jump to newest message`
              : 'Jump to newest message'
          }
          accessibilityRole="button"
          onPress={onJumpToNewest}
          position="absolute"
          right={12}
          // Desktop and archived transcripts have no measured hanging status slot.
          bottom={bottomInset !== undefined ? bottomInset + 4 : 4 + TURN_LINE_ROW_MIN_HEIGHT + TURN_LINE_BAR_MARGIN_BOTTOM}
          width={DISC_SIZE}
          height={DISC_SIZE}
          alignItems="center"
          justifyContent="center"
          cursor="pointer"
          testID="newest-jump-disc"
        >
          <YStack
            width={DISC_SIZE}
            height={DISC_SIZE}
            borderRadius="full"
            alignItems="center"
            justifyContent="center"
            borderWidth={1}
            borderColor="strongStroke"
            backgroundColor="highlight"
          >
            <Inked color="ink" glyph={ChevronGlyph} direction="down" size={CHEVRON_SIZE} />
          </YStack>
          {/* The count rides the disc's top-right corner, so the chevron keeps the
              whole plate and the number never widens the control. */}
          {badgeShown && (
            <YStack
              position="absolute"
              top={0}
              right={0}
              minWidth={BADGE_SIZE}
              height={BADGE_SIZE}
              paddingHorizontal="1"
              borderRadius="full"
              alignItems="center"
              justifyContent="center"
              backgroundColor="needsYou"
              testID="newest-jump-badge"
            >
              <T v="metaStrong" color="canvas" fontVariant={['tabular-nums']}>{compactNewMessageCount(badgeCount)}</T>
            </YStack>
          )}
        </YStack>
      )}
    </>
  );
}

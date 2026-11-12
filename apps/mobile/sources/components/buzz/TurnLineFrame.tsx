import React from 'react';
import type { ViewProps } from 'react-native';
import { YStack } from 'tamagui';
import {
  TURN_LINE_BAR_MARGIN_BOTTOM,
  roomBottomChromeStyles,
  TURN_CHROME_COMPOSER_OVERLAP,
} from '@/buzz/room-bottom-chrome';

/**
 * The phone slot's measured paddings (`room-bottom-chrome`); only the geometry
 * is read here, the paint is the canvas token.
 */
const COVERAGE = roomBottomChromeStyles({ bgTerminal: '', border: '' }).turnChromeCoverage;

/**
 * The status line's fixed geometry (`room-bottom-chrome`): the bar's bottom
 * margin and the phone overlay slot are measured constants the transcript
 * tail is built around, so they live here, outside the grammar's spacing
 * scale, as fixed-height spacers. The line's content is drawn by `TurnProgressLine`.
 */
export function TurnLineBar({ inset = true, children, ...rest }: ViewProps & { inset?: boolean }) {
  // The line sits inside the margin the transcript already leaves below its
  // newest message, so it adds no height and must stay one row.
  return (
    <YStack {...(rest as React.ComponentProps<typeof YStack>)} width="100%" minWidth={0} paddingHorizontal={inset ? '4' : 0}>
      {children}
      <YStack height={TURN_LINE_BAR_MARGIN_BOTTOM} pointerEvents="none" />
    </YStack>
  );
}

/** The phone line overlays the fixed transcript tail. Its canvas and label
 * are lowered toward the field so the newest row (including reactions) stays
 * above the paint and the visible air to the field border is balanced. */
export function TurnBandSlot({
  children,
  onTopInset,
  testID,
}: {
  onTopInset?: (height: number) => void;
  children?: React.ReactNode;
  testID?: string;
}) {
  const hasLine = React.Children.toArray(children).length > 0;
  // The slot is absolute (`room-bottom-chrome`), anchored on the composer.
  // Any mounted line, thinking or settled, paints the air above its ink and
  // overlaps the composer padding below it, so scrolled transcript text never
  // shows under the line. With no line there is no paint and no height. It
  // takes no room in the column, so the list's height is identical whether
  // or not the line is showing.
  return (
    <YStack
      pointerEvents="box-none"
      position="absolute"
      left={0}
      right={0}
      bottom="100%"
      backgroundColor={hasLine ? 'canvas' : undefined}
      y={hasLine ? TURN_CHROME_COMPOSER_OVERLAP : 0}
      testID={testID}
      onLayout={(event) =>
        onTopInset?.(
          // Layout excludes the paint translation into the composer.
          hasLine ? Math.max(0, event.nativeEvent.layout.height - TURN_CHROME_COMPOSER_OVERLAP) : 0,
        )
      }
    >
      {hasLine ? <YStack height={COVERAGE.paddingTop} pointerEvents="none" /> : null}
      {children}
      {hasLine ? <YStack height={COVERAGE.paddingBottom} pointerEvents="none" /> : null}
    </YStack>
  );
}

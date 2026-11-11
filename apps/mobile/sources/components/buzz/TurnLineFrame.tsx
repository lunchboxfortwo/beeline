import React from 'react';
import { View, type ViewProps } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  TURN_LINE_BAR_MARGIN_BOTTOM,
  roomBottomChromeStyles,
  TURN_CHROME_COMPOSER_OVERLAP,
} from '@/buzz/room-bottom-chrome';

/**
 * The status line's fixed geometry (`room-bottom-chrome`): the bar's bottom
 * margin and the phone overlay slot are measured constants the transcript
 * tail is built around, so they live here, outside the grammar's spacing
 * scale. The line's content is drawn by `TurnProgressLine`.
 */
export function TurnLineBar({ inset = true, children, ...rest }: ViewProps & { inset?: boolean }) {
  return <View {...rest} style={inset ? styles.bar : [styles.bar, styles.insetBar]}>{children}</View>;
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
    <View
      pointerEvents="box-none"
      style={[styles.slot, hasLine && styles.coverage]}
      testID={testID}
      onLayout={(event) =>
        onTopInset?.(
          // Layout excludes the paint translation into the composer.
          hasLine ? Math.max(0, event.nativeEvent.layout.height - TURN_CHROME_COMPOSER_OVERLAP) : 0,
        )
      }
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const bottomChrome = roomBottomChromeStyles(theme.buzz);
  return {
    // The line's surface is the transcript's own; see `room-bottom-chrome`.
    slot: bottomChrome.hangingTurnChrome,
    coverage: bottomChrome.turnChromeCoverage,
    // The line sits inside the margin the transcript already leaves below its
    // newest message, so it adds no height and must stay one row.
    bar: {
      width: '100%',
      minWidth: 0,
      marginBottom: TURN_LINE_BAR_MARGIN_BOTTOM,
      paddingHorizontal: theme.buzz.space.md,
    },
    insetBar: { paddingHorizontal: 0 },
  };
});

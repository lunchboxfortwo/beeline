import * as React from 'react';
import { XStack, YStack } from 'tamagui';
import { typeRoles } from '@/buzz/groknight';
import Svg, { Path } from 'react-native-svg';
import { Inked, T } from '@/ui/grammar';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';

/** A word beside the label that acts on the whole section (CLEAR). */
export type SectionHeaderWordAction = {
  accessibilityLabel?: string;
  disabled?: boolean;
  label: string;
  onPress: () => void;
  testID?: string;
};

export function RoomListSectionHeader({
  title,
  inset = 'screen',
  spacing = 'section',
  surface = 'inherit',
  count,
  actionAccessibilityLabel,
  actionTestID,
  onAction,
  actionDisabled,
  wordAction,
  tapLineHeight = false,
  testID,
}: {
  title: string;
  /**
   * Content already supplies its own screen inset; `row` aligns with
   * SettingsRow titles; `sheet` aligns with sheet rows; `roomList` puts the
   * label and the + ink on the Room list edge.
   */
  inset?: 'screen' | 'content' | 'row' | 'sheet' | 'roomList';
  /** Flush when the surrounding section already supplies its vertical gap. */
  spacing?: 'section' | 'flush';
  /**
   * Ordinary labels inherit their container. Sticky headers must opt into an
   * opaque screen fill (or supply one on their surrounding sticky row).
   * `sheet` preserves the existing sheet spacing while inheriting its fill.
   */
  surface?: 'inherit' | 'screen' | 'sheet';
  testID?: string;
  actionDisabled?: boolean;
  count?: number;
  actionAccessibilityLabel?: string;
  actionTestID?: string;
  onAction?: () => void;
  /** A word action such as CLEAR, before the + option. */
  wordAction?: SectionHeaderWordAction;
  /** Preserve the desktop sidebar tap line. */
  tapLineHeight?: boolean;
}) {
  // Later rules win, as the old style list did: flush, then the + row, then phone and sheet spacing.
  const flushTop = spacing === 'flush' || Boolean(onAction && !tapLineHeight);
  const roomyTop = !tapLineHeight || surface === 'sheet';
  return (
    <XStack
      alignItems="center"
      paddingTop={flushTop ? '0' : roomyTop ? '4' : '6'}
      paddingBottom={onAction && !tapLineHeight ? '0' : '1'}
      minHeight={onAction && !tapLineHeight ? 44 : 0}
      backgroundColor={surface === 'screen' ? 'canvas' : 'transparent'}
      paddingLeft={inset === 'content' ? '0' : inset === 'row' ? '2' : inset === 'sheet' ? '6' : inset === 'roomList' ? '5' : '4'}
      paddingRight={inset === 'content' ? '0' : inset === 'row' ? '2' : inset === 'sheet' ? '6' : inset === 'roomList' ? (tapLineHeight ? '4' : '2') : '4'}
    >
      <T v="metaStrong" color="secondary" flex={1} testID={testID} accessibilityRole="header">
        {title.toUpperCase()}
      </T>
      {count !== undefined && <T v="meta" color="secondary">{count}</T>}
      {wordAction ? (
        <YStack
          accessibilityLabel={wordAction.accessibilityLabel ?? wordAction.label}
          accessibilityRole="button"
          accessibilityState={{ disabled: wordAction.disabled }}
          hitSlop={WORD_HIT_SLOP}
          onPress={wordAction.disabled ? undefined : wordAction.onPress}
          marginLeft="2"
          opacity={wordAction.disabled ? 0.42 : 1}
          testID={wordAction.testID}
        >
          <T v="metaStrong" color="needsYou">{wordAction.label.toUpperCase()}</T>
        </YStack>
      ) : null}
      {onAction ? (
        <YStack minHeight={tapLineHeight ? 44 : 0} justifyContent={tapLineHeight ? 'center' : undefined}>
          <SectionAddButton
            accessibilityLabel={actionAccessibilityLabel}
            onPress={onAction}
            disabled={actionDisabled}
            compact={tapLineHeight}
            testID={actionTestID}
          />
        </YStack>
      ) : null}
    </XStack>
  );
}

/** Shared Members add action, including its glyph and phone touch target. */
export function SectionAddButton({ accessibilityLabel, onPress, disabled, compact = false, testID }: {
  accessibilityLabel?: string;
  onPress: () => void;
  disabled?: boolean;
  compact?: boolean;
  testID?: string;
}) {
  return (
    <YStack
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={disabled ? undefined : onPress}
      accessibilityState={{ disabled }}
      hitSlop={compact ? ACTION_HIT_SLOP : undefined}
      width={compact ? ACTION_GLYPH : 44}
      height={compact ? ACTION_GLYPH : 44}
      marginLeft="2"
      alignItems="center"
      justifyContent="center"
      testID={testID}
    >
      <Inked color="needsYou" glyph={SectionAddGlyph} />
    </YStack>
  );
}

/** A heavy, round-capped plus: the old thin stroke was hard to see. */
function SectionAddGlyph({ color }: { color?: string }) {
  return (
    <Svg
      {...DECORATIVE_GLYPH_PROPS}
      width={ACTION_GLYPH}
      height={ACTION_GLYPH}
      viewBox="0 0 24 24"
      stroke={color}
      strokeWidth={ACTION_STROKE}
      strokeLinecap="round"
      fill="none"
    >
      <Path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

/** Phones use a full target; desktop keeps its compact mark and tap-line wrapper. */
const ACTION_GLYPH = 24;
const ACTION_STROKE = 2.4;
const LABEL_LINE = typeRoles.sectionLabel.lineHeight;
const ACTION_HIT_SLOP = {
  top: (44 - ACTION_GLYPH) / 2,
  bottom: (44 - ACTION_GLYPH) / 2,
  left: (44 - ACTION_GLYPH) / 2,
  right: (44 - ACTION_GLYPH) / 2,
};
/** A word sits on the label's line; slop lifts its tap area to 44 px. */
const WORD_HIT_SLOP = { top: (44 - LABEL_LINE) / 2, bottom: (44 - LABEL_LINE) / 2, left: 8, right: 8 };

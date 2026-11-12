import React from 'react';
import { type AccessibilityRole, type AccessibilityState } from 'react-native';
import { ListItem, XStack, YStack, type XStackProps, type YStackProps } from 'tamagui';
import { HEIGHT, Inked, T } from '@/ui/grammar';
import { Button } from './Button';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from './ChevronGlyph';
import { HullSwitch } from './HullSwitch';
import { StateDot } from './StateDot';

/** A hairline rule: half a point, one device pixel on a 2x screen. */
const HAIRLINE = 0.5;

export type IndexRowInset = 'row' | 'sheet' | 'flush';
export const IndexRowInsetContext = React.createContext<IndexRowInset>('row');

/** Shared rich-content target: preserves the content surface's layout and nested actions. */
export function ContentTarget(props: YStackProps) {
  return <YStack {...props} />;
}

/** A horizontal composition for inline navigation and non-index layout.
 * Unlike an index entry, its children retain their own typography and targets.
 */
export function InlineRow(props: XStackProps) {
  return <XStack {...props} />;
}

/** Transcript navigation keeps rich text, an optional hanging glyph, and two
 * independent destinations. Index rows intentionally reserve a different axis.
 */
export function TranscriptNavigationRow({
  children,
  leading,
  primary,
  trailing,
  singleDestination = false,
  divider = false,
  testID,
}: {
  children: React.ReactNode;
  leading?: React.ReactNode;
  primary?: IndexRowTrailingPress;
  trailing?: IndexRowTrailingPress;
  singleDestination?: boolean;
  divider?: boolean;
  testID?: string;
}) {
  const chevron = (
    <YStack
      minHeight={HEIGHT.control}
      flexShrink={0}
      justifyContent="center"
      minWidth={singleDestination ? undefined : 44}
      alignItems={singleDestination ? undefined : 'center'}
    >
      <Inked color="needsYou" glyph={ChevronGlyph} direction="right" size={CHEVRON_ROW_SIZE} />
    </YStack>
  );
  // Centred on the first line of meta-size copy.
  const glyph = leading ? <YStack flexShrink={0} height={44} justifyContent="center">{leading}</YStack> : null;
  if (singleDestination && trailing)
    return (
      <YStack testID={testID}>
        <XStack
          accessibilityRole="link"
          {...trailing}
          hitSlop={{ top: 6, bottom: 6 }}
          minHeight={HEIGHT.control}
          alignItems="flex-start"
          gap="2"
          borderTopWidth={divider ? HAIRLINE : 0}
          borderTopColor="stroke"
        >
          {glyph}
          <YStack minHeight={HEIGHT.control} minWidth={44} flex={1} paddingVertical="2">{children}</YStack>
          {chevron}
        </XStack>
      </YStack>
    );
  return (
    <XStack
      minHeight={HEIGHT.control}
      alignItems="flex-start"
      gap="2"
      borderTopWidth={divider ? HAIRLINE : 0}
      borderTopColor="stroke"
      testID={testID}
    >
      {glyph}
      {primary ? (
        <YStack accessibilityRole="link" {...primary} minHeight={HEIGHT.control} minWidth={44} flex={1} paddingVertical="2">
          {children}
        </YStack>
      ) : (
        <YStack minHeight={HEIGHT.control} minWidth={44} flex={1} paddingVertical="2">{children}</YStack>
      )}
      {trailing ? (
        <YStack accessibilityRole="link" {...trailing} minHeight={HEIGHT.control} minWidth={44} alignItems="center" justifyContent="center">
          {chevron}
        </YStack>
      ) : null}
    </XStack>
  );
}

/** Its own 44pt press for a trailing mark the row itself does not own. */
export type IndexRowTrailingPress = {
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  accessibilityHint?: string;
  accessibilityLabel?: string;
  disabled?: boolean;
  onPress: () => void;
  testID?: string;
};

/** The inline text action on the trailing axis, such as Connect. */
type IndexRowActionControl = {
  accessibilityLabel?: string;
  disabled?: boolean;
  label: string;
  onPress: () => void;
  testID?: string;
};

/** A named affordance hanging off the end of the quiet line, never the axis. */
export type IndexRowDescriptionAction = {
  accessibilityLabel?: string;
  label: string;
  onPress: () => void;
  testID?: string;
};

export type IndexRowToggle = {
  accessibilityLabel?: string;
  disabled?: boolean;
  onValueChange: (value: boolean) => void;
  value: boolean;
};

export type IndexRowProps = {
  title: string;
  /** `page` rows are `layout.row` tall; `sheet` rows are the sheet row height. */
  density?: 'page' | 'sheet';
  /** `row` aligns with page section headers; `sheet` is the sheet's own edge. */
  inset?: 'row' | 'sheet' | 'flush';
  /** Which edge carries the hairline. Sheets part rows above; pages below. */
  divider?: 'top' | 'bottom';
  /** Approved Workbench app-board row metrics. */
  appBoard?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  /** A single action word on the trailing axis. */
  action?: string;
  /** The inline text action on the trailing axis. */
  actionControl?: IndexRowActionControl;
  /** The trailing chevron of a row that opens something. */
  chevron?: 'right' | 'down' | 'up';
  /** The quiet line under the title: one short phrase, two lines at most. */
  description?: string;
  /** A short fact kept whole before a one-line, ellipsized description tail. */
  descriptionLead?: string;
  /** Custom rendering for the description; `description` remains its spoken text. */
  descriptionContent?: React.ReactNode;
  /** A second quiet line under `description`, for one provenance fact. */
  descriptionDetail?: string;
  /** Inline marks and text for the second quiet line; descriptionDetail is its spoken text. */
  descriptionDetailContent?: React.ReactNode;
  /** A failed row may put its exact error in the subtitle. */
  descriptionTone?: 'danger';
  descriptionAction?: IndexRowDescriptionAction;
  disabled?: boolean;
  leading?: React.ReactNode;
  onPress?: () => void;
  /** Marks the chosen option in a sheet: the value reads SELECTED. */
  selected?: boolean;
  statusGlyph?: 'live' | 'pulse' | 'failed';
  testID?: string;
  /** A quiet fact at the end of the title line (an agent's model). */
  titleAside?: string;
  /**
   * What the TITLE is, when it is not simply the name of a thing:
   * `'action'` — the title is the verb, in brass; `'destructive'` — the shape
   * a member is removed with; `'quiet'` — a stated absence, not a thing.
   */
  tone?: 'action' | 'destructive' | 'quiet';
  toggle?: IndexRowToggle;
  /** Caller-owned controls for the trailing column (a roster's actions). */
  trailing?: React.ReactNode;
  trailingPress?: IndexRowTrailingPress;
  /** The row's current state, on the trailing axis. Never in the title. */
  value?: string;
  valueTone?: 'danger' | 'accent';
  /** The title keeps its full width; the trailing value ellipsizes instead. */
  wholeTitle?: boolean;
  /** Recovery notices keep all copy visible, including at large text sizes. */
  wrap?: boolean;
};

/** A page subtitle is one short phrase; a long one stops at two lines. */
const DESCRIPTION_LINES = 2;

/** The reserved width of a row's trailing column (DESIGN.md → Index rows). */
const TRAILING_COLUMN = 72;

/** The 44 pt tap area a quiet-line action reaches without growing the line. */
const DESCRIPTION_ACTION_SLOP = 12;

/**
 * The one index row: Settings, sheets and member rosters. One trailing column,
 * one pressed fill, one disabled opacity, on two densities and two insets.
 *
 * The trailing column is a closed vocabulary, every form ending on the row's
 * own padding edge:
 *
 *   - `chevron`        a row that opens something;
 *   - `value`          the row's current state (pairs with `chevron` and
 *                      `statusGlyph`);
 *   - `action`         one word, for a row that acts on the thing it names;
 *   - `actionControl`  the inline Connect action;
 *   - `toggle`         the one switch;
 *   - `trailing`       caller-owned controls (a roster's actions);
 *   - nothing          for a plain fact, or a row whose TITLE is the action.
 *
 * A row never wears a box and never carries an explanatory paragraph.
 */
export function IndexRow({
  appBoard = false,
  accessibilityLabel,
  accessibilityRole,
  accessibilityState,
  action,
  actionControl,
  chevron,
  density = 'page',
  description,
  descriptionAction,
  descriptionContent,
  descriptionDetail,
  descriptionDetailContent,
  descriptionLead,
  descriptionTone,
  disabled = false,
  divider,
  inset: ownInset,
  leading,
  onPress,
  selected = false,
  statusGlyph,
  testID,
  title,
  titleAside,
  tone,
  toggle,
  trailing,
  trailingPress,
  value,
  valueTone,
  wholeTitle = false,
  wrap = false,
}: IndexRowProps) {
  const inheritedInset = React.useContext(IndexRowInsetContext);
  const inset = ownInset ?? inheritedInset;
  const shownValue = selected ? 'SELECTED' : value;
  const spoken = [
    shownValue ?? action ?? actionControl?.label,
    descriptionLead ? `${descriptionLead} ${description ?? ''}`.trim() : description,
    descriptionDetail,
  ]
    .filter(Boolean)
    .join('. ');
  const rowLabel = accessibilityLabel ?? (spoken ? `${title}. ${spoken}` : title);
  // A pressable toggle row IS the switch to a screen reader, so the control
  // itself is not announced a second time.
  const rowIsSwitch = Boolean(toggle && onPress);
  // A page subtitle is one short phrase and stops at two lines; a sheet row's
  // quiet line explains the choice, so it wraps whole (screenshot 1cfe27eb).
  const descriptionLines = !wrap && density === 'page' ? DESCRIPTION_LINES : undefined;

  const trailingMark =
    action !== undefined ? (
      // The one word that acts. Brass, because acting is what brass marks.
      <T v="meta" color="needsYou" textAlign="right" numberOfLines={wrap ? undefined : 1}>
        {action}
      </T>
    ) : shownValue !== undefined ? (
      <XStack
        alignItems="center"
        gap="2"
        flexShrink={wholeTitle ? 1 : undefined}
        minWidth={wholeTitle ? 0 : undefined}
        maxWidth={wholeTitle ? '100%' : undefined}
      >
        {statusGlyph ? (
          <StateDot kind={statusGlyph} testID={testID ? `${testID}-glyph` : undefined} />
        ) : null}
        <T
          v={valueTone === 'accent' ? 'metaStrong' : 'meta'}
          numberOfLines={1}
          textAlign="right"
          color={valueTone === 'danger' ? 'removed' : valueTone === 'accent' ? 'needsYou' : 'secondary'}
          flexShrink={wholeTitle ? 1 : undefined}
          minWidth={wholeTitle ? 0 : undefined}
          maxWidth={wholeTitle ? '100%' : undefined}
        >
          {shownValue}
        </T>
      </XStack>
    ) : null;

  // The one trailing column: values read down one edge, and the copy beside
  // them ends on one edge too. The trailing slot owns the width cap, not the
  // text inside it: a percentage on the text resolves against a content-sized
  // press target and collapses.
  const slot = { flexShrink: 0, minWidth: TRAILING_COLUMN, maxWidth: '50%', alignItems: 'flex-end' } as const;
  const trailingColumn = toggle ? (
    <YStack
      accessibilityElementsHidden={rowIsSwitch}
      importantForAccessibility={rowIsSwitch ? 'no-hide-descendants' : 'auto'}
      {...slot}
      // A pressable row is the switch's tap target; a bare switch needs its own 44.
      minHeight={onPress ? 0 : HEIGHT.control}
      justifyContent={onPress ? undefined : 'center'}
    >
      <HullSwitch
        accessibilityLabel={toggle.accessibilityLabel ?? title}
        dimWhenDisabled={!disabled}
        disabled={toggle.disabled ?? disabled}
        onValueChange={toggle.onValueChange}
        testID={testID ? `${testID}-toggle` : undefined}
        value={toggle.value}
      />
    </YStack>
  ) : actionControl !== undefined ? (
    <YStack {...slot}>
      <Button
        size="inline"
        label={actionControl.label}
        variant="secondary"
        accessibilityLabel={actionControl.accessibilityLabel ?? actionControl.label}
        disabled={actionControl.disabled}
        onPress={actionControl.onPress}
        testID={actionControl.testID}
      />
    </YStack>
  ) : trailing !== undefined ? (
    <YStack {...slot}>{trailing}</YStack>
  ) : trailingMark === null ? null : trailingPress ? (
    <YStack
      accessibilityLabel={trailingPress.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(trailingPress.disabled) }}
      disabled={trailingPress.disabled}
      onPress={trailingPress.onPress}
      {...slot}
      minHeight={HEIGHT.control}
      justifyContent="center"
      opacity={trailingPress.disabled ? 0.42 : 1}
      testID={trailingPress.testID}
    >
      {trailingMark}
    </YStack>
  ) : (
    <YStack {...slot} flexShrink={wholeTitle ? 1 : 0} minWidth={wholeTitle ? 0 : TRAILING_COLUMN}>
      {trailingMark}
    </YStack>
  );

  const body = (
    <>
      {leading}
      <YStack
        flex={wholeTitle ? undefined : 1}
        // A whole title sizes the copy column to itself; the trailing value yields.
        flexGrow={wholeTitle ? 1 : undefined}
        flexShrink={wholeTitle ? 0 : undefined}
        flexBasis={wholeTitle ? 'auto' : undefined}
        minWidth={0}
      >
        <XStack alignItems="baseline" gap="2">
          <T
            v="body"
            numberOfLines={wrap ? undefined : 1}
            color={tone === 'quiet' ? 'secondary' : tone === 'action' ? 'needsYou' : tone === 'destructive' ? 'removed' : 'ink'}
          >
            {title}
          </T>
          {titleAside ? (
            <>
              <YStack flex={1} />
              <T v="meta" color="secondary" numberOfLines={1} flexShrink={0} maxWidth="60%" textAlign="right">
                {titleAside}
              </T>
            </>
          ) : null}
        </XStack>
        {description || descriptionContent ? (
          <XStack alignItems="center" gap={descriptionLead ? '1' : '2'} marginTop="0.5">
            {descriptionLead ? (
              <T
                v="meta"
                color="secondary"
                numberOfLines={1}
                flexShrink={0}
                testID={testID ? `${testID}-description-lead` : undefined}
              >
                {descriptionLead}
              </T>
            ) : null}
            {descriptionContent ?? (
              // `flex: 1` fills the copy column, so an affordance hanging off its end
              // lands on one edge down the list instead of chasing each row's text.
              <T
                v="meta"
                color={descriptionTone === 'danger' ? 'removed' : 'secondary'}
                flex={1}
                minWidth={0}
                numberOfLines={wrap ? undefined : descriptionLead || descriptionAction ? 1 : descriptionLines}
              >
                {description}
              </T>
            )}
            {descriptionAction ? (
              <YStack
                accessibilityLabel={descriptionAction.accessibilityLabel ?? descriptionAction.label}
                accessibilityRole="button"
                hitSlop={DESCRIPTION_ACTION_SLOP}
                onPress={descriptionAction.onPress}
                testID={descriptionAction.testID}
              >
                <T v="meta" color="secondary">{descriptionAction.label}</T>
              </YStack>
            ) : null}
          </XStack>
        ) : null}
        {descriptionDetail || descriptionDetailContent ? (
          <XStack alignItems="center" gap={descriptionDetailContent ? 0 : '2'} marginTop="0.5">
            {descriptionDetailContent ?? (
              <T v="meta" color="secondary" flex={1} minWidth={0} numberOfLines={wrap ? undefined : DESCRIPTION_LINES}>
                {descriptionDetail}
              </T>
            )}
          </XStack>
        ) : null}
      </YStack>
      {trailingColumn}
      {chevron ? (
        // Right-aligned in its own column so the glyph's trailing edge lands on
        // the row's padding edge — the one axis every trailing mark shares.
        <YStack width={16} alignItems="flex-end" justifyContent="center">
          <Inked color="secondary" glyph={ChevronGlyph} direction={chevron} size={CHEVRON_ROW_SIZE} />
        </YStack>
      ) : null}
    </>
  );

  const described = Boolean(
    description || descriptionContent || descriptionDetail || descriptionDetailContent,
  );
  const dividerTop = !appBoard && (divider ?? (density === 'sheet' ? 'top' : 'bottom')) === 'top';
  // A page row with a subtitle keeps its text clear of both hairlines; one
  // without stays exactly its density's height. App-board rows are flush with
  // one full hairline below.
  const row = (
    {
      flexDirection: 'row',
      alignItems: 'center',
      borderTopWidth: dividerTop ? HAIRLINE : 0,
      borderBottomWidth: dividerTop ? 0 : appBoard ? 1 : HAIRLINE,
      opacity: disabled ? 0.42 : 1,
      testID,
    }
  ) as const;

  if (!onPress) {
    return (
      <XStack
        accessibilityLabel={rowLabel}
        accessibilityRole={accessibilityRole}
        accessibilityState={accessibilityState ?? (disabled ? { disabled } : undefined)}
        {...row}
        gap="4"
        minHeight={density === 'sheet' && !appBoard ? HEIGHT.tabBar : HEIGHT.sheetRow}
        paddingVertical={described && density === 'page' && !appBoard ? '3' : density === 'sheet' && !appBoard ? '2' : 0}
        paddingHorizontal={appBoard || inset === 'flush' ? 0 : inset === 'sheet' ? '6' : '2'}
        borderTopColor="stroke"
        borderBottomColor="stroke"
      >
        {body}
      </XStack>
    );
  }
  return (
    <ListItem
      accessibilityLabel={rowLabel}
      accessibilityRole={accessibilityRole ?? (rowIsSwitch ? 'switch' : 'button')}
      accessibilityState={
        accessibilityState ??
        (rowIsSwitch ? { checked: toggle?.value, disabled } : { disabled, selected })
      }
      disabled={disabled}
      onPress={onPress}
      {...row}
      padding="0"
      backgroundColor="transparent"
      gap="4"
      minHeight={density === 'sheet' && !appBoard ? HEIGHT.tabBar : HEIGHT.sheetRow}
      paddingVertical={described && density === 'page' && !appBoard ? '3' : density === 'sheet' && !appBoard ? '2' : 0}
      paddingHorizontal={appBoard || inset === 'flush' ? 0 : inset === 'sheet' ? '6' : '2'}
      borderTopColor="stroke"
      borderBottomColor="stroke"
    >
      {body}
    </ListItem>
  );
}

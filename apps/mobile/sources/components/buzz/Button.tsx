import { useFinePointer } from '@/utils/use-fine-pointer';
import * as React from 'react';
import type { Pressable, PressableProps } from 'react-native';
import { XStack, type XStackProps } from 'tamagui';
import * as Haptics from 'expo-haptics';
import { Inked, T } from '@/ui/grammar';
import { PixelLoader } from './MonoHull';
import { ChevronGlyph } from './ChevronGlyph';
import { ExternalGlyph } from './ExternalGlyph';

export type ButtonDestination = 'external' | 'screen';

/** The one size every destination mark draws at, beside a `body` label. */
export const DESTINATION_MARK_SIZE = 14;

export type ButtonVariant =
  'primary' | 'secondary' | 'provider' | 'brass' | 'quiet' | 'destructive' | 'danger';

/** Outer layout only (margins, alignment, flex), in grammar values. Shape and type are fixed. */
export type ButtonLayout = Pick<
  XStackProps,
  | 'flex'
  | 'flexGrow'
  | 'flexShrink'
  | 'flexBasis'
  | 'alignSelf'
  | 'margin'
  | 'marginTop'
  | 'marginBottom'
  | 'marginLeft'
  | 'marginRight'
  | 'marginHorizontal'
  | 'marginVertical'
  | 'width'
  | 'minWidth'
  | 'maxWidth'
  | 'position'
  | 'top'
  | 'right'
  | 'bottom'
  | 'left'
  | 'zIndex'
>;

export type ButtonProps = Omit<PressableProps, 'children' | 'style'> & ButtonLayout & {
  ref?: React.Ref<React.ComponentRef<typeof Pressable>>;
  /** Sentence-case verb shown on the button. */
  label: string;
  /** Existing drawn glyph for an icon-only control, with an accessibility label. */
  icon?: React.ReactNode;
  /** Fixed 44-point target without label padding. */
  iconOnly?: boolean;
  size?: 'default' | 'inline';
  /** Compact filters for a mouse; touch keeps the house target. */
  compact?: boolean;
  iconPosition?: 'start' | 'end';
  /**
   * Where the press goes, drawn after the label in the label's colour:
   * `external` leaves Beeline (`ExternalGlyph`), `screen` opens another
   * Beeline screen (`ChevronGlyph`). Labels carry words only, never an arrow.
   */
  destination?: ButtonDestination;
  /**
   * `primary`: the filled action (one per surface).
   * `secondary`: outlined in `strongStroke`, for the alternative action.
   * `provider`: raised surface for account sign-in providers in either theme.
   * `brass`: outlined in the accent, for a highlighted secondary action.
   */
  variant?: ButtonVariant;
  /** Recedes a dismissal label without changing its control or hit target. */
  labelTone?: 'quiet';
  /** Shows the compact pixel loader, marks the button busy and disables it. */
  loading?: boolean;
  /** Stretch across the parent's cross axis. */
  fullWidth?: boolean;
};

/**
 * The one button (docs/DESIGN.md → Buttons). House radius, 44 tall, `heading` label.
 * Replaces MonoButton, BrassButton, OnboardingButton and RoundButton.
 */
export function Button(props: ButtonProps) {
  return <ButtonFrame {...props} />;
}

function ButtonFrame({
  label,
  icon,
  iconOnly = false,
  compact = false,
  size = 'default',
  iconPosition = 'start',
  destination,
  variant = 'primary',
  labelTone,
  loading = false,
  fullWidth = false,
  disabled,
  onPress,
  onPressIn,
  onPressOut,
  accessibilityState,
  ...props
}: ButtonProps) {
  const finePointer = useFinePointer();
  const [pressed, setPressed] = React.useState(false);
  const isDisabled = Boolean(disabled || loading);
  const inline = size === 'inline';
  const primary = !inline && variant === 'primary';
  const filled = primary || variant === 'provider';
  const borderless = variant === 'quiet' || variant === 'destructive';
  const down = pressed && !isDisabled;

  // The label's ink, also drawn by the destination mark.
  const quietInk = (isDisabled && variant !== 'provider') || (inline ? variant === 'quiet' : labelTone === 'quiet');
  const removedInk = !quietInk && (variant === 'destructive' || (inline && variant === 'danger'));
  const brassInk = !quietInk && !removedInk && (inline || variant === 'brass');
  const primaryInk = !quietInk && primary;
  const labelVariant = inline ? 'meta' : labelTone === 'quiet' ? 'body' : 'heading';

  const frame: XStackProps = inline
    ? {
        maxWidth: '100%',
        flexShrink: 1,
        alignSelf: 'flex-start',
        opacity: down ? 0.6 : 1,
      }
    : {
        minWidth: 44,
        ...(iconOnly ? { width: 44, height: 44 } : null),
        alignSelf: fullWidth ? 'stretch' : undefined,
        opacity: isDisabled && variant === 'provider' ? 0.4 : down && filled ? 0.85 : 1,
      };

  return (
    <XStack
      accessibilityRole="button"
      {...(props as XStackProps)}
      accessibilityState={{
        ...accessibilityState,
        disabled: isDisabled,
        busy: loading || accessibilityState?.busy === true,
      }}
      hitSlop={inline ? (props.hitSlop ?? { top: 13, bottom: 13, left: 22, right: 22 }) : props.hitSlop}
      onPressIn={(event: any) => {
        setPressed(true);
        onPressIn?.(event);
      }}
      onPressOut={(event: any) => {
        setPressed(false);
        onPressOut?.(event);
      }}
      onPress={
        isDisabled
          ? undefined
          : (event: any) => {
              if (primary) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onPress?.(event);
            }
      }
      cursor={isDisabled ? 'default' : 'pointer'}
      alignItems="center"
      justifyContent="center"
      gap="2"
      minHeight={inline || (compact && finePointer) ? 0 : 44}
      paddingVertical={!inline && compact && finePointer ? '1' : 0}
      paddingHorizontal={inline || iconOnly ? 0 : '4'}
      borderRadius="sm"
      borderWidth={inline ? 0 : 1}
      backgroundColor={
        inline
          ? 'transparent'
          : primary
            ? isDisabled
              ? 'highlight'
              : 'primaryFill'
            : variant === 'provider'
              ? 'raised'
              : down
                ? 'highlight'
                : 'transparent'
      }
      borderColor={
        inline || borderless
          ? 'transparent'
          : primary
            ? isDisabled
              ? 'highlight'
              : 'primaryFill'
            : variant === 'provider'
              ? 'strongStroke'
              : isDisabled
                ? 'stroke'
                : variant === 'brass'
                  ? 'needsYou'
                  : variant === 'danger'
                    ? 'removed'
                    : 'strongStroke'
      }
      {...frame}
      {...pickLayout(props)}
    >
      {loading && <PixelLoader compact />}
      {iconPosition === 'start' && icon}
      {label ? (
        <T
          v={labelVariant}
          color={quietInk ? 'secondary' : removedInk ? 'removed' : brassInk ? 'needsYou' : primaryInk ? 'primaryInk' : 'ink'}
          numberOfLines={inline ? undefined : 1}
        >
          {label}
        </T>
      ) : null}
      {iconPosition === 'end' && icon}
      {destination && label ? (
        destination === 'external' ? (
          <Inked
            color={quietInk ? 'secondary' : removedInk ? 'removed' : brassInk ? 'needsYou' : primaryInk ? 'primaryInk' : 'ink'}
            glyph={ExternalGlyph}
            size={DESTINATION_MARK_SIZE}
            testID="button-destination-external"
          />
        ) : (
          <Inked
            color={quietInk ? 'secondary' : removedInk ? 'removed' : brassInk ? 'needsYou' : primaryInk ? 'primaryInk' : 'ink'}
            glyph={ChevronGlyph}
            size={DESTINATION_MARK_SIZE}
            testID="button-destination-screen"
          />
        )
      ) : null}
    </XStack>
  );
}

const LAYOUT_KEYS: readonly (keyof ButtonLayout)[] = [
  'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf', 'margin', 'marginTop', 'marginBottom',
  'marginLeft', 'marginRight', 'marginHorizontal', 'marginVertical', 'width', 'minWidth', 'maxWidth',
  'position', 'top', 'right', 'bottom', 'left', 'zIndex',
];
/** The caller's outer layout wins over the frame, as the old `style` did. */
function pickLayout(props: object): ButtonLayout {
  const out: Record<string, unknown> = {};
  for (const key of LAYOUT_KEYS) if (key in props) out[key] = (props as Record<string, unknown>)[key];
  return out as ButtonLayout;
}

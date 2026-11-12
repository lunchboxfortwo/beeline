import { ButtonRow } from './ButtonRow';
import React from 'react';
import { Modal, BackHandler, Platform, type TextInput } from 'react-native';
import { Easing, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Input, XStack, YStack, styled, useThemeName, type InputProps, type YStackProps } from 'tamagui';
import { space, typeRoles } from '@/buzz/groknight';
import { clearModalNavigationBarScrim } from '@/buzz/android-modal-navigation-bar';
import { HEIGHT, MotionLayer, T } from '@/ui/grammar';
import { type ButtonProps } from './Button';
import { HullSurface } from './MonoHull';

/** A hairline rule: half a point, one device pixel on a 2x screen. */
const HAIRLINE = 0.5;

/** The modal's keyboard-aware root fills the window. */
const KeyboardFrame = styled(KeyboardAvoidingView, { flex: 1, minWidth: 0 });

export type HullDialogAction = {
  labelTone?: ButtonProps['labelTone'];
  accessibilityLabel?: string;
  accessibilityRole?: ButtonProps['accessibilityRole'];
  description?: React.ReactNode;
  busy?: boolean;
  loading?: boolean;
  disabled?: boolean;
  label: string;
  onPress: NonNullable<ButtonProps['onPress']>;
  testID?: string;
  variant?: 'quiet' | 'primary' | 'secondary' | 'destructive';
};

export const HULL_DIALOG_LAYOUT = {
  actionBorderTopWidth: HAIRLINE,
  actionButtonMinHeight: 44,
  actionPaddingVertical: space.sm,
  // dialogBody reads the meta role; dialogTitle reads bodyStrong — this
  // geometry budget (`hullDialogMinimumHeight`) must use their real line
  // heights, not an approximation, or the two drift apart.
  bodyLineHeight: typeRoles.meta.lineHeight,
  bodyMarginTop: space.sm,
  copyPaddingBottom: space.md,
  copyPaddingTop: space.lg,
  inputMarginTop: space.md,
  inputMinHeight: 44,
  titleLineHeight: typeRoles.bodyStrong.lineHeight,
} as const;

type HullFloatingSurfaceProps = Omit<React.ComponentProps<typeof HullSurface>, 'strength'>;

/** The single tokenized surface base for every app-owned floating region. */
export function HullFloatingSurface(props: HullFloatingSurfaceProps) {
  const dark = useThemeDark();
  return (
    <HullSurface
      overflow="hidden"
      borderWidth={HAIRLINE}
      borderColor="strongStroke"
      borderRadius="sm"
      backgroundColor="raised"
      shadowOffset={{ width: 0, height: 18 }}
      shadowOpacity={dark ? 0.55 : 0.14}
      shadowRadius={48}
      {...props}
      strength="raised"
    />
  );
}

function useThemeDark() {
  // Tamagui theme names are `${mode}_${palette}`.
  return useThemeName().startsWith('dark');
}

type HullModalProps = {
  accessibilityLabel?: string;
  animationType?: 'fade' | 'slide' | 'none';
  children: React.ReactNode;
  /** Caps the content column wider (or narrower) than its placement's default. */
  contentMaxWidth?: number;
  contentMaxHeight?: number;
  dismissOnBackdrop?: boolean;
  keyboardAvoiding?: boolean;
  onDismiss?: () => void;
  onRequestClose: () => void;
  placement?: 'bottom' | 'center' | 'fill';
  scrimTestID?: string;
  testID?: string;
  visible: boolean;
  /** Room actions can cover their existing full-screen parent on Android. */
  withinScreen?: boolean;
};

type FloatingCallback = (...args: unknown[]) => unknown;

type StablePresentationValue =
  | { kind: 'atomic'; source: unknown; value: unknown }
  | {
      kind: 'function';
      slot: { current: FloatingCallback };
      value: FloatingCallback;
    }
  | { kind: 'array'; entries: readonly StablePresentationValue[]; value: readonly unknown[] }
  | {
      kind: 'element';
      elementKey: React.Key | null;
      elementType: React.ReactElement['type'];
      props: StablePresentationValue;
      value: React.ReactElement;
    }
  | {
      kind: 'record';
      entries: Readonly<Record<string, StablePresentationValue>>;
      value: Readonly<Record<string, unknown>>;
    };

/**
 * Whether this reconciler can REBUILD the object faithfully — which is the only
 * thing it ever does with a record: `Object.fromEntries(Object.keys(...))`, a
 * copy that can carry nothing but enumerable string-keyed own properties.
 *
 * A Unistyles style is the counter-example, and the reason this question has to
 * be asked at all. `StyleSheet.create` returns the parsed properties plus one
 * enumerable `unistyles_<hash>` key holding the style's C++ handle, and every
 * member of that handle — `uni__getStyles` among them — is defined
 * `enumerable: false` (`cxx/common/Helpers.h → defineHiddenProperty`). Copying
 * it by its enumerable keys therefore yields `{}`: the key survives, the handle
 * inside it does not. Most Unistyles components then recover through the C++
 * hash-key fallback, but the `Pressable` wrapper reads the handle from JS and
 * calls `style[unistyles_<hash>].uni__getStyles()`, so an emptied handle
 * crashed the render outright — the Room member picker's candidate rows are
 * the app's one `Pressable` with an object `style` mounted as HullModal
 * children, so opening that picker was the one place it fired.
 *
 * An object this cannot reproduce is passed through by identity instead
 * (the atomic branch), which is both correct and no less stable: a style object
 * is allocated once by `StyleSheet.create` and is the same reference on every
 * render, so `Object.is` keeps reusing it.
 */
function isRebuildableRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.getOwnPropertyNames(value).length === Object.keys(value).length;
}

/**
 * Reconcile one floating presentation by visible value, not allocation identity.
 * React event callback slots stay live even when the rendered tree keeps its
 * prior identity. Render/style functions remain presentation-significant.
 */
function reconcilePresentationValue(
  previous: StablePresentationValue | undefined,
  next: unknown,
  propertyKey?: string,
): StablePresentationValue {
  const isEventCallback = propertyKey === 'ref' || /^on[A-Z]/.test(propertyKey ?? '');
  if (typeof next === 'function' && isEventCallback) {
    const latest = next as FloatingCallback;
    if (previous?.kind === 'function') {
      previous.slot.current = latest;
      return previous;
    }
    const slot: { current: FloatingCallback } = { current: latest };
    const value = function (this: unknown, ...args: unknown[]) {
      return slot.current.apply(this, args);
    };
    const stable: StablePresentationValue = {
      kind: 'function',
      slot,
      value,
    };
    return stable;
  }

  if (React.isValidElement(next)) {
    const element = next as React.ReactElement<Record<string, unknown>>;
    const previousElement =
      previous?.kind === 'element' &&
      previous.elementType === element.type &&
      previous.elementKey === element.key
        ? previous
        : undefined;
    const props = reconcilePresentationValue(previousElement?.props, element.props);
    if (previousElement && props === previousElement.props) return previousElement;
    return {
      kind: 'element',
      elementKey: element.key,
      elementType: element.type,
      props,
      value: React.cloneElement(element, props.value as Record<string, unknown>),
    };
  }

  if (Array.isArray(next)) {
    const previousArray = previous?.kind === 'array' ? previous : undefined;
    const entries = next.map((value, index) =>
      reconcilePresentationValue(previousArray?.entries[index], value, propertyKey),
    );
    if (
      previousArray &&
      entries.length === previousArray.entries.length &&
      entries.every((entry, index) => entry === previousArray.entries[index])
    ) {
      return previousArray;
    }
    return {
      kind: 'array',
      entries,
      value: entries.map((entry, index) =>
        React.isValidElement(entry.value) && entry.value.key === null
          ? React.cloneElement(entry.value, { key: `floating-presentation-${index}` })
          : entry.value,
      ),
    };
  }

  if (next !== null && typeof next === 'object' && isRebuildableRecord(next)) {
    const previousRecord = previous?.kind === 'record' ? previous : undefined;
    const keys = Object.keys(next);
    const entries: Record<string, StablePresentationValue> = {};
    let unchanged = Boolean(
      previousRecord && keys.length === Object.keys(previousRecord.entries).length,
    );
    for (const key of keys) {
      const entry = reconcilePresentationValue(previousRecord?.entries[key], next[key], key);
      entries[key] = entry;
      unchanged = unchanged && entry === previousRecord?.entries[key];
    }
    if (previousRecord && unchanged) return previousRecord;
    return {
      kind: 'record',
      entries,
      value: Object.fromEntries(keys.map((key) => [key, entries[key]!.value])),
    };
  }

  if (previous?.kind === 'atomic' && Object.is(previous.source, next)) return previous;
  return { kind: 'atomic', source: next, value: next };
}

function useStableFloatingPresentation(props: HullModalProps): HullModalProps {
  const presentation = React.useRef<StablePresentationValue | undefined>(undefined);
  // Android's Modal renders nothing while hidden. Keep its outer callbacks
  // stable without walking content; iOS retains content through dismissal.
  presentation.current = reconcilePresentationValue(
    presentation.current,
    Platform.OS === 'android' && !props.visible ? { ...props, children: null } : props,
  );
  return presentation.current.value as HullModalProps;
}

/**
 * The only React Native Modal boundary owned by Beeline. Every app-rendered
 * floating surface gets the same scrim, keyboard behavior, platform-back
 * semantics, and accessibility isolation before choosing its HullSurface
 * content shape.
 */
const StableHullModal = React.memo(function StableHullModal({
  accessibilityLabel = 'Close dialog',
  animationType = 'fade',
  children,
  contentMaxHeight,
  contentMaxWidth,
  dismissOnBackdrop = true,
  keyboardAvoiding = true,
  onDismiss,
  onRequestClose,
  placement = 'center',
  scrimTestID,
  testID,
  visible,
  withinScreen = false,
}: HullModalProps) {
  React.useLayoutEffect(() => {
    if (!withinScreen || Platform.OS !== 'android' || !visible) return;
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      onRequestClose();
      return true;
    });
    return () => back.remove();
  }, [onRequestClose, visible, withinScreen]);
  const body = (
    <KeyboardFrame
      behavior={Platform.OS === 'ios' ? 'padding' : 'translate-with-padding'}
      enabled={keyboardAvoiding}
      alignItems={placement === 'fill' ? undefined : 'center'}
      justifyContent={placement === 'center' ? 'center' : placement === 'bottom' ? 'flex-end' : undefined}
      padding={placement === 'center' ? '6' : 0}
      testID={testID}
    >
      {dismissOnBackdrop ? (
        <YStack
          position="absolute"
          top={0}
          right={0}
          bottom={0}
          left={0}
          backgroundColor="canvas"
          opacity={0.82}
          accessibilityLabel={accessibilityLabel}
          accessibilityRole="button"
          onPress={onRequestClose}
          testID={scrimTestID}
        />
      ) : (
        <YStack
          position="absolute"
          top={0}
          right={0}
          bottom={0}
          left={0}
          backgroundColor="canvas"
          opacity={0.82}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      )}
      <YStack
        accessibilityViewIsModal
        zIndex={1}
        minWidth={0}
        width="100%"
        flex={placement === 'fill' ? 1 : undefined}
        maxWidth={contentMaxWidth ?? (placement === 'center' ? 460 : placement === 'bottom' ? 600 : undefined)}
        maxHeight={contentMaxHeight}
      >
        {children}
      </YStack>
    </KeyboardFrame>
  );
  if (withinScreen && Platform.OS === 'android') {
    return visible ? (
      <MotionLayer exiting={FadeOut.duration(200).easing(Easing.quad).reduceMotion(ReduceMotion.System)}>
        {body}
      </MotionLayer>
    ) : null;
  }
  return (
    <Modal
      animationType={animationType}
      navigationBarTranslucent
      onDismiss={onDismiss}
      onRequestClose={onRequestClose}
      // The sheet paints behind the navigation bar; Android's 3-button scrim would hide it.
      onShow={clearModalNavigationBarScrim}
      statusBarTranslucent
      transparent
      visible={visible}
    >
      {body}
    </Modal>
  );
});

/**
 * Every floating member crosses this one identity boundary. A churning host can
 * refresh callback closures without asking React Native to lay out the mounted
 * Modal again; a visible prop or presentation-value change still renders.
 */
export function HullModal(props: HullModalProps) {
  const presentation = useStableFloatingPresentation(props);
  return <StableHullModal {...presentation} />;
}

type HullDialogProps = Omit<HullModalProps, 'children' | 'placement'> & {
  actions: readonly HullDialogAction[];
  body?: string;
  children?: React.ReactNode;
  contentLayout?: 'intrinsic' | 'fill';
  title: string;
};

/** Centered confirm/alert/input member of the floating Hull family. */
export function HullDialog({
  actions,
  body,
  children,
  contentLayout = 'intrinsic',
  title,
  testID,
  ...modalProps
}: HullDialogProps) {
  const primaryIndex = actions.findIndex((action) => action.variant === 'primary');
  return (
    <HullModal {...modalProps} placement="center" testID={testID}>
      <HullFloatingSurface width="100%">
        <YStack
          flexShrink={1}
          flex={contentLayout === 'fill' ? 1 : undefined}
          minHeight={0}
          overflow="hidden"
          paddingHorizontal="6"
          paddingTop="6"
          paddingBottom="4"
        >
          <T v="heading" accessibilityRole="header">
            {title}
          </T>
          {body ? <T v="meta" color="secondary" marginTop="2">{body}</T> : null}
          {children ? (
            <YStack flexShrink={1} flex={contentLayout === 'fill' ? 1 : undefined} minHeight={0}>
              {children}
            </YStack>
          ) : null}
        </YStack>
        <HullDialogActions
          actions={actions.map((action, index) =>
            action.variant === 'primary' && index !== primaryIndex
              ? { ...action, variant: 'quiet' as const }
              : action,
          )}
          flexShrink={0}
          // Quiet buttons carry their own md padding, so sm here lands their
          // labels on the copy's lg edge.
          paddingHorizontal="2"
          paddingVertical="2"
          justifyContent="center"
          borderTopWidth={HULL_DIALOG_LAYOUT.actionBorderTopWidth}
          borderTopColor="stroke"
        />
      </HullFloatingSurface>
    </HullModal>
  );
}

/**
 * Shared trailing decision row, used by dialogs, sheet forms and inline
 * decisions. Layout props frame the row; the buttons sit trailing inside it.
 */
export function HullDialogActions({
  actions,
  ...frame
}: {
  actions: readonly HullDialogAction[];
} & YStackProps) {
  return (
    <YStack {...frame}>
      <ButtonRow actions={actions} />
    </YStack>
  );
}

const INPUT_LAYOUT_KEYS = [
  'flex',
  'flexGrow',
  'flexShrink',
  'flexBasis',
  'alignSelf',
  'width',
  'minWidth',
  'maxWidth',
  'margin',
  'marginHorizontal',
  'marginVertical',
  'marginTop',
  'marginBottom',
  'marginLeft',
  'marginRight',
] as const;

export const HullDialogInput = React.forwardRef<
  TextInput,
  InputProps & {
    accessory?: React.ReactNode;
    // Search cells share the page or sheet row geometry; dialog fields keep
    // their original underline. Room search matches the compact filter row.
    variant?: 'dialog' | 'boxed' | 'search' | 'sheetSearch' | 'roomSearch';
    // Read-only tap target, e.g. Connectors search that opens the search sheet.
    onPress?: () => void;
  }
>(function HullDialogInput({ variant = 'dialog', onPress, accessory, ...props }, ref) {
  // Layout belongs to the wrapper; the native field owns only its shared type
  // and underline geometry. Keep flex/margins at existing row/search callers.
  const [focused, setFocused] = React.useState(false);
  const outer: Record<string, unknown> = {};
  const inner: Record<string, unknown> = { ...props };
  for (const key of INPUT_LAYOUT_KEYS) {
    if (key in props) outer[key] = (props as Record<string, unknown>)[key];
    delete inner[key];
  }
  const boxed = variant === 'boxed';
  const searchCell = variant === 'search' || variant === 'sheetSearch' || variant === 'roomSearch';
  const box = (field: React.ReactNode, withAccessory: boolean) => (
    <XStack
      alignSelf="stretch"
      alignItems={withAccessory ? 'center' : undefined}
      flexDirection={withAccessory ? 'row' : 'column'}
      justifyContent={boxed || searchCell ? 'center' : undefined}
      marginTop={boxed || searchCell ? 0 : '4'}
      borderBottomWidth={HAIRLINE}
      borderBottomColor={focused ? 'needsYou' : 'strongStroke'}
      borderWidth={boxed ? HAIRLINE : undefined}
      borderColor={boxed ? (focused ? 'needsYou' : 'strongStroke') : undefined}
      borderRadius={boxed ? 'sm' : 0}
      paddingHorizontal={boxed ? '4' : 0}
      paddingVertical={boxed ? '2' : 0}
      minHeight={
        boxed || variant === 'roomSearch'
          ? HEIGHT.control
          : variant === 'sheetSearch'
            ? HEIGHT.tabBar
            : variant === 'search'
              ? HEIGHT.sheetRow
              : 0
      }
      {...outer}
    >
      {field}
    </XStack>
  );
  const field = (readOnly: boolean) => (
    <Input
      placeholderTextColor="secondary"
      {...inner}
      ref={ref as never}
      flex={accessory ? 1 : undefined}
      minWidth={accessory ? 0 : undefined}
      minHeight={boxed || searchCell ? 0 : props.multiline ? undefined : HEIGHT.control}
      height={props.multiline ? 120 : undefined}
      flexGrow={variant === 'roomSearch' ? 1 : undefined}
      paddingHorizontal={searchCell && variant !== 'roomSearch' ? (variant === 'sheetSearch' ? '6' : '2') : 0}
      paddingVertical={boxed ? 0 : '2'}
      color="ink"
      backgroundColor="transparent"
      borderWidth={0}
      borderRadius="sm"
      outlineWidth={0}
      textAlign="left"
      textAlignVertical={props.multiline ? 'top' : 'center'}
      onFocus={(event) => {
        setFocused(true);
        props.onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        props.onBlur?.(event);
      }}
      {...(readOnly
        ? {
            editable: false,
            pointerEvents: 'none' as const,
            testID: undefined,
            importantForAccessibility: 'no' as const,
            accessibilityElementsHidden: true,
          }
        : null)}
    />
  );
  if (onPress) {
    return (
      <YStack
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        onPress={onPress}
        alignSelf="stretch"
        testID={props.testID}
      >
        {box(field(true), Boolean(accessory))}
      </YStack>
    );
  }
  return box(
    <>
      {field(false)}
      {accessory}
    </>,
    Boolean(accessory),
  );
});

import React from 'react';
import { Platform, Switch } from 'react-native';
import { YStack, useTheme, useThemeName } from 'tamagui';

export type HullSwitchProps = {
  accessibilityLabel?: string;
  disabled?: boolean;
  /** False inside a disabled row, which already carries the disabled opacity. */
  dimWhenDisabled?: boolean;
  onValueChange: (value: boolean) => void;
  testID?: string;
  value: boolean;
};

/**
 * The one switch: brass when on, the secondary-text colour when off. The thumb
 * stays light in both themes so it reads against either track.
 */
export function HullSwitch({
  accessibilityLabel,
  dimWhenDisabled = true,
  disabled,
  onValueChange,
  testID,
  value,
}: HullSwitchProps) {
  const t = useTheme();
  const dark = useThemeName().startsWith('dark');
  const thumb = dark ? t.ink?.val : t.canvas?.val;
  const off = t.secondary?.val;
  return (
    // Custom track colours stop the platform from dimming a disabled switch.
    <YStack opacity={disabled && dimWhenDisabled ? 0.42 : 1}>
      <Switch
        accessibilityLabel={accessibilityLabel}
        disabled={disabled}
        // The off track must stand apart from the surface, or the thumb floats
        // alone and the state cannot be read.
        ios_backgroundColor={off}
        onValueChange={onValueChange}
        testID={testID}
        thumbColor={thumb}
        // react-native-web paints the on thumb from its own prop.
        {...(Platform.OS === 'web' ? { activeThumbColor: thumb } : {})}
        trackColor={{ false: off, true: t.needsYou?.val }}
        value={value}
      />
    </YStack>
  );
}

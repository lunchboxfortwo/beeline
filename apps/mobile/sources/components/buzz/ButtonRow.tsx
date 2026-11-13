import React from 'react';
import type { View } from 'react-native';
import { XStack, YStack, type XStackProps, type YStackProps } from 'tamagui';
import { Button, type ButtonProps } from './Button';
/** Shared layout frame for existing icon and emoji action targets. */
export function ButtonRowFrame(props: YStackProps & { ref?: React.Ref<View> }) {
  return <YStack {...(props as YStackProps)} />;
}

export type ButtonRowAction = Pick<
  ButtonProps,
  | 'label'
  | 'variant'
  | 'labelTone'
  | 'accessibilityRole'
  | 'accessibilityLabel'
  | 'loading'
  | 'disabled'
  | 'onPress'
  | 'testID'
  | 'destination'
> & { busy?: boolean; description?: React.ReactNode };
/** Shared action layout for cards and inline decisions; the Button owns every target. */
export function ButtonRow({
  actions,
  ...frame
}: {
  actions: readonly ButtonRowAction[];
} & Omit<XStackProps, 'children'>) {
  if (actions.filter((action) => action.variant === 'primary').length > 1) {
    throw new Error('A decision row permits only one primary action');
  }
  if (actions.some((action) => action.accessibilityRole === 'link')) {
    throw new Error('Links belong outside ButtonRow at the start of the footer');
  }
  return (
    <XStack flexWrap="wrap" alignItems="center" justifyContent="flex-end" gap="2" {...frame}>
      {actions.map((action) => (
        <YStack
          key={`${action.testID ?? action.label}:${action.variant ?? 'quiet'}`}
          flexShrink={1}
        >
          <Button
            {...(action.accessibilityRole ? { accessibilityRole: action.accessibilityRole } : {})}
            label={action.label}
            labelTone={action.labelTone}
            variant={action.variant ?? 'quiet'}
            accessibilityLabel={action.accessibilityLabel ?? action.label}
            accessibilityState={{ busy: action.busy === true }}
            loading={action.loading}
            disabled={action.disabled}
            onPress={action.onPress}
            testID={action.testID}
            destination={action.destination}
          />
          {action.description}
        </YStack>
      ))}
    </XStack>
  );
}

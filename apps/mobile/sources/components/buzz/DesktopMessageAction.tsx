import React, { useState } from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { YStack, useTheme } from 'tamagui';
import { T } from '@/ui/grammar';

type Action = 'copy' | 'reply' | 'react' | 'report' | 'forward' | 'thread' | 'more';

/** The desktop ledger's actions share one outline scale and named tooltip. */
export function DesktopMessageAction({
  action,
  label,
  tooltip,
  onPress,
  onFocus,
  onBlur,
  testID,
}: {
  action: Action;
  label: string;
  tooltip: string;
  onPress?: () => void;
  onFocus: () => void;
  onBlur: () => void;
  testID: string;
}) {
  const [named, setNamed] = useState(false);
  const [pressed, setPressed] = useState(false);
  const theme = useTheme();
  const ink = theme.secondary?.val as string;
  return (
    <YStack
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      onFocus={() => {
        setNamed(true);
        onFocus();
      }}
      onBlur={() => {
        setNamed(false);
        onBlur();
      }}
      onMouseEnter={() => setNamed(true)}
      onMouseLeave={() => setNamed(false)}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      tabIndex={0}
      cursor="pointer"
      width={44}
      height={44}
      alignItems="center"
      justifyContent="center"
      borderRadius="sm"
      backgroundColor={pressed || named ? 'highlight' : 'transparent'}
      testID={testID}
    >
      <Svg
        width={18}
        height={18}
        viewBox="0 0 24 24"
        fill="none"
        stroke={ink}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {action === 'copy' ? (
          <>
            <Rect x={8} y={8} width={12} height={12} rx={2} />
            <Path d="M16 8V4H4v12h4" />
          </>
        ) : null}
        {action === 'reply' ? <Path d="m9 5-6 6 6 6M3 11h10a7 7 0 0 1 7 7" /> : null}
        {action === 'react' ? (
          <>
            <Circle cx={12} cy={12} r={9} />
            <Path d="M8 14q4 5 8 0M8 9h.01M16 9h.01" />
          </>
        ) : null}
        {action === 'report' ? <Path d="M5 21V3m0 0h14l-3 5 3 5H5" /> : null}
        {action === 'forward' ? <Path d="m15 5 6 6-6 6M21 11H11a7 7 0 0 0-7 7" /> : null}
        {action === 'thread' ? <Path d="m15 10 5 5-5 5M4 4v7a4 4 0 0 0 4 4h12" /> : null}
        {action === 'more' ? (
          <>
            <Circle cx={5} cy={12} r={1} />
            <Circle cx={12} cy={12} r={1} />
            <Circle cx={19} cy={12} r={1} />
          </>
        ) : null}
      </Svg>
      {named ? (
        <YStack
          pointerEvents="none"
          position="absolute"
          bottom="100%"
          right={0}
          marginBottom="2"
          padding="2"
          backgroundColor="raised"
          borderWidth={1}
          borderColor="strongStroke"
          borderRadius="sm"
          zIndex={2}
          testID={`${testID}-tooltip`}
        >
          <T v="meta" whiteSpace="nowrap">{tooltip}</T>
        </YStack>
      ) : null}
    </YStack>
  );
}

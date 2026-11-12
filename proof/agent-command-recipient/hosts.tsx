// Browser-only host adapters. Production TranscriptLine, PillRow and IdentityMark
// own the layout; this harness replaces native hosts and app service providers.
import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { beelineThemes } from '../../apps/mobile/sources/buzz/groknight';
const dark = new URLSearchParams(location.search).get('theme') !== 'bone';
const theme = dark ? beelineThemes.obsidian : beelineThemes.bone;
document.documentElement.dataset.theme = dark ? 'Obsidian' : 'Bone';
document.body.style.background = theme.bgBase;
const steps: Record<string, number> = { '0': 0, '0.5': 2, '1': 4, '2': 8, '3': 12, '4': 16, '5': 20, '6': 24, '8': 32 };
const step = (value: any) => typeof value === 'string' && value in steps ? steps[value] : value;
export function Stack({ children, gap, padding, paddingLeft, paddingHorizontal, borderColor, backgroundColor, borderRadius, ...rest }: any) {
  return <View {...rest} style={{ gap: step(gap), padding: step(padding), paddingLeft: step(paddingLeft),
    paddingHorizontal: step(paddingHorizontal), borderColor: theme.border, backgroundColor: backgroundColor ? theme.bgHighlight : undefined,
    borderRadius: borderRadius === 'full' ? 100 : borderRadius === 'sm' ? 3 : borderRadius,
    ...Object.fromEntries(Object.entries(rest).filter(([key]) => ['width','maxWidth','minWidth','minHeight','flex','flexWrap','alignItems','borderWidth','borderLeftWidth','height','position','top','left','overflow','justifyContent'].includes(key))) }}>{children}</View>;
}
export const YStack = Stack;
export const XStack = (props: any) => <View testID={props.testID} style={{ flexDirection: 'row', gap: step(props.gap), alignItems: props.alignItems,
  width: props.width, minWidth: props.minWidth, flexWrap: props.flexWrap }}>{props.children}</View>;
export const HEIGHT = { control: 44 };
export function T({ children, v = 'body', color, testID }: any) {
  return <Text testID={testID} style={{ color: color === 'secondary' ? theme.textSecondary : theme.textPrimary,
    fontFamily: v === 'heading' || v === 'metaStrong' ? 'SpaceGrotesk-SemiBold' : 'SpaceGrotesk-Regular',
    fontSize: v.startsWith('meta') ? 13 : 16, lineHeight: v.startsWith('meta') ? 19 : 23 }}>{children}</Text>;
}
export const Copy = ({ children }: any) => <T v="meta">{children}</T>;
export const Glyph = () => <T color="secondary">→</T>;
export const Btn = ({ children, onPress, label, testID, ...rest }: any) => <Pressable testID={testID} onPress={onPress} accessibilityLabel={label}
  style={{ flexDirection: 'row', gap: 4, paddingHorizontal: 8, minHeight: 44, alignItems: 'center',
    borderWidth: 1, borderRadius: 100, borderColor: theme.border, backgroundColor: theme.bgHighlight }}>{children}</Pressable>;
export const useThemeName = () => dark ? 'dark' : 'light';
export const useTheme = () => new Proxy({}, { get: (_, key) => ({ val: (theme as any)[key] ?? theme.textPrimary }) });
export const Filled = ({ view: Component, ...rest }: any) => <Component {...rest} />;
export const DrawnType = ({ view: Component, children, ...rest }: any) => <Component {...rest}>{children}</Component>;
export const HullLivePulse = ({ children }: any) => <>{children}</>;

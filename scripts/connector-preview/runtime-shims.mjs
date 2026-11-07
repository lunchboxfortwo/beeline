import path from 'node:path';
export function webProofShims(mobile) {
  return {
    // External telemetry is outside UI proofs. Its SDK eagerly imports Expo
    // Router integrations, which must not bypass these proofs' navigation shims.
    '@sentry/react-native':
      'export const init = () => {}; export const captureException = () => {};',
    './draft-identity':
      'export const useDraftIdentity = explicit => explicit === undefined ? "proof-viewer" : explicit;',
    'react-native-unistyles': `import { beelineThemes } from '${path.join(mobile, 'sources/buzz/groknight')}';
    const theme = { buzz: beelineThemes.obsidian };
    theme.colors ??= { groupped: { background: theme.buzz.bgTerminal } };
    export const StyleSheet = { create: factory => (typeof factory === 'function' ? factory(theme) : factory), hairlineWidth: 1,
      absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } };
    export const useUnistyles = () => ({ theme });`,
    'expo-clipboard': 'export const setStringAsync = async () => true;',
    'expo-haptics': `export const selectionAsync = async () => undefined;
    export const impactAsync = async () => undefined;
    export const ImpactFeedbackStyle = { Light: 'light' };`,
    // expo-modules-core (pulled in by expo-web-browser) reads Node's `process`
    // at module scope, which this plain browser bundle never defines.
    'expo-web-browser': 'export const openAuthSessionAsync = async () => ({ type: "cancel" });',
    'react-native-keyboard-controller': `export { KeyboardAvoidingView } from 'react-native';
    export const useKeyboardState = selector => selector({ height: 0, isVisible: false });`,
    'react-native-safe-area-context':
      'export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });',
    'react-native-device-info': `export const getDeviceType = () => 'Desktop';`,
    'react-native-reanimated': `import { useRef } from 'react'; import { Animated } from 'react-native';
    const identity = value => value;
    export const Easing = new Proxy({}, { get: () => (...args) => (typeof args[0] === 'function' ? args[0] : identity) });
    const entering = new Proxy({}, { get: () => () => entering });
    export const FadeInDown = entering;
    export const ReduceMotion = { System: 'system' };
    export const useReducedMotion = () => true;
    export const useEvent = handler => handler;
    export const useAnimatedStyle = factory => factory();
    export const useFrameCallback = () => ({ setActive: () => undefined, isActive: false });
    export const useSharedValue = value => ({ value });
    export const withRepeat = identity; export const withSequence = (...v) => v[0];
    export const withSpring = identity;
    export const useAnimatedRef = () => useRef(null);
    export const measure = ref => { const rect = ref.current?.getBoundingClientRect(); return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, pageX: rect.x, pageY: rect.y } : null; };
    export const withTiming = identity; export const withDelay = (_, value) => value;
    export const cancelAnimation = () => undefined;
    export const runOnJS = fn => fn; export const runOnUI = fn => fn;
    export const useAnimatedProps = factory => factory();
    export const useDerivedValue = factory => ({ value: factory() });
    export const interpolate = identity;
    export default { View: Animated.View, Text: Animated.Text, createAnimatedComponent: c => c };`,
  };
}

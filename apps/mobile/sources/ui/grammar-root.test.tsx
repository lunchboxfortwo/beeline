import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

const keyboard = vi.hoisted(() => ({ height: { value: 0 } }));
vi.mock('react-native-keyboard-controller', () => ({ useReanimatedKeyboardAnimation: () => keyboard }));
vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  return {
    default: { View: (props: any) => ReactModule.createElement('AnimatedView', props, props.children) },
    useAnimatedStyle: (style: () => object) => style(),
  };
});
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
  return { Platform: { OS: 'android' }, Text: host('Text'), TextInput: host('TextInput'), View: host('View') };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-gesture-handler', () => ({ GestureHandlerRootView: () => null }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
import { KeyboardBody } from './grammar-root';

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

function bodyPadding() {
  let tree: any;
  act(() => { tree = create(<KeyboardBody />); });
  const style = tree.root.findByType('AnimatedView' as any).props.style;
  return Object.assign({}, ...style).paddingBottom;
}

// A body that slid up by the keyboard drew its transcript over the Room header
// and took the header's taps; one that kept its own copy of the keyboard state
// mounted with the previous screen's keyboard still counted as open. The body
// pads its bottom by the app-wide keyboard height and never moves.
it('pads its bottom by the live keyboard height, and by nothing once it is closed', () => {
  keyboard.height.value = -300;
  expect(bodyPadding()).toBe(300);
  keyboard.height.value = 0;
  expect(Math.abs(bodyPadding())).toBe(0);
});

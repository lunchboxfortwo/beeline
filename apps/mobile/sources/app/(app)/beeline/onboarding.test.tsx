vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('@expo/vector-icons/Ionicons', async () => { const R = await import('react'); return { default: (props: any) => R.createElement('Ionicons', props) }; });
vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'Light' }, impactAsync: async () => undefined }));
vi.mock('react-native-keyboard-controller', async () => { const R = await import('react'); return { KeyboardAvoidingView: (props: any) => R.createElement('View', props, props.children) }; });
vi.mock('tamagui', async () => (await import('@/ui/screens/onboarding/onboarding.test-support')).tamaguiMock());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/onboarding/onboarding.test-support')).lucideMock());
vi.mock('@/ui/screens/onboarding/Rise', async () => (await import('@/ui/screens/onboarding/onboarding.test-support')).riseMock());
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * Canonical brand treatment on the welcome step (owner spec, 2026-08-23;
 * build spec decision 29): the wordmark reads exactly `beeline.` with the
 * trailing period in brass, and every type style comes from the grammar's
 * six styles — no logo-font exception, no new fonts.
 */

const SOURCE_PATH = resolve(__dirname, 'onboarding.tsx');
const source = () => readFileSync(SOURCE_PATH, 'utf8');

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const googleSignIn = vi.hoisted(() => vi.fn(() => new Promise(() => undefined)));

vi.mock('expo-router', () => ({ router: navigation }));
vi.mock('expo-linking', () => ({
  createURL: (p: string) => `beeline://${p}`,
  addEventListener: vi.fn(() => ({ remove: vi.fn() })),
}));
vi.mock('@/auth/google-auth-session', () => ({
  clearPendingGoogleSignIn: vi.fn(async () => undefined),
  resumeGoogleSignIn: vi.fn(async () => null),
  runGoogleSignIn: googleSignIn,
}));
vi.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession: vi.fn(),
  openAuthSessionAsync: vi.fn(),
}));
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked',
  setItemAsync: vi.fn(async () => undefined),
  getItemAsync: vi.fn(async () => null),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('@/buzz/person-name', () => ({
  clearPersonNameOnboardingPending: vi.fn(async () => undefined),
  isPersonNameOnboardingPending: vi.fn(async () => false),
  loadPreferredPersonName: vi.fn(async () => null),
  markPersonNameOnboardingPending: vi.fn(async () => undefined),
  publishPreferredPersonName: vi.fn(async () => undefined),
  resolveOnboardingPersonName: vi.fn(async () => ({
    needsPrompt: false,
    name: 'Ada',
    communityId: 'w1',
  })),
  savePreferredPersonName: vi.fn(async () => undefined),
}));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ relayUrl: 'https://relay.test' }),
}));
vi.mock('@/push/buzz-push-registration', () => ({
  registerBuzzPushNotifications: vi.fn(async () => undefined),
}));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = vi.fn(async () => ({}));
  },
}));
vi.mock('@/components/buzz/BeelineMark', async () => {
  const ReactModule = await import('react');
  return { BeelineMark: (props: any) => ReactModule.createElement('BeelineMark', props) };
});
vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    Platform: {
      OS: 'android',
      select: (choices: Record<string, unknown>) => choices.android ?? choices.default,
    },
    StyleSheet: { flatten: (style: any): any => Array.isArray(style) ? Object.assign({}, ...style) : style,  create: (styles: Record<string, unknown>) => styles },
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
// The Node test environment never runs React Native's entrypoint, so Expo's
// logger setup (pulled in through the onboarding import graph) needs __DEV__.
(globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = true;

const { default: BuzzOnboarding } = await import('./onboarding');

describe('onboarding — canonical brand treatment', () => {
  it('renders the wordmark as exactly "beeline." with a brass period glyph', async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(BuzzOnboarding));
    });

    const marks = tree.root.findAll(
      (node: any) => typeof node.type === 'string' && node.props?.testID === 'onboarding-wordmark',
      { deep: true },
    );
    expect(marks).toHaveLength(1);
    const children = marks[0].props.children;
    expect(Array.isArray(children)).toBe(true);
    // The word itself…
    expect(children[0]).toBe('beeline');
    // …and its trailing period, in the title style and brass.
    const period = children[1];
    expect(period.props.children).toBe('.');
    expect(period.props.color).toBe('needsYou');
    expect(period.props.v).toBe('title');
    expect(marks[0].props.fontFamily).toBe('SpaceGrotesk-SemiBold');
  });

  it('renders the original tagline and both providers as 52 px actions, GitHub first', async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(BuzzOnboarding));
    });

    const byTestID = (testID: string) =>
      tree.root.findAll(
        (node: any) => typeof node.type === 'string' && node.props?.testID === testID,
        { deep: true },
      );

    const tagline = byTestID('onboarding-tagline');
    expect(tagline).toHaveLength(1);
    expect(tagline[0].props.children).toBe('workspace for all intelligence');
    expect(tagline[0].props.fontFamily).toBe('SpaceGrotesk-Regular');

    const github = byTestID('onboarding-github-sign-in').find((node: any) => node.type === 'Button');
    expect(github?.props['aria-label']).toBe('Continue with GitHub');
    expect(github?.props.theme).toBe('button');
    expect(github?.props.minHeight).toBe(52);
    const google = byTestID('onboarding-google-sign-in').find((node: any) => node.type === 'Button');
    expect(google?.props['aria-label']).toBe('Continue with Google');
    expect(google?.props.minHeight).toBe(52);
    const words = tree.root.findAll((node: any) => node.type === 'Text').map((node: any) => node.props.children);
    expect(words).toContain('GitHub is recommended.');
  });
});

describe('onboarding — a pending sign-in leaves the buttons usable', () => {
  it('starts a fresh Google attempt when the first one is still open', async () => {
    googleSignIn.mockClear();
    googleSignIn.mockImplementation(() => new Promise(() => undefined));
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(BuzzOnboarding));
    });
    const button = () => tree.root.findAll(
      (node: any) => node.props?.testID === 'onboarding-google-sign-in' && node.type === 'Button',
    )[0];
    const github = () => tree.root.findAll(
      (node: any) => node.props?.testID === 'onboarding-github-sign-in' && node.type === 'Button',
    )[0];
    // The device check awaits several stores before it enables the buttons.
    // Wait for it to finish instead of a fixed number of microtask turns.
    await vi.waitFor(async () => {
      await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
      expect(button().props.disabled).toBe(false);
    });
    await act(async () => { button().props.onPress(); });
    expect(googleSignIn).toHaveBeenCalledTimes(1);
    expect(button().props.disabled).toBe(false);
    expect(github().props.disabled).toBe(false);
    await act(async () => { button().props.onPress(); });
    expect(googleSignIn).toHaveBeenCalledTimes(2);
  });
});

describe('onboarding — grammar source assertions', () => {
  it('keeps the wordmark period a separate brass title inside the title', () => {
    expect(source()).toContain('beeline<T v="title" color="needsYou">.</T>');
  });

  it('builds the welcome on the grammar, with no hand-built styles left', () => {
    const src = source();
    expect(src).toContain('<OnboardingFrame');
    expect(src).not.toContain('react-native-unistyles');
    expect(src).not.toMatch(/\bstyle=/);
    expect(src).not.toContain('Typography.logo()');
    expect(src.match(/minHeight=\{HEIGHT\.tabBar\}/g)).toHaveLength(2);
  });
});

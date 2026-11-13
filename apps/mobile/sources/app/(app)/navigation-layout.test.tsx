import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({ path: '/beeline/channels', listeners: new Set<() => void>() }));
const stackRender = vi.hoisted(() => vi.fn());
let screenLayout: any;
const replace = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({ mayRedirect: undefined as undefined | (() => boolean) }));
vi.mock('expo-router', async () => {
  const React = await import('react');
  const Stack = Object.assign(({ children, screenLayout: layout }: { children: React.ReactNode; screenLayout?: unknown }) => {
    screenLayout = layout;
    stackRender();
    return React.createElement('Stack', null, children);
  }, { Screen: () => null });
  return {
    Stack, router: { replace },
    usePathname: () => React.useSyncExternalStore(
      (listener) => { route.listeners.add(listener); return () => { route.listeners.delete(listener); }; },
      () => route.path,
    ),
  };
});
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('tamagui', () => ({ YStack: 'View', useTheme: () => ({ canvas: { val: 'black' } }), useThemeName: () => 'dark' }));
vi.mock('@/auth/session-required', () => ({ watchSessionRequired: (_onRequired: () => void, _session: unknown, mayRedirect: () => boolean) => { session.mayRedirect = mayRedirect; return () => {}; } }));
vi.mock('@/components/StatusBarProvider', () => ({ statusBarStyleForTheme: () => 'light' }));
vi.mock('@/components/buzz/ConnectionStatus', () => ({ ConnectionStatus: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/buzz/CornerOpenToast', () => ({ CornerOpenToast: () => null }));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('@/ui/shell/PhoneTabScreen', () => ({ PhoneTabScreen: (props: any) => React.createElement('TabScreen', props) }));
import RootLayout from './_layout';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it('moves between list, Room and redemption without rebuilding the stack options', async () => {
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<RootLayout />); });
  const initial = stackRender.mock.calls.length;
  for (const path of ['/beeline/chat/room', '/beeline/channels', '/review/local']) {
    await act(async () => { route.path = path; route.listeners.forEach((listener) => listener()); });
    expect(session.mayRedirect?.()).toBe(!path.startsWith('/review/'));
  }
  expect(stackRender.mock.calls.length).toBe(initial);
  await act(async () => tree.unmount());
});

it('places tabs inside each native screen so a chat never resizes the retained list', async () => {
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<RootLayout />); });
  expect(screenLayout).toBeTypeOf('function');
  let deck: ReturnType<typeof create>;
  await act(async () => { deck = create(screenLayout({ route: { name: 'index' }, children: React.createElement('List') })); });
  expect(deck.root.findByType('TabScreen').props.route.name).toBe('index');
  expect(tree.root.findAllByType('Tabs')).toHaveLength(0);
  await act(async () => { deck.unmount(); tree.unmount(); });
});

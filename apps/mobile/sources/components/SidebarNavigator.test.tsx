import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
const viewport = vi.hoisted(() => ({ tablet: false, listeners: new Set<() => void>() }));
const route = vi.hoisted(() => ({ mounts: 0 }));
vi.mock('lucide-react-native', () => ({ ChevronLeft: () => null, ChevronRight: () => null }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('expo-router', () => ({
  Slot: () => {
    const [draft, setDraft] = React.useState('');
    React.useEffect(() => { route.mounts++; }, []);
    return React.createElement('Draft', { value: draft, onChange: setDraft });
  },
  usePathname: () => '/beeline/chat/room',
  useRouter: () => ({}),
}));
vi.mock('@/utils/responsive', async () => {
  const React = await import('react');
  return { useIsTablet: () => React.useSyncExternalStore(
    (listener) => { viewport.listeners.add(listener); return () => { viewport.listeners.delete(listener); }; },
    () => viewport.tablet,
  ), useIsDesktop: () => viewport.tablet, useHeaderHeight: () => 0 };
});
vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable', Platform: { OS: 'web' }, useWindowDimensions: () => ({ width: 390 }), PanResponder: { create: () => ({ panHandlers: {} }) } }));
vi.mock('tamagui', () => ({ YStack: 'View', XStack: 'Row', useTheme: () => ({ canvas: { val: 'black' } }) }));
vi.mock('@/ui/grammar', () => ({ Filled: () => null, Glyph: () => null }));
vi.mock('@/ui/grammar-root', () => ({ PaneResizer: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('@/components/buzz/IndexRow', () => ({ InlineRow: 'InlineRow' }));
vi.mock('@/buzz/desktop-artifact-pane', () => ({ subscribeDesktopArtifact: () => () => {} }));
vi.mock('@/components/buzz/DesktopArtifactPane', () => ({ DesktopArtifactPane: () => null }));
vi.mock('@/buzz/desktop-layout-state', () => ({ useDesktopLayout: () => ({ availableWidth: 390, showRoomList: false }), setDesktopAvailableWidth: () => {} }));
vi.mock('@/sync/storage', () => ({ useLocalSetting: () => false, useLocalSettingMutable: () => [false, () => {}] }));
vi.mock('@/utils/isTauri', () => ({ isTauri: () => false }));
vi.mock('@/utils/platform', () => ({ isDesktopPlatform: () => false }));
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: async () => null }));
vi.mock('@/sync/transport/live-connection', () => ({}));
vi.mock('@/auth/monolith-session', () => ({ monolithSession: {} }));
vi.mock('@/sync/client-reset', () => ({ subscribeClientReset: () => () => {} }));
vi.mock('@/buzz/desktop-workbench-state', () => ({ DESKTOP_NAV_DEFAULT_WIDTH: 260, DESKTOP_NAV_MIN_WIDTH: 200, DESKTOP_TRANSCRIPT_MIN_WIDTH: 400, clampDesktopPaneWidth: (_kind: string, width: number) => width }));
vi.mock('@/components/SidebarView', () => ({ SidebarView: () => React.createElement('Sidebar') }));
import { SidebarNavigator } from './SidebarNavigator';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it('keeps the browser route and its draft mounted across compact and desktop widths', async () => {
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<SidebarNavigator />); });
  const initialMounts = route.mounts;
  expect(tree.root.findAllByType('Sidebar')).toHaveLength(0);
  await act(async () => tree.root.findByType('Draft').props.onChange('Unsent draft'));
  for (const tablet of [true, false, true]) {
    await act(async () => { viewport.tablet = tablet; viewport.listeners.forEach((listener) => listener()); });
    expect(route.mounts).toBe(initialMounts);
    expect(tree.root.findByType('Draft').props.value).toBe('Unsent draft');
    expect(tree.root.findAllByType('Sidebar')).toHaveLength(tablet ? 1 : 0);
  }
  await act(async () => tree.unmount());
});

import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { NavigationContext, useNavigation, useStateForPath } from '@react-navigation/core';
// @ts-expect-error React Navigation exposes this context only through its internal module.
import { NavigationFocusedRouteStateContext } from '../../../../../node_modules/@react-navigation/core/lib/module/NavigationFocusedRouteStateContext';

vi.mock('@react-navigation/native', async () => await import('@react-navigation/core'));
vi.mock('expo-router', async () => ({
  // Expo Router 55's no-parent hook also reads useStateForPath. Model
  // that external subscription without loading its native module barrel.
  useNavigation: () => {
    useStateForPath();
    return useNavigation();
  },
  useLocalSearchParams: () => ({ channelId: 'room-a', title: 'Room A' }),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('@/buzz/room-send-list', () => ({
  RoomSendPreview: class {
    activate() {}
    dispose() {}
  },
}));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('@/utils/isDesktopShell', () => ({ isDesktopShell: () => false }));
import { useChatRoute } from './useChatRoute';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('keeps a mounted Room out of navigator path updates while retaining navigation actions', async () => {
  // The tap budget requires no whole-chat render for a path-only update.
  // Count actual hook-consumer renders, rather than inspecting imports.
  const goBack = vi.fn();
  const navigation = { goBack };
  let renders = 0;
  const Chat = React.memo(function Chat() {
    const [, roomId, nav] = useChatRoute([]);
    renders++;
    return <button onClick={() => nav.goBack()}>{roomId}</button>;
  });
  const chat = <Chat />;
  const view = (state: any, nav = navigation) => (
    <NavigationContext.Provider value={nav as any}>
      <NavigationFocusedRouteStateContext.Provider value={state}>
        {chat}
      </NavigationFocusedRouteStateContext.Provider>
    </NavigationContext.Provider>
  );
  let tree: ReturnType<typeof create>;
  await act(async () => {
    tree = create(view(undefined));
  });
  try {
    expect(renders).toBe(1);
    await act(async () => {
      tree.update(view({ routes: [{ name: 'chat', params: { channelId: 'room-a' } }] }));
    });
    expect(renders).toBe(1);
    expect(tree.root.findByType('button').props.children).toBe('room-a');
    act(() => tree.root.findByType('button').props.onClick());
    expect(goBack).toHaveBeenCalledOnce();
    const nextGoBack = vi.fn();
    await act(async () => {
      tree.update(view(undefined, { goBack: nextGoBack }));
    });
    act(() => tree.root.findByType('button').props.onClick());
    expect(nextGoBack).toHaveBeenCalledOnce();
    expect(goBack).toHaveBeenCalledOnce();
  } finally {
    await act(async () => tree.unmount());
  }
});

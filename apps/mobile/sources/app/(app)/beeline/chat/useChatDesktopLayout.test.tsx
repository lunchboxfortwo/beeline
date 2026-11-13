import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
const viewer = vi.hoisted(() => ({ relayUrl: 'https://local.invalid' }));
vi.mock('@/auth/buzz-identity-storage', () => ({ peekBuzzViewerContext: () => viewer, getEffectiveRelayUrl: async () => viewer.relayUrl }));
vi.mock('@/buzz/use-desktop-parent-room', () => ({ useDesktopParentRoom: () => null }));
vi.mock('@/buzz/github-access-surface', () => ({ useGitHubAccess: () => null }));
vi.mock('@/buzz/use-room-roster', () => ({ useRoomRoster: () => ({ value: null, open: () => {} }) }));
vi.mock('expo-router', async () => {
  const React = await import('react');
  return { useFocusEffect: (effect: React.EffectCallback) => React.useEffect(effect, []) };
});
import { useChatDesktopLayout } from './useChatDesktopLayout';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it('does not redraw a new phone chat just to observe an unused desktop profile focus', async () => {
  let renders = 0;
  function Chat() {
    renders++;
    const pane = React.useRef<any>(null);
    const history = React.useRef(false);
    useChatDesktopLayout([pane, () => {}, false, 390, 'room', 'viewer', null, undefined,
      false, null, null, null, history, 'Room', 'workspace', false, () => {}]);
    return <React.Fragment />;
  }
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<Chat />); });
  expect(renders).toBe(1);
  await act(async () => tree.unmount());
});

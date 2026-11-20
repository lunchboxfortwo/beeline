import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
const viewer = vi.hoisted(() => ({ relayUrl: 'https://local.invalid' }));
vi.mock('@/auth/buzz-identity-storage', () => ({ peekBuzzViewerContext: () => viewer, getEffectiveRelayUrl: async () => viewer.relayUrl }));
vi.mock('@/buzz/use-desktop-parent-room', () => ({ useDesktopParentRoom: () => null }));
vi.mock('@/buzz/github-access-surface', () => ({ useGitHubAccess: () => null }));
const roster = vi.hoisted(() => ({ visible: [] as boolean[] }));
vi.mock('@/buzz/use-room-roster', () => ({ useRoomRoster: (_w: unknown, _v: unknown, visible: boolean) => { roster.visible.push(visible); return { value: null, open: () => {} }; } }));
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

it('reads the Workspace roster for an empty chat, so its first steps never change copy', async () => {
  const surface = (messages: unknown[]) => ({ room: { id: 'room', workspaceId: 'workspace', name: 'general' }, messages, members: [] });
  for (const [messages, expected] of [[[], true], [[{ id: 'm' }], false]] as const) {
    roster.visible.length = 0;
    function Chat() {
      const pane = React.useRef<any>(null);
      const history = React.useRef(false);
      useChatDesktopLayout([pane, () => {}, false, 390, 'room', 'viewer', surface([...messages]) as any, undefined,
        false, null, null, null, history, 'Room', 'workspace', false, () => {}]);
      return <React.Fragment />;
    }
    let tree: ReturnType<typeof create>;
    await act(async () => { tree = create(<Chat />); });
    expect(roster.visible.at(-1)).toBe(expected);
    await act(async () => tree.unmount());
  }
});

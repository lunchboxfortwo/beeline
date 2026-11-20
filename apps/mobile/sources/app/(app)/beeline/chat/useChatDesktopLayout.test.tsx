import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import type { WorkspaceView } from '@beeline/buzz-client';
const viewer = vi.hoisted(() => ({ relayUrl: 'https://local.invalid' }));
vi.mock('@/auth/buzz-identity-storage', () => ({ peekBuzzViewerContext: () => viewer, getEffectiveRelayUrl: async () => viewer.relayUrl }));
vi.mock('@/buzz/use-desktop-parent-room', () => ({ useDesktopParentRoom: () => null }));
vi.mock('@/buzz/github-access-surface', () => ({ useGitHubAccess: () => null }));
const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }));
vi.mock('@/buzz/surface-storage', async () => {
  const { SurfaceRegistry } = await import('@/buzz/surface-registry');
  const { SurfaceResponseCache } = await import('@beeline/buzz-client');
  return {
    mobileSurfaceCache: new SurfaceRegistry(new SurfaceResponseCache({
      get: async key => storage.get(key) ?? null,
      set: async (key, value) => { storage.set(key, value); },
      remove: async key => { storage.delete(key); },
    })),
    surfaceAddress: (relayOrigin: string, viewerPubkey: string, endpoint: string, params: Record<string, string>) =>
      ({ relayOrigin, viewerPubkey, endpoint, params }),
  };
});
vi.mock('expo-router', async () => {
  const React = await import('react');
  return { useFocusEffect: (effect: React.EffectCallback) => React.useEffect(effect, []) };
});
import { useChatDesktopLayout } from './useChatDesktopLayout';
import { mobileSurfaceCache } from '@/buzz/surface-storage';
import { resetClientState } from '@/sync/client-reset';

beforeEach(() => {
  resetClientState();
  mobileSurfaceCache.clear();
  storage.clear();
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it('does not redraw a new phone chat just to observe an unused desktop profile focus', async () => {
  let renders = 0;
  function Chat() {
    renders++;
    const pane = React.useRef<any>(null);
    const history = React.useRef(false);
    useChatDesktopLayout([pane, () => {}, false, 390, 'room', 'viewer', null, undefined,
      false, null, null, null, history, 'Room', undefined, false, () => {}]);
    return <React.Fragment />;
  }
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<Chat />); });
  expect(renders).toBe(1);
  await act(async () => tree.unmount());
});

const workspaceId = '11111111-1111-4111-8111-111111111111';
const viewerPubkey = 'a'.repeat(64);
const identity = { pubkey: viewerPubkey, kind: 'human' as const, name: 'Reader', handle: 'reader' };
const workspace: WorkspaceView = {
  workspace: { id: workspaceId, name: 'Team', visibility: 'invite-only', role: 'owner', updatedAt: 1, createdAt: 1 },
  members: [{ identity, role: 'owner' }], agents: [],
  viewer: { identity, role: 'owner', permissions: { send: true, manage: true } },
  watchFilters: [], peopleTotal: 1, agentTotal: 0, membersTruncated: false, agentsTruncated: false,
};

it.each([
  { name: 'empty chat', messages: [], dm: false, parent: undefined, picker: false, reads: true },
  { name: 'populated chat', messages: [{ id: 'm' }], dm: false, parent: undefined, picker: false, reads: false },
  { name: 'empty DM', messages: [], dm: true, parent: undefined, picker: false, reads: false },
  { name: 'empty thread', messages: [], dm: false, parent: 'parent-room', picker: false, reads: false },
  { name: 'populated chat with picker open', messages: [{ id: 'm' }], dm: false, parent: undefined, picker: true, reads: true },
])('requests the Workspace roster when needed for $name', async ({ messages, dm, parent, picker, reads }) => {
  const client = { workspace: vi.fn(async () => workspace) };
  const surface = { room: { id: 'room', workspaceId, name: 'general' }, messages, members: [] };
  let received: WorkspaceView | null = null;
  function Chat() {
    const pane = React.useRef<any>(null);
    const history = React.useRef(false);
    const layout = useChatDesktopLayout([pane, () => {}, false, 390, 'room', viewerPubkey, surface as any, parent,
      dm, null, client as any, null, history, 'Room', workspaceId, picker, () => {}]);
    received = layout[10];
    return <React.Fragment />;
  }
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<Chat />); });
  try {
    if (reads) {
      await act(async () => { await vi.waitFor(() => expect(client.workspace).toHaveBeenCalledWith(workspaceId)); });
      expect(client.workspace).toHaveBeenCalledTimes(1);
      expect(received).toEqual(workspace);
    } else {
      expect(client.workspace).not.toHaveBeenCalled();
      expect(received).toBeNull();
    }
  } finally {
    await act(async () => tree.unmount());
  }
});

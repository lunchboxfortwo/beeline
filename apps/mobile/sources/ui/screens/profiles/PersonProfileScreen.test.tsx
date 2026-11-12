import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  focused: true,
  viewerRole: 'member' as 'owner' | 'admin' | 'member',
  reads: vi.fn(),
  release: vi.fn(),
  operation: vi.fn(),
  navigate: vi.fn(),
  prefetch: vi.fn(),
  known: vi.fn(),
  openPlace: vi.fn(),
  beforeRemove: undefined as undefined | ((event: any) => void),
}));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('@/buzz/use-surface-focus', () => ({ useSurfaceFocus: () => state.focused }));
vi.mock('@/buzz/use-active-community', () => ({ useActiveCommunityId: () => 'w' }));
vi.mock('expo-router', () => ({
  router: { back: vi.fn(), push: vi.fn() },
  useNavigation: () => ({ addListener: (_: string, callback: any) => { state.beforeRemove = callback; return () => {}; } }),
}));
vi.mock('@/buzz/latency-route-hook', () => ({ useLatencyRouteFrame: () => {} }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: async () => ({ publicKey: 'viewer' }),
  getEffectiveRelayUrl: async () => 'https://server.example',
}));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: state.operation }));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    workspaceMembers() {
      state.reads();
      return Promise.resolve({
        viewer: { identity: { pubkey: 'viewer' }, role: state.viewerRole, permissions: { manage: state.viewerRole !== 'member' } },
        grants: [{ grantId: 'g1', kind: 'shared_asset', status: 'approved', roomName: 'beeline' }],
        agentsTruncated: false,
      });
    }
  },
}));
vi.mock('@/push/push-room-prefetch', () => ({ prefetchRoomOpen: state.prefetch, prefetchDirectMessageOpen: state.known }));
vi.mock('@/buzz/corner-navigation', () => ({ navigateToRoom: state.navigate }));
vi.mock('@/ui/shell/panel', () => ({ openPlace: state.openPlace }));
vi.mock('@/buzz/chat-list-store', () => ({
  useChatList: (key: unknown) => key ? { chats: [{ room: { id: 'milo', name: 'milo' } }, { room: { id: 'old', name: 'old', archived: true } }] } : null,
}));
vi.mock('@/buzz/workspace-records', () => ({
  useWorkspaceRecords: () => {},
  workspaceRecord: () => ({ identity: { pubkey: 'person', name: 'Banana', handle: 'bananaman614305' }, role: 'member' }),
  workspaceOwnedAgents: () => [{ identity: { pubkey: 'jimmy', name: 'Jimmy', handle: 'jimmy', kind: 'agent' }, model: 'gpt-5.5-codex' }],
  workspaceRecordScope: () => 'scope',
  recordWorkspacePage: vi.fn(),
  recordWorkspaceRemoval: vi.fn(),
  recordWorkspaceRole: vi.fn(),
}));
vi.mock('@/buzz/workspace-watch', () => ({ watchWorkspace: () => ({ release: state.release, ready: Promise.resolve(), rooms: vi.fn() }) }));
vi.mock('@/buzz/surface-storage', () => ({
  surfaceAddress: () => ({}),
  mobileSurfaceCache: { fetch: async (_a: any, _v: any, load: any) => load(), subscribe: () => () => {}, peek: () => null, read: async () => null },
}));
vi.mock('@/modal/ModalManager', () => ({ Modal: { confirm: async () => true } }));
vi.mock('@/components/buzz/SurfaceGlyphLoader', () => ({ SurfaceGlyphLoader: (props: any) => React.createElement('SurfaceGlyphLoader', props) }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: (props: any) => React.createElement('IdentityMark', props) }));
import { PersonProfileScreen } from './PersonProfileScreen';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const byId = (tree: any, id: string): any => tree.root.findAll((node: any) => node.props.testID === id)[0];
const text = (tree: any) => tree.root.findAll((node: any) => node.type === 'Text' && typeof node.props.children === 'string').map((node: any) => node.props.children).join(' ');
async function render(close = vi.fn()) {
  let tree: any;
  await act(async () => { tree = create(<PersonProfileScreen workspaceId="w" memberId="person" close={close} />); });
  return tree;
}

beforeEach(() => { state.viewerRole = 'member'; state.operation.mockReset(); state.navigate.mockClear(); state.prefetch.mockClear(); state.openPlace.mockClear(); });

describe('person profile', () => {
  it('shows the 72 mark, @handle and role, Message and Invite to chat, connected agents and no Grants', async () => {
    const tree = await render();
    const mark = tree.root.findAll((node: any) => node.type === 'IdentityMark' && node.props.kind === 'human')[0];
    expect(mark.props.size).toBe(72);
    expect(mark.props.handle).toBe('bananaman614305');
    const content = text(tree);
    expect(content).toContain('@bananaman614305');
    expect(content).toContain('member');
    expect(content).toContain('Connected agents');
    expect(content).not.toContain('Grants');
    expect(byId(tree, 'human-profile-message')).toBeDefined();
    expect(byId(tree, 'human-profile-invite')).toBeDefined();
    expect(byId(tree, 'edit-person-role')).toBeUndefined();
  });

  it('reads a resolved DM before navigation occupies the thread', async () => {
    state.operation.mockResolvedValue({ id: 'dm' });
    state.prefetch.mockClear();
    const tree = await render();
    await act(async () => { byId(tree, 'human-profile-message').props.onPress(); });
    expect(state.prefetch).toHaveBeenCalledWith('dm');
    expect(state.prefetch.mock.invocationCallOrder[0]).toBeLessThan(state.navigate.mock.invocationCallOrder[0]);
    act(() => tree.unmount());
  });

  it('opens a connected agent through the panel helper', async () => {
    const tree = await render();
    act(() => byId(tree, 'person-agent-jimmy').props.onPress());
    expect(state.openPlace).toHaveBeenCalledWith({ kind: 'agent', agentId: 'jimmy', workspaceId: 'w' }, false);
  });

  it('invites the person to one of your chats', async () => {
    state.operation.mockResolvedValue(undefined);
    const tree = await render();
    act(() => byId(tree, 'human-profile-invite').props.onPress());
    expect(byId(tree, 'person-invite-old')).toBeUndefined();
    await act(async () => { byId(tree, 'person-invite-milo').props.onPress(); });
    expect(state.operation).toHaveBeenCalledWith('addRoomMember', { roomId: 'milo', memberId: 'person' });
  });

  it('lets a manager change the access level and remove the person', async () => {
    state.viewerRole = 'owner';
    state.operation.mockResolvedValue(undefined);
    const close = vi.fn();
    const tree = await render(close);
    act(() => byId(tree, 'edit-person-role').props.onPress());
    act(() => byId(tree, 'person-role-admin').props.onPress());
    expect(byId(tree, 'person-role-admin').props['aria-checked']).toBe(true);
    await act(async () => { byId(tree, 'save-person-role').props.onPress(); });
    expect(state.operation).toHaveBeenCalledWith('addWorkspaceMember', { workspaceId: 'w', memberId: 'person', role: 'admin' });
    act(() => byId(tree, 'edit-person-role').props.onPress());
    await act(async () => { await byId(tree, 'remove-person').props.onPress(); });
    expect(state.operation).toHaveBeenCalledWith('removeWorkspaceMember', { workspaceId: 'w', memberId: 'person' });
    expect(close).toHaveBeenCalled();
  });
});

describe('Reproduction R1: Profile back while Message waits', () => {
  it.each(['header back', 'system back'])('%s leaves immediately and a late DM cannot navigate', async (method) => {
    let resolve!: (value: unknown) => void;
    state.operation.mockImplementation(() => new Promise((done) => { resolve = done; }));
    state.beforeRemove = undefined;
    const close = vi.fn();
    const tree = await render(close);
    await act(async () => { byId(tree, 'human-profile-message').props.onPress(); });
    const prevented = vi.fn();
    await act(async () => {
      if (method === 'header back') tree.root.findAll((node: any) => node.props['aria-label'] === 'Back')[0].props.onPress();
      else { state.beforeRemove?.({ preventDefault: prevented }); if (!prevented.mock.calls.length) close(); }
    });
    expect(prevented).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(byId(tree, 'human-profile-message').props.disabled).toBe(true);
    await act(async () => tree.unmount());
    await act(async () => resolve({ id: 'dm' }));
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.prefetch).not.toHaveBeenCalled();
  });
});

// A retained screen starts hidden, enters focus, then releases its reader on blur.
it('reads on actual focus and releases the profile watch on blur', async () => {
  state.focused = false; state.reads.mockClear(); state.release.mockClear();
  const element = () => <PersonProfileScreen workspaceId="w" memberId="person" close={vi.fn()} />;
  let tree: any;
  try {
    await act(async () => { tree = create(element()); });
    expect(state.reads).not.toHaveBeenCalled();
    state.focused = true;
    await act(async () => { tree.update(element()); });
    expect(state.reads).toHaveBeenCalledTimes(1);
    state.focused = false;
    await act(async () => { tree.update(element()); });
    expect(state.release).toHaveBeenCalledTimes(1);
    expect(state.reads).toHaveBeenCalledTimes(1);
  } finally {
    if (tree) await act(async () => tree.unmount());
    state.focused = true;
  }
});

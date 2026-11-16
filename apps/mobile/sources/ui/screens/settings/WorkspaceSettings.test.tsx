vi.mock('@expo/vector-icons/Ionicons', async () => { const R = await import('react'); return { default: (props: any) => R.createElement('Ionicons', props) }; });
vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'Light' }, impactAsync: async () => undefined }));
vi.mock('react-native-keyboard-controller', async () => { const R = await import('react'); return { useReanimatedKeyboardAnimation: () => ({ height: { value: 0 } }), KeyboardAvoidingView: (props: any) => R.createElement('View', props, props.children) }; });
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// These fixtures exercise the negotiated legacy compatibility path. The actual
// router owner/negotiation path has independent integration coverage.

const platform = vi.hoisted(() => ({ OS: 'android' }));
const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const auth = vi.hoisted(() => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
  loadBuzzIdentity: vi.fn(async () => ({
    publicKey: 'a'.repeat(64),
    secretKey: new Uint8Array(32),
  })),
}));
const avatarUpload = vi.hoisted(() => ({ pickAndUploadAvatar: vi.fn() }));
const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async () => undefined) }));
const modal = vi.hoisted(() => ({ actionSheet: vi.fn() }));
const phoneOperation = vi.hoisted(() => vi.fn());
const runtime = vi.hoisted(() => ({ relayUrl: 'https://usebeeline.app' }));
// The shared registry entries settings reads, keyed by endpoint.
const hotSurfaces = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  listeners: new Map<string, Set<() => void>>(),
}));
const reconnectListeners = vi.hoisted(() => new Set<(event: any) => void>());
const roomViews = vi.hoisted(() => ({ workspace: vi.fn(), chats: vi.fn(), room: vi.fn() }));
const client = vi.hoisted(() => ({
  surfaceSubscribe: vi.fn(async () => vi.fn()),
  renameCommunity: vi.fn(),
  setCommunityAvatar: vi.fn(),
  setCommunityVisibility: vi.fn(),
}));

vi.mock('@beeline/buzz-client', () => ({
  RoomViewClient: class {
    workspace = roomViews.workspace;
    chats = (_authority: unknown, workspaceId: string) => roomViews.chats(workspaceId);
    room = roomViews.room;
  },
  SurfaceRefreshScheduler: class<T> {
    constructor(
      private readonly options: {
        fetch: () => Promise<T>;
        apply: (value: T) => void;
        onError?: (error: unknown) => void;
      },
    ) {}
    async startAfter(listenReady: Promise<unknown>) {
      await listenReady;
      await this.refresh();
    }
    force() {
      void this.refresh();
    }
    dispose() {}
    private async refresh() {
      try {
        this.options.apply(await this.options.fetch());
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  },
  isChatListView: () => true,
  isWorkspaceView: () => true,
}));

vi.mock('expo-router', () => ({
  router: navigation,
  useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
  useLocalSearchParams: () => ({ communityId: 'workspace-1' }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('@/auth/buzz-identity-storage', () => auth);
vi.mock('@/buzz/surface-storage', () => ({
  surfaceAddress: (_relay: string, _viewer: string, endpoint: string) => endpoint,
  mobileSurfaceCache: {
    read: vi.fn(async (address: string) => hotSurfaces.values.get(address) ?? null),
    fetch: vi.fn(async (address: string, _guard: unknown, request: () => Promise<unknown>) => {
      const value = await request();
      hotSurfaces.values.set(address, value);
      for (const listener of hotSurfaces.listeners.get(address) ?? []) listener();
      return value;
    }),
    publish: (address: string, value: unknown) => {
      hotSurfaces.values.set(address, value);
      for (const listener of hotSurfaces.listeners.get(address) ?? []) listener();
      return value;
    },
    write: vi.fn(async (address: string, value: unknown) => {
      hotSurfaces.values.set(address, value);
      for (const listener of hotSurfaces.listeners.get(address) ?? []) listener();
    }),
    persist: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    clear: vi.fn(),
    peek: (address: string) => hotSurfaces.values.get(address) ?? null,
    subscribe: (address: string, listener: () => void) => {
      const listeners = hotSurfaces.listeners.get(address) ?? new Set<() => void>();
      listeners.add(listener);
      hotSurfaces.listeners.set(address, listeners);
      return () => listeners.delete(listener);
    },
  },
}));
// The Room list store settings reads watches through the shared live connection.
vi.mock('@/sync/transport/live-connection', () => ({
  sharedLiveConnection: () => ({
    register: async (_filters: unknown, listener: (event: any) => void) => {
      reconnectListeners.add(listener); return () => reconnectListeners.delete(listener);
    },
    whenSubscribed: async () => undefined,
    isViewing: () => false,
    reconnect: () => undefined,
  }),
}));
vi.mock('@/buzz/avatar-upload', () => avatarUpload);
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => runtime,
}));
vi.mock('expo-clipboard', () => clipboard);
vi.mock('@/modal', () => ({ Modal: modal }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: phoneOperation, readServerSurface: (_authority: unknown, ...args: unknown[]) => phoneOperation(...args) }));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    workspace = roomViews.workspace;
    chats = (_authority: unknown, workspaceId: string) => roomViews.chats(workspaceId);
    room = roomViews.room;
  },
}));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = vi.fn(async () => client);
  },
}));
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    HullSurface: host('HullSurface'),
    PixelLoader: host('PixelLoader'),
  };
});
vi.mock('@/components/buzz/Button', async () => {
  const ReactModule = await import('react');
  return { Button: (props: any) => ReactModule.createElement('Button', props, props.children) };
});
vi.mock('@/components/buzz/SurfaceGlyphLoader', async () => {
  const ReactModule = await import('react');
  return {
    SurfaceGlyphLoader: (props: any) => ReactModule.createElement('SurfaceGlyphLoader', props),
  };
});
vi.mock('@/components/buzz/HullActionSheet', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    HULL_SHEET_INSET: 22,
    HullActionSheet: host('HullActionSheet'),
    HullActionSheetCancel: host('HullActionSheetCancel'),
    HullActionSheetModal: host('HullActionSheetModal'),
    HullActionSheetRow: host('HullActionSheetRow'),
  };
});
vi.mock('@/components/buzz/HullDialog', async () => {
  const ReactModule = await import('react');
  return {
    HullDialogInput: ReactModule.forwardRef((props: any, ref: any) => ReactModule.createElement('TextInput', { ...props, ref })),
    HullDialogActions: ({ actions }: any) => ReactModule.createElement('View', {}, actions.map((action: any) => ReactModule.createElement('Button', { ...action, key: action.label }))),
    HullDialog: (props: any) =>
      ReactModule.createElement(
        'HullDialog',
        props,
        props.children,
        props.actions.map((action: any) =>
          ReactModule.createElement('DialogAction', { ...action, key: action.testID }),
        ),
      ),
  };
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
    useWindowDimensions: () => ({ height: 844, width: 390 }),
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    Platform: { get OS() { return platform.OS; }, select: (choices: Record<string, unknown>) => choices[platform.OS] ?? choices.default },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Switch: host('Switch'),
    Share: { share: vi.fn() },
    StyleSheet: { flatten: (style: any): any => Array.isArray(style) ? Object.assign({}, ...style) : style,  create: (styles: unknown) => styles },
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

import { resetChatListStoresForTest } from '@/buzz/chat-list-store';

const originalConsoleError = console.error;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});

afterAll(() => vi.restoreAllMocks());
beforeEach(() => {
  reconnectListeners.clear();
  vi.clearAllMocks();
  resetChatListStoresForTest();
  hotSurfaces.values.clear();
  hotSurfaces.listeners.clear();
  roomViews.workspace.mockResolvedValue(workspaceView());
  roomViews.chats.mockResolvedValue(chatListView());
  phoneOperation.mockResolvedValue(undefined);
  avatarUpload.pickAndUploadAvatar.mockResolvedValue(null);
});

function workspaceView(
  role: 'owner' | 'admin' | 'member' = 'owner',
  avatar?: string,
  rooms?: Array<{
    id: string;
    name: string;
    visibility: 'public' | 'invite-only';
    createdAt: number;
  }>,
  roomsTruncated = false,
) {
  return {
    workspace: {
      id: 'workspace-1',
      name: 'Hull',
      avatar,
      visibility: 'invite-only',
      role,
      createdAt: 1,
      updatedAt: 1,
    },
    ...(role === 'owner' || role === 'admin'
      ? {
          managerSettings: {
            visibility: 'invite-only' as const,
            ...(rooms ? { rooms } : {}),
            ...(roomsTruncated ? { roomsTruncated: true } : {}),
          },
        }
      : {}),
    members: [
      { identity: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Captain' } },
      { identity: { pubkey: 'b'.repeat(64), kind: 'human', name: 'Mate' } },
    ],
    agents: [{ identity: { pubkey: 'c'.repeat(64), kind: 'agent', name: 'Foxy' } }],
    peopleTotal: 2,
    agentTotal: 1,
    membersTruncated: false,
    agentsTruncated: false,
    viewer: {
      identity: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Captain' },
      role,
      permissions: { send: true, manage: role !== 'member' },
    },
    watchFilters: [],
  };
}

function room(id: string, name: string, createdAt: number, archived = false, direct = false) {
  return {
    room: {
      id,
      workspaceId: 'workspace-1',
      name,
      visibility: 'public',
      archived,
      createdAt,
      updatedAt: createdAt,
    },
    memberCount: 1,
    cornerCount: 0,
    unread: false,
    ...(direct
      ? {
          directMessage: {
            peer: { pubkey: 'b'.repeat(64), kind: 'human', name: 'System' },
          },
        }
      : {}),
  };
}

function chatListView(chats: ReturnType<typeof room>[] = []) {
  return {
    workspace: {
      id: 'workspace-1',
      name: 'Hull',
      visibility: 'invite-only',
      role: 'owner',
      updatedAt: 1,
    },
    chats,
    viewer: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Captain' },
    truncated: false,
    watchFilters: [],
  };
}

vi.mock('tamagui', async () => {
  const hosts = (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts() as Record<string, any>;
  hosts.Switch.Thumb = (props: any) => React.createElement('Switch.Thumb', props);
  return hosts;
});
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
import { WorkspaceSettings } from './WorkspaceSettings';

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(WorkspaceSettings, { workspaceId: 'workspace-1' }));
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}
const byId = (renderer: ReactTestRenderer, id: string): any => renderer.root.findAll((node: any) => node.props.testID === id)[0];
const has = (renderer: ReactTestRenderer, id: string) => Boolean(byId(renderer, id));
const sheet = (renderer: ReactTestRenderer, id: string) => renderer.root.findAll((node: any) => node.type === 'Sheet' && node.props.open !== undefined)
  .find((node: any) => node.findAll((child: any) => child.props.testID === id).length > 0);

describe('Workspace settings tab', () => {
  it('shows a manager the picture, General, Chats and Danger, and no People row', async () => {
    roomViews.workspace.mockResolvedValue(workspaceView('owner', undefined, [
      { id: 'beeline', name: 'beeline', visibility: 'public', createdAt: 1 },
    ]));
    const renderer = await render();
    expect(has(renderer, 'workspace-settings-manage')).toBe(true);
    expect(has(renderer, 'workspace-picture')).toBe(true);
    expect(has(renderer, 'workspace-overview-settings')).toBe(true);
    expect(has(renderer, 'channel-visibility-settings')).toBe(true);
    expect(has(renderer, 'workspace-delete-row')).toBe(true);
    expect(has(renderer, 'open-members')).toBe(false);
    expect(has(renderer, 'workspace-members-link')).toBe(false);
  });

  it('uploads a picture with the shared picker and returns to the generated mark', async () => {
    const pictureUrl = 'https://example.test/media/canonical.png';
    avatarUpload.pickAndUploadAvatar.mockResolvedValue(pictureUrl);
    client.setCommunityAvatar.mockImplementation(async () => {
      roomViews.workspace.mockResolvedValue(workspaceView('owner', pictureUrl));
    });
    const renderer = await render();
    expect(byId(renderer, 'workspace-picture-mark').props.avatarUrl).toBeUndefined();
    await act(async () => { byId(renderer, 'workspace-picture-change').props.onPress(); await Promise.resolve(); await Promise.resolve(); });
    expect(avatarUpload.pickAndUploadAvatar).toHaveBeenCalledWith(client);
    expect(client.setCommunityAvatar).toHaveBeenCalledWith('workspace-1', pictureUrl);
    expect(byId(renderer, 'workspace-picture-mark').props.avatarUrl).toBe(pictureUrl);

    client.setCommunityAvatar.mockImplementation(async () => { roomViews.workspace.mockResolvedValue(workspaceView('owner')); });
    await act(async () => { byId(renderer, 'workspace-picture-clear').props.onPress(); await Promise.resolve(); await Promise.resolve(); });
    expect(client.setCommunityAvatar).toHaveBeenLastCalledWith('workspace-1', '');
    expect(has(renderer, 'workspace-picture-clear')).toBe(false);
  });

  it('shows a member the same tab read-only, without picture actions', async () => {
    roomViews.workspace.mockResolvedValue(workspaceView('member', 'https://example.test/media/hull.png'));
    const renderer = await render();
    expect(has(renderer, 'workspace-settings-read-only')).toBe(true);
    expect(has(renderer, 'workspace-picture-change')).toBe(false);
    expect(has(renderer, 'workspace-fix-sweep')).toBe(false);
    expect(has(renderer, 'workspace-delete-row')).toBe(false);
  });

  it('renames through the Name row editor', async () => {
    const renderer = await render();
    act(() => byId(renderer, 'workspace-name-row').props.onPress());
    act(() => byId(renderer, 'workspace-name-input').props.onChangeText('Hull Two'));
    await act(async () => { byId(renderer, 'workspace-name-save').props.onPress(); await Promise.resolve(); });
    expect(client.renameCommunity).toHaveBeenCalledWith('workspace-1', 'Hull Two');
  });

  it('lists each chat as Public or Private with Joined, and joins one from its sheet', async () => {
    roomViews.workspace.mockResolvedValue(workspaceView('owner', undefined, [
      { id: 'milo', name: 'milo', visibility: 'invite-only', createdAt: 3 },
    ]));
    roomViews.chats.mockResolvedValue(chatListView([]));
    const renderer = await render();
    const row = byId(renderer, 'room-visibility-milo');
    expect(row.props.value).toBe('Private');
    expect(row.props.detail).toBe('Not joined');
    act(() => row.props.onPress());
    expect(sheet(renderer, 'room-sheet')?.props.open).toBe(true);
    await act(async () => { byId(renderer, 'room-sheet-join').props.onPress(); await Promise.resolve(); await Promise.resolve(); });
    expect(phoneOperation).toHaveBeenCalledWith('addRoomMember', { roomId: 'milo', memberId: 'a'.repeat(64) });
    expect(navigation.push).toHaveBeenCalled();
  });

  it('requires the exact Workspace name before Delete Workspace', async () => {
    const renderer = await render();
    act(() => byId(renderer, 'workspace-delete-row').props.onPress());
    expect(sheet(renderer, 'workspace-delete-sheet')?.props.open).toBe(true);
    expect(byId(renderer, 'workspace-delete-confirm').props.disabled).toBe(true);
    act(() => byId(renderer, 'workspace-delete-confirm-input').props.onChangeText('Hull'));
    expect(byId(renderer, 'workspace-delete-confirm').props.disabled).toBe(false);
    await act(async () => { byId(renderer, 'workspace-delete-confirm').props.onPress(); await Promise.resolve(); });
    expect(phoneOperation).toHaveBeenCalledWith('deleteWorkspace', { workspaceId: 'workspace-1' }, { timeoutMs: expect.any(Number) });
    expect(navigation.replace).toHaveBeenCalledWith('/beeline/channels');
  });

  it('copies the public join link', async () => {
    const view = workspaceView('member');
    roomViews.workspace.mockResolvedValue({ ...view, workspace: { ...view.workspace, visibility: 'public' } });
    const token = `inv_${'d'.repeat(64)}`;
    phoneOperation.mockResolvedValue({ token, expiresAt: 0 });
    const renderer = await render();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { byId(renderer, 'workspace-public-join-copy').props.onPress(); await Promise.resolve(); });
    expect(clipboard.setStringAsync).toHaveBeenCalledWith(`https://usebeeline.app/join/${token}`);
  });
});

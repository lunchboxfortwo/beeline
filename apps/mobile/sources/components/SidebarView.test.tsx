vi.mock('react-native-keyboard-controller', async () => { const R = await import('react'); return { KeyboardAvoidingView: (props: any) => R.createElement('View', props, props.children) }; });
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';

// These fixtures exercise the negotiated legacy compatibility path. The actual
// router owner/negotiation path has independent integration coverage.



const workspaceLive = vi.hoisted(() => ({ listeners: new Set<(event: MonolithSurfaceEvent) => void>(), deleted: false, empty: false }));
const workspaceChange: MonolithSurfaceEvent = {
  monolithLive: { type: 'invalidate', roomId: '', reason: 'postgres:memberships' },
};
const routerReplace = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const routerNavigate = vi.hoisted(() => vi.fn());
const stableRouter = vi.hoisted(() => ({ push: routerPush, navigate: routerNavigate, replace: routerReplace }));
const saveActiveCommunityId = vi.hoisted(() => vi.fn(async () => undefined));
const loadLastViewedChannel = vi.hoisted(() => vi.fn(async () => null));
const route = vi.hoisted(() => ({
  communityId: undefined as string | undefined,
  parent: undefined as string | undefined,
  pathname: '/beeline/channels',
}));
const pathnameListeners = vi.hoisted(() => new Set<() => void>());
const viewer = vi.hoisted(() => ({ kind: 'human' as 'human' | 'agent' }));
const workspaceRole = vi.hoisted(() => ({ current: 'owner' as 'owner' | 'admin' | 'member' }));
const openCornerState = vi.hoisted(() => ({
  current: 'working' as 'working' | 'waiting' | 'idle' | 'review',
}));
const corners = vi.hoisted(() => vi.fn());
const createHumanCorner = vi.hoisted(() =>
  vi.fn(async (_roomId: string, _title: string) => 'corner-new'),
);
const chats = vi.hoisted(() =>
  vi.fn(async (workspaceId: string) => ({
    workspace: { id: workspaceId, name: workspaceId, role: workspaceRole.current },
    viewer: { kind: viewer.kind },
    chats:
      workspaceId === 'workspace-a'
        ? [
            {
              room: { id: 'room-a', workspaceId, name: 'Alpha' },
              cornerCount: 2,
              openCorners: [
                {
                  id: 'corner-a',
                  name: 'Fix fixture',
                  state: openCornerState.current,
                  mine: true,
                  lastActivityAt: Math.floor(Date.now() / 1000),
                  ...(openCornerState.current === 'waiting' ? { attention: true } : {}),
                },
                { id: 'corner-theirs', name: 'Their fix', state: 'waiting', lastActivityAt: Math.floor(Date.now() / 1000) },
              ],
            },
            {
              room: { id: 'dm-a', workspaceId, name: 'Direct' },
              directMessage: { peer: { name: 'Mina' } },
            },
          ]
        : [],
    watchFilters: workspaceId === 'workspace-a' ? [{ '#h': ['room-a', 'dm-a'] }] : [],
    joinable: workspaceId === 'workspace-a' ? [{ id: 'launch-room', name: 'launch', memberCount: 8 }] : [],
  })),
);
const workspaceSummary = vi.hoisted(() => ({ attention: true, roomCount: 3 }));
const workspaces = vi.hoisted(() => vi.fn(async () => ({
  workspaces: workspaceLive.empty ? [] : [
    ...(!workspaceLive.deleted ? [{ id: 'workspace-a', name: 'Alpha Workspace' }] : []),
    { id: 'workspace-empty', name: 'Empty Workspace', ...workspaceSummary },
  ],
  viewer: { pubkey: 'viewer', kind: 'human', name: 'Ada Lovelace' },
})));
const surfaceRows = vi.hoisted(() => new Map<string, unknown>());
const surfaceListeners = vi.hoisted(() => new Map<string, Set<() => void>>());
vi.mock('@/buzz/surface-storage', () => {
  const notify = (key: string) => {
    for (const listener of surfaceListeners.get(key) ?? []) listener();
  };
  return {
    surfaceAddress: (_relay: string, _viewer: string, endpoint: string, params?: { workspaceId?: string }) =>
      `${endpoint}:${params?.workspaceId ?? ''}`,
    mobileSurfaceCache: {
      peek: (key: string) => surfaceRows.get(key) ?? null,
      read: async (key: string) => {
        if (!surfaceRows.has(key)) {
          if (key.startsWith('/workspaces:')) surfaceRows.set(key, await workspaces());
          else if (key.startsWith('/workspace/:id/chats:')) surfaceRows.set(key, await chats(key.split(':').at(-1)!));
          // The real registry wakes subscribers when a durable value is restored.
          notify(key);
        }
        return surfaceRows.get(key) ?? null;
      },
      fetch: async (key: string, _guard: unknown, request: () => Promise<unknown>) => {
        const value = await request();
        surfaceRows.set(key, value);
        notify(key);
        return value;
      },
      publish: (key: string, value: unknown) => {
        surfaceRows.set(key, value);
        notify(key);
        return value;
      },
      write: async (key: string, value: unknown) => {
        surfaceRows.set(key, value);
        notify(key);
      },
      persist: async () => undefined,
      clear: () => { surfaceRows.clear(); },
      remove: async (key: string) => {
        surfaceRows.delete(key);
        notify(key);
      },
      subscribe: (key: string, listener: () => void) => {
        const listeners = surfaceListeners.get(key) ?? new Set<() => void>();
        listeners.add(listener);
        surfaceListeners.set(key, listeners);
        return () => listeners.delete(listener);
      },
    },
  };
});
vi.mock('@/sync/transport/live-connection', () => ({
  sharedLiveConnection: () => ({
    register: async () => () => undefined,
    whenSubscribed: async () => undefined,
    reconnect: () => undefined,
  }),
}));
const windowListeners = new Map<string, (event: any) => void>();
const viewport = vi.hoisted(() => ({ width: 1280 }));
const desktopShell = vi.hoisted(() => ({ current: false }));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { StyleSheet: { flatten: (style: any): any => Array.isArray(style) ? Object.assign({}, ...style.map((part: any) => Array.isArray(part) ? Object.assign({}, ...part) : part)) : style },
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    Animated: {
      View: host('AnimatedView'),
      Value: class {
        interpolate() {
          return 1;
        }
        setValue() {}
      },
      timing: () => ({}),
      loop: () => ({ start() {}, stop() {} }),
    },
    Easing: { linear: (t: number) => t },
    Platform: { OS: 'web' },
    Pressable: host('Pressable'),
    TouchableOpacity: host('TouchableOpacity'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    View: host('View'),
    useWindowDimensions: () => ({ width: viewport.width, height: 900 }),
  };
});

const theme = vi.hoisted(() => ({
  colors: {
    divider: '#333',
    groupped: { background: '#14091a' },
    success: '#0a0',
    surface: '#190e21',
    surfaceSelected: '#24132f',
    text: '#fff',
    textLink: '#b08a4a',
    textSecondary: '#aaa',
  },
  buzz: {
    accent: '#b08a4a',
    ledgerQuiet: '#777',
    roomCard: {},
    space: { xs: 4, sm: 8, md: 16, lg: 24 },
    type: { body: {}, bodyStrong: {}, hero: {}, machine: {}, meta: { fontSize: 13, lineHeight: 19, fontFamily: 'SpaceGrotesk-Regular' }, sectionHead: {} },
  },
}));
vi.mock('@expo/vector-icons/Ionicons', async () => {
  const ReactModule = await import('react');
  return { default: (props: any) => ReactModule.createElement('Ionicons', props) };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('expo-router', async () => {
  const { useSyncExternalStore } = await import('react');
  return ({
  useGlobalSearchParams: () => route,
  usePathname: () => useSyncExternalStore((listener) => {
    pathnameListeners.add(listener);
    return () => { pathnameListeners.delete(listener); };
  }, () => route.pathname),
  useRouter: () => stableRouter,
  });
});
vi.mock('@/utils/responsive', () => ({ useHeaderHeight: () => 56, useIsDesktop: () => true }));
vi.mock('@/utils/isTauri', () => ({ isTauri: () => desktopShell.current }));
vi.mock('@/utils/platform', () => ({ isDesktopPlatform: () => true }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: vi.fn(async () => 'http://server.test'),
  loadBuzzViewerPubkey: vi.fn(async () => 'viewer'),
  peekBuzzViewerContext: () => null,
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: 'viewer' })),
}));
vi.mock('@/buzz/community-storage', () => ({
  loadLastViewedChannel,
  saveActiveCommunityId,
  subscribeActiveCommunityId: vi.fn(() => () => undefined),
  watchActiveCommunityId: vi.fn((_pubkey: string, listener: (id: string | null) => void) => {
    void Promise.resolve('workspace-a').then(listener);
    return () => undefined;
  }),
}));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    workspaces = workspaces;
    chats = (workspaceId: string) => chats(workspaceId);
    corners = corners;
  },
}));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    createHumanCorner = createHumanCorner;
    async surfaceSubscribe(_filters: unknown, listener: (event: MonolithSurfaceEvent) => void) {
      workspaceLive.listeners.add(listener);
      return () => workspaceLive.listeners.delete(listener);
    }
  },
}));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));
vi.mock('@/buzz/room-list-row', async () => {
  return {
  NO_ACTIVITY_PREVIEW: 'No activity',
  roomRowName: vi.fn((item) => ({
    name: item.directMessage?.peer.name ?? item.room.name,
    sigil: item.directMessage ? '@' : '#',
  })),
  roomRowNeedsAttention: vi.fn(() => false),
  roomRowAttentionReason: vi.fn(() => null),
  roomRowPreview: vi.fn(() => ({ text: 'No activity' })),
  };
});
vi.mock('@/buzz/room-view-presentation', () => ({
  workspaceRailItem: (workspace: { id: string; name: string }) => ({
    communityId: workspace.id,
    name: workspace.name,
  }),
}));
vi.mock('tamagui', async () => (await import('@/ui/screens/chats/tamagui-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/chats/tamagui-hosts.test-support')).lucideHosts());
vi.mock('react-native-svg', async () => (await import('@/ui/screens/chats/tamagui-hosts.test-support')).svgHosts());
const operation = vi.hoisted(() => vi.fn(async (_name: string, _input: unknown) => ({ joined: true })));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: operation, readServerSurface: vi.fn() }));
vi.mock('@/components/buzz/DesktopWorkspaceRail', async () => {
  const ReactModule = await import('react');
  return {
    DesktopWorkspaceRail: (props: any) => ReactModule.createElement('DesktopWorkspaceRail', props),
  };
});
vi.mock('@/components/buzz/IdentityMark', () => ({
  IdentityMark: (props: any) => React.createElement('IdentityMark', props),
}));
import { SidebarView } from './SidebarView';
import { liveChatList, refreshChatList, resetChatListStoresForTest } from '@/buzz/chat-list-store';
import { ChatListHeader } from '@/ui/screens/chats/ChatListHeader';
let tree: ReactTestRenderer;
function control(id: string) {
  const nodes = tree.root.findAll(
    (node: any) => typeof node.type === 'string' && node.props.testID === id,
  );
  if (!nodes.length) throw new Error(`Missing control ${id}`);
  return nodes[0];
}


const header = () => tree.root.findByType(ChatListHeader);
const rail = () => tree.root.findByType('DesktopWorkspaceRail');

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
async function expectEmptyRoomList() {
  await vi.waitFor(async () => {
    await settle();
    expect(header().props.workspaceName).toBe('Empty Workspace');
    expect(tree.root.findAllByProps({ testID: 'room-room-a' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: 'room-dm-a' })).toHaveLength(0);
  }, { timeout: 5_000 });
}

async function refreshWorkspaceViewer() {
  const key = { relayUrl: 'http://server.test', viewerPubkey: 'viewer', workspaceId: 'workspace-a' };
  refreshChatList(key);
  await vi.waitFor(() => {
    const surface = liveChatList(key);
    expect(surface?.workspace.role).toBe(workspaceRole.current);
    expect(surface?.viewer.kind).toBe(viewer.kind);
  });
  await settle();
}

beforeAll(() => {
  (globalThis as any).window = {
    addEventListener: (name: string, listener: (event: any) => void) =>
      windowListeners.set(name, listener),
    removeEventListener: (name: string) => windowListeners.delete(name),
  };
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
  });
});

afterEach(async () => {
  await act(async () => tree.unmount());
});

afterAll(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).window;
});

describe('desktop Workspace navigation', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetChatListStoresForTest();
    surfaceRows.clear();
    surfaceListeners.clear();
    workspaceLive.deleted = false;
    workspaceLive.empty = false;
    workspaceLive.listeners.clear();
    windowListeners.clear();
    route.communityId = undefined;
    route.parent = undefined;
    route.pathname = '/beeline/chat/room-a';
    workspaceSummary.attention = true;
    workspaceSummary.roomCount = 3;
    openCornerState.current = 'working';
    viewport.width = 1280;
    desktopShell.current = false;
    viewer.kind = 'human';
    workspaceRole.current = 'owner';
    await act(async () => {
      tree = create(<SidebarView />);
    });
    await settle();
  });

  it('keeps send-related Tray and bookmark deltas from rereading both navigation lists', async () => {
    const workspaceReads = workspaces.mock.calls.length;
    const chatReads = chats.mock.calls.length;
    await act(async () => {
      for (const listener of workspaceLive.listeners) {
        listener({ monolithLive: { type: 'needs-you-delta', roomId: '',
          workspaceId: 'workspace-a', sourceRoomId: 'room-a', count: 0, items: [] } });
        listener({ monolithLive: { type: 'bookmark-delta', roomId: '',
          workspaceId: 'workspace-a', messageId: 'message-a', bookmark: null } });
      }
    });
    await settle();
    expect(workspaces).toHaveBeenCalledTimes(workspaceReads);
    expect(chats).toHaveBeenCalledTimes(chatReads);
    await act(async () => {
      for (const listener of workspaceLive.listeners) listener(workspaceChange);
    });
    await settle();
    expect(workspaces).toHaveBeenCalledTimes(workspaceReads + 1);
    expect(chats).toHaveBeenCalledTimes(chatReads + 1);
  });

  it('R1: mounting the sidebar schedules no age refresh timer', async () => {
    await act(async () => tree.unmount());
    vi.useFakeTimers();
    try {
      await act(async () => { tree = create(<SidebarView />); });
      await settle();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes rendered ages on list activity while keeping quiet lists and route hops stable', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.UTC(2026, 10, 7, 12);
      vi.setSystemTime(now);
      const key = '/workspace/:id/chats:workspace-a';
      const previous = surfaceRows.get(key) as any;
      const publish = async (updatedAt: number) => {
        await act(async () => {
          surfaceRows.set(key, {
            ...previous,
            chats: previous.chats.map((item: any) => item.room.id === 'room-a'
              ? { ...item, room: { ...item.room, updatedAt } } : item),
          });
          for (const listener of surfaceListeners.get(key) ?? []) listener();
        });
        await settle();
      };
      const age = () => control('room-room-a-age').props.children;
      await publish(now / 1000 - 60);
      expect(age()).toBe('1m');
      await act(async () => { vi.advanceTimersByTime(120_000); });
      expect(age()).toBe('1m');
      act(() => {
        route.pathname = '/beeline/chat/dm-a';
        for (const listener of pathnameListeners) listener();
      });
      expect(age()).toBe('1m');
      // The new activity is two minutes old at the new wall-clock time.
      await publish(now / 1000);
      expect(age()).toBe('2m');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['committed workspace update', 'shared covering read'])('restores Room rows after outage recovery through %s', async recovery => {
    workspaces.mockRejectedValueOnce(new Error('isolated outage'));
    await act(async () => { for (const listener of [...workspaceLive.listeners]) listener(workspaceChange); });
    await settle();
    expect(tree.root.findAllByProps({ testID: 'room-room-a' }).length).toBeGreaterThan(0);
    const reads = workspaces.mock.calls.length;
    await act(async () => {
      if (recovery === 'shared covering read') {
        for (const listener of surfaceListeners.get('/workspaces:') ?? []) listener();
      }
      else for (const listener of [...workspaceLive.listeners]) listener(workspaceChange);
    });
    await settle();
    expect(workspaces).toHaveBeenCalledTimes(reads + (recovery === 'shared covering read' ? 0 : 1));
    expect(tree.root.findAllByProps({ testID: 'room-room-a' }).length).toBeGreaterThan(0);
  });

  it('removes the deleted workspace from the permanent rail while a Room is open', async () => {
    route.pathname = '/beeline/chat/room-a';
    workspaceLive.deleted = true;
    await act(async () => { for (const listener of [...workspaceLive.listeners]) listener(workspaceChange); });
    await settle();
    expect(rail().props.workspaces.map((workspace: { id: string }) => workspace.id)).toEqual(['workspace-empty']);
    expect(saveActiveCommunityId).toHaveBeenCalledWith('viewer', 'workspace-empty');
    expect(routerReplace).toHaveBeenCalledWith({ pathname: '/beeline/channels', params: { communityId: 'workspace-empty' } });
    expect(chats).toHaveBeenLastCalledWith('workspace-empty');
  });

  it('clears the permanent rail when its final workspace is deleted', async () => {
    workspaceLive.empty = true;
    await act(async () => { for (const listener of [...workspaceLive.listeners]) listener(workspaceChange); });
    await settle();
    expect(rail().props.workspaces).toEqual([]);
    expect(saveActiveCommunityId).toHaveBeenCalledWith('viewer', null);
    expect(routerReplace).toHaveBeenCalledWith('/beeline/community');
  });

  it('keeps one shared projection across route hops without another GET', async () => {
    expect(chats.mock.calls.every(([id]) => id === 'workspace-a')).toBe(true);
    expect(rail().props.workspaces.find((item: any) => item.id === 'workspace-empty')).toMatchObject({ needsAttention: true, roomCount: 3 });
    const initialReads = workspaces.mock.calls.length;
    const initialChatReads = chats.mock.calls.length;
    workspaceSummary.attention = false;
    workspaceSummary.roomCount = 2;
    route.pathname = '/beeline/tray';
    await act(async () => {
      pathnameListeners.forEach((listener) => listener());
      tree.update(<SidebarView />);
    });
    await settle();
    expect(workspaces).toHaveBeenCalledTimes(initialReads);
    expect(header().props.workspaceName).toBe('Alpha Workspace');
    // An unchanged row keeps its handlers across hops: the memoized row did not render again.
    const press = control('room-dm-a').props.onPress;
    for (let hop = 0; hop < 10; hop += 1) {
      route.pathname = hop % 2 ? '/beeline/chat/room-a' : '/beeline/tray';
      await act(async () => {
        pathnameListeners.forEach((listener) => listener());
        tree.update(<SidebarView />);
      });
      expect(control('room-room-a')).toBeDefined();
      expect(control('room-dm-a').props.onPress).toBe(press);
    }
    expect(workspaces).toHaveBeenCalledTimes(initialReads);
    expect(chats).toHaveBeenCalledTimes(initialChatReads);
    expect(saveActiveCommunityId).not.toHaveBeenCalled();
  });

  it('keeps the Mac workspace header below the overlay title bar, and the Windows one at the top', async () => {
    const titlebar = () => tree.root.findAll((node: any) => node.type === 'YStack' && node.props.height === 56);
    desktopShell.current = true;
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    try {
      await act(async () => tree.update(<SidebarView key="mac" />));
      expect(titlebar()).toHaveLength(1);
      vi.stubGlobal('navigator', { platform: 'Win32' });
      await act(async () => tree.update(<SidebarView key="windows" />));
      expect(titlebar()).toHaveLength(0);
      expect(header()).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens the switcher from Command-or-Control Shift S', () => {
    const preventDefault = vi.fn();
    act(() =>
      windowListeners.get('keydown')?.({ ctrlKey: true, metaKey: false, shiftKey: true, key: 's', target: null, preventDefault }),
    );
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(rail().props.open).toBe(true);
  });

  it.each([1024, 1440, 1920])('opens and closes the Workspace rail from the list header at %i px', async (width) => {
    viewport.width = width;
    await act(async () => tree.update(<SidebarView key={`width-${width}`} />));
    await settle();
    expect(rail().props.open).toBe(false);
    act(() => header().props.onWorkspace());
    expect(rail().props.open).toBe(true);
    act(() => rail().props.onClose());
    expect(rail().props.open).toBe(false);
  });

  it('switches header, list, URL, and closes the switcher for an empty Workspace', async () => {
    expect(header().props.workspaceName).toBe('Alpha Workspace');
    act(() => header().props.onWorkspace());
    expect(rail().props.open).toBe(true);
    await act(async () => {
      rail().props.onSelect('workspace-empty');
      expect(routerPush).toHaveBeenCalledWith({ pathname: '/beeline/channels', params: { communityId: 'workspace-empty' } });
      expect(chats.mock.calls.some(([id]) => id === 'workspace-empty')).toBe(false);
      await Promise.resolve();
      await Promise.resolve();
    });
    await expectEmptyRoomList();
    expect(rail().props.open).toBe(false);
    expect(chats).toHaveBeenCalledWith('workspace-empty');
    expect(saveActiveCommunityId).toHaveBeenCalledWith('viewer', 'workspace-empty');
  });

  it('keeps the search open while the Workspace rail opens and closes', () => {
    expect(tree.root.findAllByProps({ testID: 'room-search-input' })).toHaveLength(0);
    act(() => control('room-search-open').props.onPress());
    expect(control('room-search-input')).toBeDefined();
    act(() => header().props.onWorkspace());
    expect(rail().props.open).toBe(true);
    expect(control('room-search-input')).toBeDefined();
    act(() => rail().props.onClose());
    expect(rail().props.open).toBe(false);
  });

  it('opens desktop search from Command-or-Control K', () => {
    const preventDefault = vi.fn();
    expect(tree.root.findAllByProps({ testID: 'room-search-input' })).toHaveLength(0);
    act(() =>
      windowListeners.get('keydown')?.({ ctrlKey: true, metaKey: false, shiftKey: false, key: 'k', target: null, preventDefault }),
    );
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(control('room-search-input')).toBeDefined();
  });

  it('routes Tags, People and Settings, with no Workbench or Workspace menu entry', () => {
    expect(tree.root.findAllByProps({ testID: 'desktop-workbench' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: 'workspace-menu' })).toHaveLength(0);
    act(() => control('side-tray').props.onPress());
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/beeline/tray',
      params: { communityId: 'workspace-a', workspaceName: 'Alpha Workspace' },
    });
    act(() => control('side-people').props.onPress());
    expect(routerPush).toHaveBeenCalledWith('/beeline/people');
    act(() => control('side-settings').props.onPress());
    expect(routerPush).toHaveBeenCalledWith('/beeline/settings');
  });

  it.each([
    ['/beeline/tray', 'side-tray'],
    ['/beeline/people', 'side-people'],
    ['/beeline/settings/vault', 'side-settings'],
  ])('selects exactly one place on %s', async (pathname, selected) => {
    route.pathname = pathname;
    await act(async () => { tree.update(<SidebarView key={pathname} />); });
    await settle();
    for (const place of ['side-tray', 'side-people', 'side-settings'])
      expect(control(place).props.accessibilityState).toEqual({ selected: place === selected });
  });

  it('selects no place on the Members route', async () => {
    route.pathname = '/beeline/members';
    await act(async () => { tree.update(<SidebarView key="members-route" />); });
    await settle();
    expect(control('side-tray').props.accessibilityState).toEqual({ selected: false });
  });

  it('returns from a searched Room to the full list with search closed and empty', async () => {
    act(() => control('room-search-open').props.onPress());
    await act(async () => header().props.onSearch({ ...header().props.search, query: 'Alpha' }));
    expect(tree.root.findAllByProps({ testID: 'room-dm-a' })).toHaveLength(0);
    act(() => control('room-room-a').props.onPress());
    await act(async () => {
      route.pathname = '/beeline/chat/room-a';
      pathnameListeners.forEach((listener) => listener());
    });
    await act(async () => {
      route.pathname = '/beeline/channels';
      pathnameListeners.forEach((listener) => listener());
    });
    expect(tree.root.findAllByProps({ testID: 'room-search-input' })).toHaveLength(0);
    expect(control('room-dm-a')).toBeDefined();
    act(() => control('room-search-open').props.onPress());
    expect(control('room-search-input').props.value).toBe('');
  });

  it('narrows search by thread title and the Unread chip', async () => {
    act(() => control('room-search-open').props.onPress());
    await act(async () => header().props.onSearch({ open: true, query: 'fixture', chips: [] }));
    expect(control('room-room-a')).toBeDefined();
    expect(tree.root.findAllByProps({ testID: 'room-dm-a' })).toHaveLength(0);
    await act(async () => header().props.onSearch({ open: true, query: '', chips: ['unread'] }));
    expect(tree.root.findAllByProps({ testID: 'room-room-a' })).toHaveLength(0);
  });

  it('routes New chat to the deck sheet for a manager', () => {
    act(() => header().props.onNew());
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/beeline/channels',
      params: { communityId: 'workspace-a', newRoom: expect.any(String) },
    });
  });

  it.each([['member', 'human'], ['owner', 'agent']] as const)('offers no New chat to a %s %s and takes nothing else away', async (role, kind) => {
    workspaceRole.current = role;
    viewer.kind = kind;
    await refreshWorkspaceViewer();
    await act(async () => { tree.update(<SidebarView key={`${role}-${kind}`} />); });
    await settle();
    expect(header().props.onNew).toBeUndefined();
    expect(control('side-tray')).toBeDefined();
    expect(control('side-settings')).toBeDefined();
  });

  it('highlights the open chat for assistive technology', async () => {
    route.pathname = '/beeline/chat/room-a';
    await act(async () => { tree.update(<SidebarView key="active-room-route" />); });
    await settle();
    expect(control('room-room-a').props['aria-current']).toBe('page');
    expect(control('room-dm-a').props['aria-current']).toBeUndefined();
  });

  it('nests the chat threads and opens one in the main pane', () => {
    expect(control('thread-row-corner-a').props['aria-label']).toBe('Thread Fix fixture, working');
    expect(control('thread-row-corner-theirs').props['aria-label']).toBe('Thread Their fix, waiting on a reply');
    act(() => control('thread-row-corner-a').props.onPress());
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/beeline/chat/[channelId]',
      params: { channelId: 'corner-a', parent: 'room-a', title: 'Fix fixture' },
    });
  });

  it('opens a Room on a row click', () => {
    act(() => control('room-room-a').props.onPress());
    expect(routerNavigate).toHaveBeenCalledWith(
      { pathname: '/beeline/chat/[channelId]', params: { channelId: 'room-a' } },
      { dangerouslySingular: true },
    );
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('joins a public chat with the viewer id and opens it', async () => {
    const join = control('join-launch-room');
    expect(join.props['aria-label']).toBe('Join #launch');
    await act(async () => join.props.onPress());
    expect(operation).toHaveBeenCalledWith('addRoomMember', { roomId: 'launch-room', memberId: 'viewer' });
    expect(routerNavigate).toHaveBeenCalledWith(
      { pathname: '/beeline/chat/[channelId]', params: { channelId: 'launch-room' } },
      { dangerouslySingular: true },
    );
  });

  it('closes without routing when the current Workspace is picked', () => {
    act(() => header().props.onWorkspace());
    act(() => rail().props.onSelect('workspace-a'));
    expect(rail().props.open).toBe(false);
    expect(routerPush).not.toHaveBeenCalled();
    expect(saveActiveCommunityId).not.toHaveBeenCalled();
  });

  it('uses a deep-linked Workspace URL as the persistent desktop sidebar authority', async () => {
    route.communityId = 'workspace-empty';
    await act(async () => { tree.update(<SidebarView key="deep-linked-workspace" />); });
    await expectEmptyRoomList();
    expect(chats).toHaveBeenCalledWith('workspace-empty');
    expect(saveActiveCommunityId).toHaveBeenCalledWith('viewer', 'workspace-empty');
  });
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => undefined },
}));

import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { saveActiveCommunityId } from '@/buzz/community-storage';

const state = vi.hoisted(() => ({
    listener: null as null | ((event: any) => void),
    request: vi.fn(),
    list: { workspaces: [{ id: 'crew', name: 'Tubing Crew' }] } as { workspaces: { id: string; name: string }[] },
}));

vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native', () => ({ Platform: { OS: 'ios', select: (choices: Record<string, unknown>) => choices.ios ?? choices.default } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) }));
vi.mock('expo-router', () => ({
    useLocalSearchParams: () => ({}),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    router: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('@/buzz/latency-route-hook', () => ({ useLatencyRouteFrame: () => undefined }));
vi.mock('@/buzz/use-relative-time-refresh', () => ({ useRelativeTimeRefresh: () => undefined }));
vi.mock('@/auth/buzz-identity-storage', () => ({
    getEffectiveRelayUrl: async () => 'https://relay.test',
    loadBuzzIdentity: async () => ({ publicKey: 'viewer', secretKey: new Uint8Array(32) }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));
vi.mock('@/buzz/use-surface-focus', () => ({ useSurfaceFocus: () => true }));
vi.mock('@/sync/transport/live-connection', () => ({
    sharedLiveConnection: () => ({
        register: async (_filters: unknown, listener: (event: any) => void) => {
            state.listener = listener;
            return () => { state.listener = null; };
        },
    }),
}));
vi.mock('@/buzz/surface-storage', () => ({
    surfaceAddress: () => 'workspaces',
    mobileSurfaceCache: {
        peek: () => ({ workspaces: [] }),
        read: async () => ({ workspaces: [] }),
        fetch: async (_address: unknown, _guard: unknown, request: () => Promise<unknown>) => request(),
    },
}));
vi.mock('@/sync/transport/room-view-client', () => ({
    RoomViewClient: class { workspaces() { return state.request(); } },
}));
vi.mock('@/buzz/work-board-store', () => ({
    useWorkBoard: (id: string) => id ? {
        workspaceId: id, workspaceName: 'Tubing Crew', viewerId: 'viewer', items: [], chats: [], people: [],
    } : null,
    useWorkBoardUnavailable: () => false,
    loadWorkBoard: async () => undefined,
}));
vi.mock('@/ui/screens/tags/WorkBoard', () => ({
    WorkBoard: () => React.createElement('WorkBoard', { testID: 'work-board' }),
}));
vi.mock('@/components/buzz/SurfaceGlyphLoader', () => ({ SurfaceGlyphLoader: () => React.createElement('SurfaceGlyphLoader') }));
vi.mock('@/buzz/work-board-reply', () => ({ sendWorkReply: async () => true }));
vi.mock('@/buzz/corner-navigation', () => ({ messageJumpHref: () => ({}), navigateToRoom: () => undefined }));
vi.mock('@/push/push-room-prefetch', () => ({ prefetchPushRoom: () => undefined }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: async () => undefined }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: async () => undefined }));

import TrayScreen from './tray';

const hosts = (tree: ReactTestRenderer, testID: string) =>
    tree.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === testID);
const loaders = (tree: ReactTestRenderer) =>
    tree.root.findAll((node: any) => node.type === 'SurfaceGlyphLoader');
const mounted: ReactTestRenderer[] = [];

beforeEach(async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    state.list = { workspaces: [{ id: 'crew', name: 'Tubing Crew' }] };
    state.request.mockReset().mockImplementation(async () => state.list);
    state.listener = null;
    await saveActiveCommunityId('viewer', null);
});
afterEach(async () => { for (const tree of mounted.splice(0)) await act(async () => tree.unmount()); });

it('shows the Tasks list when no Workspace is saved but the viewer belongs to one', async () => {
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(<TrayScreen />); });
    mounted.push(tree);
    await vi.waitFor(() => expect(hosts(tree, 'work-board')).toHaveLength(1));
    expect(hosts(tree, 'tray-no-workspace')).toHaveLength(0);
    expect(state.request).toHaveBeenCalled();
    expect(loaders(tree)).toHaveLength(0);
});

it('keeps a failed discovery unresolved and reads again on reconnect', async () => {
    state.request.mockRejectedValueOnce(new Error('connection lost'));
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(<TrayScreen />); });
    mounted.push(tree);
    expect(state.request).toHaveBeenCalledTimes(1);
    expect(hosts(tree, 'tray-no-workspace')).toHaveLength(0);
    expect(loaders(tree)).toHaveLength(1);
    await act(async () => {
        state.listener?.({ monolithLive: { type: 'invalidate', roomId: '', reason: 'reconnect' } });
    });
    expect(state.request).toHaveBeenCalledTimes(2);
    expect(hosts(tree, 'work-board')).toHaveLength(1);
    expect(loaders(tree)).toHaveLength(0);
});

it('discovers membership added after a confirmed empty list', async () => {
    state.list = { workspaces: [] };
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(<TrayScreen />); });
    mounted.push(tree);
    expect(hosts(tree, 'tray-no-workspace')).toHaveLength(1);
    state.list = { workspaces: [{ id: 'crew', name: 'Tubing Crew' }] };
    await act(async () => {
        state.listener?.({ monolithLive: { type: 'invalidate', roomId: '', reason: 'postgres:memberships' } });
    });
    expect(hosts(tree, 'work-board')).toHaveLength(1);
    expect(hosts(tree, 'tray-no-workspace')).toHaveLength(0);
});

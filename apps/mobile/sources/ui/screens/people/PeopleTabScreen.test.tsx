import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native', () => ({ Platform: { OS: 'ios', select: (choices: Record<string, unknown>) => choices.ios ?? choices.default } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({}), router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('@/buzz/latency-route-hook', () => ({ useLatencyRouteFrame: () => undefined }));
vi.mock('@/buzz/use-active-community', () => ({ useActiveCommunityId: () => 'ws' }));
vi.mock('@/ui/shell/panel', () => ({ openPlace: vi.fn() }));
vi.mock('@/auth/buzz-identity-storage', () => ({
    getEffectiveRelayUrl: async () => 'https://relay.test',
    loadBuzzIdentity: async () => ({ publicKey: 'viewer' }),
}));
vi.mock('@/buzz/surface-storage', () => ({
    surfaceAddress: (_relay: string, _viewer: string, endpoint: string) => endpoint,
    mobileSurfaceCache: { read: async () => ({ workspaces: [{ id: 'ws', name: 'Tubing crew' }] }) },
}));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: (props: any) => React.createElement('IdentityMark', props) }));
vi.mock('@/components/buzz/SurfaceGlyphLoader', () => ({ SurfaceGlyphLoader: () => React.createElement('SurfaceGlyphLoader') }));
vi.mock('./InvitePeopleSheet', () => ({ InvitePeopleSheet: (props: any) => React.createElement('InvitePeopleSheet', props) }));
vi.mock('./AddAgentSheet', () => ({ AddAgentSheet: (props: any) => React.createElement('AddAgentSheet', props) }));
vi.mock('./use-workspace-roster', () => ({
    useWorkspaceRoster: () => ({
        surface: { workspace: { id: 'ws', name: 'Tubing crew' }, viewer: { permissions: { manage: true } } },
        viewerPubkey: 'viewer', people: [], agents: [], peopleTotal: 0, agentTotal: 0,
    }),
}));

import { PeopleTabScreen } from './PeopleTabScreen';

const hosts = (tree: ReactTestRenderer, testID: string) =>
    tree.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === testID);
const mounted: ReactTestRenderer[] = [];

async function render(): Promise<ReactTestRenderer> {
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(<PeopleTabScreen />); });
    await act(async () => undefined);
    mounted.push(tree);
    return tree;
}

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { for (const tree of mounted.splice(0)) await act(async () => tree.unmount()); });

it('keeps Invite beside the People section and out of the shared phone header', async () => {
    const tree = await render();
    const header = hosts(tree, 'chat-list-header')[0];
    expect(header.findAll((node: any) => node.type === 'Text' && node.props.children === 'Tubing crew')).not.toHaveLength(0);
    expect(tree.root.findAll((node: any) => node.type === 'Text' && node.props.children === 'People')).toHaveLength(0);
    const copy = tree.root.findAll((node: any) => node.type === 'Text').map((node: any) => String(node.props.children));
    expect(copy.some((text: string) => text.startsWith('Everyone in') || text.startsWith('Owners and admins'))).toBe(false);
    const invite = hosts(tree, 'people-invite');
    expect(invite).toHaveLength(1);
    expect(header.findAll((node: any) => node.props.testID === 'people-invite' && typeof node.type === 'string')).toHaveLength(0);
    expect(hosts(tree, 'people-humans')[0].findAll((node: any) => node.props.testID === 'people-invite' && typeof node.type === 'string')).toHaveLength(1);
    expect(hosts(tree, 'people-add-agent')).toHaveLength(1);
    expect(invite[0].props['aria-label']).toBe('Invite to Tubing crew');
    expect(hosts(tree, 'room-search-open')).toHaveLength(0);
    await act(async () => invite[0].props.onPress());
    expect(tree.root.find((node: any) => node.type === 'InvitePeopleSheet').props.open).toBe(true);
});

it('opens the Workspace rail from the name, and draws the hairline once the list scrolls', async () => {
    const tree = await render();
    expect(hosts(tree, 'community-drawer-overlay')).toHaveLength(0);
    await act(async () => hosts(tree, 'workspace-switcher')[0].props.onPress());
    expect(hosts(tree, 'community-drawer-overlay')).toHaveLength(1);
    expect(hosts(tree, 'community-rail-ws')).toHaveLength(1);
    expect(hosts(tree, 'tab-header-edge')[0].props.borderColor).toBe('transparent');
    const list = tree.root.find((node: any) => node.type === 'ScrollView' && node.props.onScroll);
    await act(async () => list.props.onScroll({ nativeEvent: { contentOffset: { y: 24 } } }));
    expect(hosts(tree, 'tab-header-edge')[0].props.borderColor).toBe('stroke');
});

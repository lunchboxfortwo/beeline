import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('react-native-reanimated', () => ({
    useSharedValue: (value: number) => React.useRef({ value }).current,
    useAnimatedStyle: (work: () => unknown) => work(),
    useReducedMotion: () => false,
    withTiming: (value: number) => value,
    ReduceMotion: { System: 'system' },
    Easing: { bezier: () => null, out: () => null, poly: () => null },
    runOnJS: (work: unknown) => work,
}));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: 'IdentityMark' }));
import { BuzzCommunityShell, CommunityRail, useCommunityDrawer } from './CommunityRail';

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

it('lists Workspaces and Add, and leaves Settings to its tab', () => {
    const onSelect = vi.fn();
    const onAdd = vi.fn();
    let tree: any;
    act(() => {
        tree = create(<CommunityRail communities={[{ communityId: 'w1', name: 'Beeline Work' }]} activeCommunityId="w1" onSelect={onSelect} onAdd={onAdd} />);
    });
    const byID = (id: string) => tree.root.findAll((node: any) => node.props?.testID === id && typeof node.type === 'string');
    expect(byID('community-rail-settings')).toHaveLength(0);
    act(() => byID('community-rail-w1')[0].props.onPress());
    expect(onSelect).toHaveBeenCalledWith('w1');
    act(() => byID('community-rail-add')[0].props.onPress());
    expect(onAdd).toHaveBeenCalled();
});

it('keeps drawer consumers unchanged across unrelated Room renders', () => {
    const renders = vi.fn();
    const Probe = React.memo(() => { renders(useCommunityDrawer()); return null; });
    const child = <Probe />;
    const props = { communities: [], activeCommunityId: null, onSelect: vi.fn(), onAdd: vi.fn() };
    let tree: any;
    act(() => { tree = create(<BuzzCommunityShell {...props}>{child}</BuzzCommunityShell>); });
    act(() => tree.update(<BuzzCommunityShell {...props} communities={[]}>{child}</BuzzCommunityShell>));
    expect(renders).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
});

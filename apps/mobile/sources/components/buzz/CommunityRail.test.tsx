import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: 'IdentityMark' }));
import { CommunityRail } from './CommunityRail';

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

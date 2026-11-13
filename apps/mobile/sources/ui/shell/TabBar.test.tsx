import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('expo-router', () => ({ router: { canDismiss: () => false, dismissAll: vi.fn(), replace: vi.fn() } }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
const platform = vi.hoisted(() => ({ OS: 'android' }));
vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

async function labelProps(os: string, label: string) {
    platform.OS = os;
    vi.resetModules();
    const { TabBar } = await import('./TabBar');
    let tree: any;
    act(() => { tree = create(<TabBar active="chats" />); });
    return tree.root.find((node: any) => node.type === 'Text' && node.props.children === label).props;
}

it.each(['Chats', 'Tags', 'People', 'Settings'])('keeps the %s tab label on one line and shrinks it to fit on Android', async (label) => {
    expect(await labelProps('android', label)).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true });
});

it('leaves web tab labels as they were, with no ellipsis', async () => {
    const props = await labelProps('web', 'People');
    expect(props.numberOfLines).toBeUndefined();
    expect(props.adjustsFontSizeToFit).toBeUndefined();
});

import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

const currentTheme = vi.hoisted(() => ({ name: 'dark_brass' }));

vi.mock('expo-router', () => ({ router: { canDismiss: () => false, dismissAll: vi.fn(), replace: vi.fn() } }));
// createTamagui hands back its config, so the real theme values can be read.
vi.mock('tamagui', async () => ({ ...(await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts(), createTamagui: (config: unknown) => config, useThemeName: () => currentTheme.name }));
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
const platform = vi.hoisted(() => ({ OS: 'android' }));
vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; currentTheme.name = 'dark_brass'; });

async function labelProps(os: string, label: string) {
    platform.OS = os;
    vi.resetModules();
    const { TabBar } = await import('./TabBar');
    let tree: any;
    act(() => { tree = create(<TabBar active="chats" />); });
    return tree.root.find((node: any) => node.type === 'Text' && node.props.children === label).props;
}

it.each(['Chats', 'Tasks', 'Team', 'Settings'])('keeps the %s tab label on one line and shrinks it to fit on Android', async (label) => {
    expect(await labelProps('android', label)).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true });
});

it('leaves web tab labels as they were, with no ellipsis', async () => {
    const props = await labelProps('web', 'Team');
    expect(props.numberOfLines).toBeUndefined();
    expect(props.adjustsFontSizeToFit).toBeUndefined();
});

it.each(['dark', 'light'])('shows the selected tab apart from the others under %s Stone colors', async (mode) => {
    platform.OS = 'ios';
    currentTheme.name = `${mode}_stone`;
    vi.resetModules();
    const { TabBar } = await import('./TabBar');
    const { tamaguiConfig, themeName } = await import('@/ui/tamagui.config');
    const theme = (tamaguiConfig as unknown as { themes: Record<string, Record<string, string>> }).themes[themeName(mode as 'dark' | 'light', 'stone')];
    let tree: any;
    act(() => { tree = create(<TabBar active="people" />); });
    const color = (label: string) => theme[tree.root.find((node: any) => node.type === 'Text' && node.props.children === label).props.color];
    expect(color('Team')).toBe(theme.ink);
    for (const other of ['Chats', 'Tasks', 'Settings']) expect(color(other)).not.toBe(color('Team'));
    // Tab bar B: a bold label and a heavier icon, no bar above the tab.
    const tab = (value: string) => tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === `tab-${value}`);
    const stroke = (value: string) => tab(value).find((node: any) => node.props.strokeWidth !== undefined).props.strokeWidth;
    expect(tree.root.findAll((node: any) => node.props.testID === 'tab-selected-line')).toHaveLength(0);
    expect(stroke('people')).toBeGreaterThan(stroke('chats'));
    const face = (value: string) => tab(value).find((node: any) => node.type === 'Text').props.fontFamily;
    expect(face('people')).not.toBe(face('chats'));
    expect(face('chats')).toBe(face('tags'));
});

import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) { return store.get(key); }
        set(key: string, value: string) { store.set(key, value); }
        delete(key: string) { store.delete(key); }
    },
}));
vi.mock('@/utils/web-storage', () => ({ webRuntimeStorage: () => null }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('@/display', () => ({ applyAppearanceChoice: vi.fn() }));
vi.mock('@/buzz/room-open-trace', () => ({ roomOpenTraceEnabled: () => false }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: async () => undefined }));
vi.mock('@/components/buzz/IdentityMark', () => ({
    IdentityMark: (props: Record<string, unknown>) => React.createElement('IdentityMark', props),
    isPersonPictureUrl: () => false,
}));
vi.mock('@/components/buzz/ServiceMark', () => ({ ServiceMark: () => null }));
vi.mock('@/components/buzz/BeelineMark', () => ({ BeelineMark: () => null }));

import { YouSettings } from './YouSettings';
import type { YouSettings as You } from './useYouSettings';
import { storage } from '@/sync/storage';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const you = {
    error: null, notice: null, pubkey: 'person', name: 'Lunchbox', handle: 'lunchboxfortwo', avatar: null, providers: [],
    role: null, workspace: null, canManageWorkspace: false, workbench: null,
    push: { supported: false, level: 'attention', disabled: false, working: false, failure: null, retry: () => undefined, change: () => undefined },
    speakingSpeed: 1.15, changeSpeakingSpeed: () => undefined,
    busy: null, connectGoogle: async () => undefined, connectGitHub: async () => undefined, changePicture: async () => undefined,
    signOut: async () => undefined, deleteAccount: async () => undefined,
    update: { enabled: false, busy: false, message: null, label: 'Check', check: () => undefined, version: 'test' },
} as unknown as You;

function render() {
    let tree: ReturnType<typeof create>;
    act(() => { tree = create(React.createElement(YouSettings, { you })); });
    return tree!;
}

const item = (tree: ReturnType<typeof create>, id: string) => tree.root.findByProps({ testID: id });

describe('Color set radios', () => {
    beforeEach(() => {
        store.clear();
        storage.getState().applyLocalSettings({ palette: 'stone' });
    });

    // Reproduction R1: Stone is the active colour set and its radio has to read as selected.
    it('fills the radio for the colour set in use, and moves the fill when the other is picked', () => {
        const tree = render();
        const group = tree.root.findByProps({ 'aria-label': 'Color set' });
        expect(group.props.value).toBe('stone');
        expect(item(tree, 'palette-stone').props.theme).toBe('brand');
        expect(item(tree, 'palette-brass').props.theme).toBeUndefined();

        act(() => group.props.onValueChange('brass'));

        expect(tree.root.findByProps({ 'aria-label': 'Color set' }).props.value).toBe('brass');
        expect(item(tree, 'palette-brass').props.theme).toBe('brand');
        expect(item(tree, 'palette-stone').props.theme).toBeUndefined();
    });
});

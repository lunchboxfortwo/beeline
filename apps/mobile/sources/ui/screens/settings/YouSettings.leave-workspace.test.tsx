import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

vi.mock('react-native-mmkv', () => ({ MMKV: class { getString() { return undefined; } set() {} delete() {} } }));
vi.mock('@/utils/web-storage', () => ({ webRuntimeStorage: () => null }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('@/display', () => ({ applyAppearanceChoice: vi.fn() }));
vi.mock('@/buzz/room-open-trace', () => ({ roomOpenTraceEnabled: () => false }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: async () => undefined }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: () => null, isPersonPictureUrl: () => false }));
vi.mock('@/components/buzz/ServiceMark', () => ({ ServiceMark: () => null }));
vi.mock('@/components/buzz/BeelineMark', () => ({ BeelineMark: () => null }));

import { YouSettings } from './YouSettings';
import type { YouSettings as You } from './useYouSettings';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const you = (extra: Partial<You>) => ({
    error: null, notice: null, pubkey: 'person', name: 'Maya', handle: 'maya', avatar: null, providers: [],
    role: 'member', workspace: null, canManageWorkspace: false, workbench: null,
    push: { supported: false, level: 'attention', disabled: false, working: false, failure: null, retry: () => undefined, change: () => undefined },
    speakingSpeed: 1.15, changeSpeakingSpeed: () => undefined,
    busy: null, connectGoogle: async () => undefined, connectGitHub: async () => undefined, changePicture: async () => undefined,
    leaveWorkspace: vi.fn(async () => undefined), signOut: async () => undefined, deleteAccount: async () => undefined,
    update: { enabled: false, busy: false, message: null, label: 'Check', check: () => undefined, version: 'test' },
    ...extra,
}) as unknown as You;

it('LEAVE-WORKSPACE-1: Settings → You offers a plain member a way out of the current Workspace', () => {
    const member = you({ workspace: { id: 'w1', name: 'Beeline Review', role: 'member' } as never });
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<YouSettings you={member} />); });
    const row = tree.root.findByProps({ testID: 'leave-workspace-setting' });
    expect(row.props.label).toBe('Leave Beeline Review');
    act(() => row.props.onPress());
    expect(member.leaveWorkspace).toHaveBeenCalledOnce();

    // With no Workspace there is nothing to leave.
    act(() => tree.update(<YouSettings you={you({})} />));
    expect(tree.root.findAllByProps({ testID: 'leave-workspace-setting' })).toHaveLength(0);
    act(() => tree.unmount());
});

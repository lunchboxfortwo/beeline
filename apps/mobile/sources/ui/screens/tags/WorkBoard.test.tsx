import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { WorkBoardView } from '@beeline/api-contract/phone';

vi.mock('react-native', () => ({ Platform: { OS: 'ios', select: (choices: any) => choices.ios ?? choices.default } }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: () => null }));
vi.mock('@/ui/shell/TabHeader', () => ({ TabHeader: () => null, useScrolledUnder: () => ({ scrolled: false, scrollProps: {} }) }));
vi.mock('./WorkItemDetail', () => ({ WorkSheet: () => null }));

import { WorkBoard } from './WorkBoard';

it('expands Done on tap and collapses it on the next tap', () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const board = {
        workspaceId: 'ws', workspaceName: 'Crew', viewerId: 'viewer', chats: [], people: [],
        items: [{ id: 'finished', title: 'Finished work', state: 'done', chatName: 'general', threadName: 'Finished work' }],
    } as unknown as WorkBoardView;
    const actions = { open: vi.fn(), reply: vi.fn(), decide: vi.fn(), assign: vi.fn(), clear: vi.fn(), clearAll: vi.fn() };
    let tree: any;
    act(() => { tree = create(<WorkBoard board={board} desktop={false} actions={actions} />); });
    const host = (id: string) => tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === id);
    const rows = () => tree.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === 'work-item-finished');
    try {
        expect(host('work-section-done').props['aria-expanded']).toBe(false);
        expect(rows()).toHaveLength(0);
        act(() => host('work-section-done').props.onPress());
        expect(host('work-section-done').props['aria-expanded']).toBe(true);
        expect(rows()).toHaveLength(1);
        act(() => host('work-section-done').props.onPress());
        expect(host('work-section-done').props['aria-expanded']).toBe(false);
        expect(rows()).toHaveLength(0);
    } finally { act(() => tree.unmount()); }
});

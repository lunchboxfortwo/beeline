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


it.each([false, true])('renders each ask kind with its asking time on desktop=%s and refreshes from now', (desktop) => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const now = 1_800_000_000_000;
    const person = { pubkey: 'agent', kind: 'agent' as const, name: 'Jellybean' };
    const approvals = [
        { kind: 'choice' as const, actor: 'Jellybean', ask: 'asks', subject: 'Which surface?', literal: false,
          actions: [{ kind: 'choice' as const, label: 'Phone', choiceId: 'choice', optionId: 'phone' }] },
        undefined,
        { kind: 'grant' as const, actor: 'Jellybean', ask: 'asks to run', subject: 'npm test', literal: true,
          actions: [{ kind: 'grant' as const, label: 'Allow once', grantId: 'grant', decision: 'once' as const }] },
    ];
    const ages = [120, 3 * 3600, 2 * 86400];
    const board: WorkBoardView = {
        workspaceId: 'ws', workspaceName: 'Crew', viewerId: 'viewer', chats: [], people: [],
        items: approvals.map((approval, index) => ({
            id: String(index), roomId: 'chat', chatId: 'chat', chatName: 'general', threadName: 'Launch',
            title: 'Launch', state: 'needs-you', openedBy: person, assignee: null,
            createdAt: 1, updatedAt: now / 1000,
            ask: { messageId: String(index), workspaceId: 'ws', roomId: 'chat', roomName: 'general',
                roomKind: 'room', text: 'Please report progress?', createdAt: now / 1000 - ages[index]!, approval },
        })),
    };
    const actions = { open: vi.fn(), reply: vi.fn(), decide: vi.fn(), assign: vi.fn(), clear: vi.fn(), clearAll: vi.fn() };
    let tree: any;
    const render = (at: number) => <WorkBoard board={board} desktop={desktop} actions={actions} now={at} />;
    act(() => { tree = create(render(now)); });
    const cardText = (index: number) => tree.root
        .find((n: any) => typeof n.type === 'string' && n.props.testID === `work-ask-${index}`)
        .findAll((n: any) => n.type === 'Text')
        .flatMap((n: any) => [n.props.children].flat(Infinity));
    try {
        ['2m', '3h', '2d'].forEach((stamp, index) => expect(cardText(index)).toContain(stamp));
        act(() => tree.update(render(now + 60_000)));
        expect(cardText(0)).toContain('3m');
    } finally { act(() => tree.unmount()); }
});

it('never disables the Needs you header or Clear all, and Clear all stays pressable while a clear is pending', () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const board = {
        workspaceId: 'ws', workspaceName: 'Crew', viewerId: 'viewer', chats: [], people: [],
        items: [{ id: 'ask', roomId: 'chat', chatId: 'chat', chatName: 'general', threadName: 'Launch', title: 'Launch', state: 'needs-you',
            openedBy: { pubkey: 'agent', kind: 'agent', name: 'Jellybean' }, assignee: null, createdAt: 1, updatedAt: 2,
            ask: { messageId: 'ask', workspaceId: 'ws', roomId: 'chat', roomName: 'general', roomKind: 'room', text: 'Which surface?', createdAt: 1 } }],
    } as unknown as WorkBoardView;
    const actions = { open: vi.fn(), reply: vi.fn(), decide: vi.fn(), assign: vi.fn(), clear: vi.fn(), clearAll: vi.fn(() => new Promise<void>(() => {})) };
    let tree: any;
    act(() => { tree = create(<WorkBoard board={board} desktop={false} actions={actions} />); });
    const host = (id: string) => tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === id);
    try {
        expect(host('work-section-needs-you').props.disabled).toBeFalsy();
        expect(host('work-clear-all').props.disabled).toBeFalsy();
        act(() => host('work-clear-all').props.onPress());
        act(() => host('work-clear-all').props.onPress());
        expect(actions.clearAll).toHaveBeenCalledTimes(2);
        expect(host('work-clear-all').props.disabled).toBeFalsy();
    } finally { act(() => tree.unmount()); }
});

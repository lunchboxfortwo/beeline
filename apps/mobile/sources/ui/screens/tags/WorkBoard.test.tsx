import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { WorkBoardView } from '@beeline/api-contract/phone';

vi.mock('react-native', () => ({ Platform: { OS: 'ios', select: (choices: any) => choices.ios ?? choices.default } }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: (props: any) => React.createElement('IdentityMark', props) }));
vi.mock('@/ui/shell/TabHeader', () => ({ TabHeader: () => null, useScrolledUnder: () => ({ scrolled: false, scrollProps: {} }) }));
vi.mock('./WorkItemDetail', () => ({ WorkSheet: (props: any) => React.createElement('WorkSheet', props) }));
vi.mock('@/components/buzz/CodeBlock', () => ({ CodeBlock: () => null }));
vi.mock('@/buzz/message-link', () => ({ messageLinkId: () => undefined, openMessageLink: vi.fn() }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn().mockResolvedValue(undefined) }));

import { WorkBoard } from './WorkBoard';
import { ProseRun } from '@/ui/grammar';
import { MonoMarkdown } from '@/components/buzz/MonoMarkdown';
import { openExternalUrl } from '@/utils/open-external-url';

it.each([false, true])('renders Needs you markdown with transcript formatting on desktop=%s', (desktop) => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const markdown = '**11 sources**\n\n**What squire has:**\n- `account_id`\n- [Source](https://example.com/source)';
    const person = { pubkey: 'agent', kind: 'agent' as const, name: 'Ruby' };
    const board: WorkBoardView = {
        workspaceId: 'ws', workspaceName: 'Tubing Crew', viewerId: 'viewer', chats: [], people: [],
        items: [{ id: 'ask', roomId: 'chat', chatId: 'chat', chatName: 'grunt', threadName: 'Launch',
            title: 'Launch', state: 'needs-you', openedBy: person, assignee: null, createdAt: 1, updatedAt: 2,
            ask: { messageId: 'ask', workspaceId: 'ws', roomId: 'chat', roomName: 'grunt', roomKind: 'room',
                author: person, text: markdown, createdAt: 1 } }],
    };
    const actions = { open: vi.fn(), reply: vi.fn(), decide: vi.fn(), assign: vi.fn(), clear: vi.fn(), clearAll: vi.fn() };
    let tree: any;
    act(() => { tree = create(<WorkBoard board={board} desktop={desktop} actions={actions} />); });
    try {
        const card = tree.root.find((n: any) => typeof n.type === 'string' && n.props.testID === 'work-ask-ask');
        const runs = card.findAllByType(ProseRun);
        expect(runs.filter((n: any) => n.props.marks?.includes('strong')).map((n: any) => n.props.children))
            .toEqual(['11 sources', 'What squire has:']);
        expect(runs.find((n: any) => n.props.marks?.includes('code')).props.children).toBe('account_id');
        expect(runs.filter((n: any) => n.props.children === '· ')).toHaveLength(2);
        const link = runs.find((n: any) => n.props.accessibilityRole === 'link');
        expect(link.props.children).toBe('Source');
        act(() => link.props.onPress());
        expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/source');
        expect(actions.open).not.toHaveBeenCalled();
        expect(card.findAll((n: any) => n.type === 'Text' && n.props.children === markdown)).toHaveLength(0);
    } finally { act(() => tree.unmount()); }
});

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
                roomKind: 'room', author: index === 1 ? { pubkey: 'human', kind: 'human', name: 'Juniper' } : person, text: 'Please report progress?', createdAt: now / 1000 - ages[index]!, approval },
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
        ['2m', '3h', '2d'].forEach((stamp, index) => {
            expect(cardText(index)).toContain(stamp);
            expect(cardText(index)).toContain(index === 1 ? 'Juniper' : 'Jellybean');
        });
        expect(tree.root.findAll((n: any) => n.type === 'IdentityMark' && n.props.seed === 'agent')).toHaveLength(2);
        expect(tree.root.findAll((n: any) => n.type === 'IdentityMark' && n.props.seed === 'human' && n.props.kind === 'human')).toHaveLength(1);
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


it.each([[false, false], [false, true], [true, false], [true, true]])('shows the full post and question once on desktop=%s with question in post=%s', async (desktop, includesQuestion) => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const person = { pubkey: 'agent', kind: 'agent' as const, name: 'Ruby' };
    const question = 'Should I set up Squire?';
    const context = 'I am researching launch sources for you. '.repeat(16) + '\nThe vendor report is missing, so I cannot finish the comparison.';
    const fullPost = includesQuestion ? `${context} ${question}` : context;
    const choices = ['Yes', 'No'].map(label => ({ kind: 'choice' as const, choiceId: 'choice', optionId: label, label }));
    const board: WorkBoardView = {
        workspaceId: 'ws', workspaceName: 'Crew', viewerId: 'viewer', chats: [], people: [],
        items: [{ id: 'ask', roomId: 'chat', chatId: 'chat', chatName: 'general', threadName: 'Launch', title: 'Launch', state: 'needs-you',
            openedBy: person, assignee: null, createdAt: 1, updatedAt: 2, recommendedOptionId: 'Yes',
            ask: { messageId: 'ask', workspaceId: 'ws', roomId: 'chat', roomName: 'general', roomKind: 'room', author: person,
                text: fullPost, createdAt: 1,
                approval: { kind: 'choice', actor: 'Ruby', ask: 'asks', subject: question, literal: false, actions: choices } } }],
    };
    const actions = { open: vi.fn(), reply: vi.fn(), decide: vi.fn(), assign: vi.fn(), clear: vi.fn(), clearAll: vi.fn() };
    let tree: any;
    act(() => { tree = create(<WorkBoard board={board} desktop={desktop} actions={actions} />); });
    try {
        const post = tree.root.findByType(MonoMarkdown);
        expect(post.props.markdown).toBe(fullPost);
        expect(post.props.numberOfLines).toBeUndefined();
        expect(post.props.ellipsizeMode).toBeUndefined();
        const separateQuestions = tree.root.findAll((node: any) => node.type === 'Text' && node.props.children === question);
        expect(separateQuestions).toHaveLength(includesQuestion ? 0 : 1);
        const { Btn } = await import('@/ui/grammar');
        const buttons = tree.root.findAllByType(Btn).filter((node: any) => ['Yes', 'No'].includes(node.props.label));
        expect(buttons.map((node: any) => node.props.kind)).toEqual(['secondary', 'secondary']);
        await act(async () => buttons[0].props.onPress({ stopPropagation() {} }));
        expect(actions.decide).toHaveBeenCalledWith(board.items[0], choices[0]);
    } finally { act(() => tree.unmount()); }
});

it('TASK-STATE-2: a thread card opens its thread, and its status mark opens the task sheet', () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const item = { id: 'thread', roomId: 'thread', roomKind: 'corner', chatId: 'chat', chatName: 'general', threadName: 'Ship it', title: 'Ship it', state: 'in-progress' };
    const board = { workspaceId: 'ws', workspaceName: 'Crew', viewerId: 'viewer', chats: [], people: [], items: [item] } as unknown as WorkBoardView;
    const actions = { open: vi.fn(), reply: vi.fn(), decide: vi.fn(), assign: vi.fn(), clear: vi.fn(), clearAll: vi.fn() };
    let tree: any;
    act(() => { tree = create(<WorkBoard board={board} desktop={false} actions={actions} />); });
    const host = (id: string) => tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === id);
    try {
        if (host('work-section-in-progress').props['aria-expanded'] === false) act(() => host('work-section-in-progress').props.onPress());
        act(() => host('work-item-thread').props.onPress());
        expect(actions.open).toHaveBeenCalledOnce();
        expect(tree.root.findByType('WorkSheet').props.item).toBeNull();
        act(() => host('work-state-mark-thread').props.onPress());
        expect(tree.root.findByType('WorkSheet').props.item).toMatchObject({ id: 'thread' });
        expect(actions.open).toHaveBeenCalledOnce();
    } finally { act(() => tree.unmount()); }
});

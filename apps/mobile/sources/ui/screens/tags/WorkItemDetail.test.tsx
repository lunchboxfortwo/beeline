import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { WorkItemView } from '@beeline/api-contract/phone';

const keyboard = vi.hoisted(() => ({ height: { value: 0 } }));
vi.mock('react-native-keyboard-controller', () => ({ useReanimatedKeyboardAnimation: () => keyboard }));
vi.mock('react-native', () => ({ useWindowDimensions: () => ({ height: 844, width: 390 }) }));
vi.mock('@/ui/lower-keyboard', () => ({ lowerKeyboard: vi.fn() }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 34, left: 0, right: 0 }) }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: () => null }));
const work = vi.hoisted(() => ({ loadWorkBoard: vi.fn(async () => undefined), monolithPhoneOperation: vi.fn(async () => undefined) }));
vi.mock('@/buzz/work-board-store', () => ({ loadWorkBoard: work.loadWorkBoard }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: work.monolithPhoneOperation }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn() }));
import { KeyboardBody } from '@/ui/grammar';
import { WorkItemDetail, WorkSheet } from './WorkItemDetail';

it('keeps the note and Send inside the shared keyboard body while activity can shrink and scroll', () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const item = { id: 'test', roomId: 'room', title: 'Test backlog item', state: 'backlog', entries: [], attachments: [] } as unknown as WorkItemView;
    let tree: any;
    const sheet = () => <WorkSheet item={item} close={vi.fn()} workspaceId="ws" viewerId="viewer" desktop={false} now={0} />;
    act(() => { tree = create(sheet()); });
    try {
        const body = tree.root.findByType(KeyboardBody);
        expect(body.props.maxHeight).toBe(844 - 24 - 24);
        for (const id of ['work-note-input', 'work-note-send']) {
            expect(body.findAll((node: any) => typeof node.type === 'string' && node.props.testID === id)).toHaveLength(1);
        }
        const scroll = body.findByType('ScrollView');
        expect(scroll.props.flexShrink).toBe(1);
        expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
        keyboard.height.value = -300;
        act(() => { tree.update(sheet()); });
        const padded = tree.root.findByType(KeyboardBody).findByType('View');
        expect(Object.assign({}, ...padded.props.style).paddingBottom).toBe(300);
        keyboard.height.value = 0;
        act(() => { tree.update(sheet()); });
        expect(Math.abs(Object.assign({}, ...tree.root.findByType(KeyboardBody).findByType('View').props.style).paddingBottom)).toBe(0);
    } finally { act(() => tree.unmount()); }
});

it('TASK-STATE-1: the task sheet sets Backlog, In progress or Done through updateWorkItem', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const item = { id: 'task', roomId: 'room', title: 'Ship it', state: 'in-progress', entries: [], attachments: [] } as unknown as WorkItemView;
    let tree: any;
    act(() => { tree = create(<WorkItemDetail item={item} workspaceId="ws" viewerId="viewer" desktop={false} now={0} />); });
    const choice = (state: string) => tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === `work-state-${state}`);
    expect(['backlog', 'in-progress', 'done'].map((state) => choice(state).props['aria-checked'])).toEqual([false, true, false]);
    await act(async () => { choice('done').props.onPress(); });
    expect(work.monolithPhoneOperation).toHaveBeenCalledExactlyOnceWith('updateWorkItem', { roomId: 'room', id: 'task', state: 'done' });
    expect(work.loadWorkBoard).toHaveBeenCalledWith('ws', true);
    // The current state is not sent again.
    await act(async () => { choice('in-progress').props.onPress(); });
    expect(work.monolithPhoneOperation).toHaveBeenCalledOnce();
    act(() => tree.unmount());
});


it.each([false, true])('hides archived task transitions on desktop=%s', async (desktop) => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    work.monolithPhoneOperation.mockClear();
    const item = { id: 'archived', roomId: 'thread', title: 'Closed work', state: 'done', roomArchived: true, entries: [], attachments: [] } as unknown as WorkItemView;
    let tree: any;
    act(() => { tree = create(<WorkItemDetail item={item} workspaceId="ws" viewerId="viewer" desktop={desktop} now={0} />); });
    expect(tree.root.findAll((node: any) => node.props.testID === 'work-state-picker')).toHaveLength(0);
    expect(work.monolithPhoneOperation).not.toHaveBeenCalled();
    act(() => { tree.update(<WorkItemDetail item={{ ...item, roomArchived: undefined }} workspaceId="ws" viewerId="viewer" desktop={desktop} now={0} />); });
    const choice = tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === 'work-state-backlog');
    await act(async () => { choice.props.onPress(); });
    expect(work.monolithPhoneOperation).toHaveBeenCalledExactlyOnceWith('updateWorkItem', { roomId: 'thread', id: 'archived', state: 'backlog' });
    act(() => tree.unmount());
});

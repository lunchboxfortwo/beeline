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
vi.mock('@/buzz/work-board-store', () => ({ loadWorkBoard: vi.fn() }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: vi.fn() }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn() }));
import { KeyboardBody } from '@/ui/grammar';
import { WorkSheet } from './WorkItemDetail';

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

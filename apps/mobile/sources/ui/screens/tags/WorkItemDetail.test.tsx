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
const work = vi.hoisted(() => ({
  loadWorkBoard: vi.fn(async () => undefined),
  monolithPhoneOperation: vi.fn(async () => undefined),
  openExternalUrl: vi.fn(async () => undefined),
  openMessageLink: vi.fn(async () => undefined),
  prompt: vi.fn(async (): Promise<string | null> => null),
  alert: vi.fn(),
  actionSheet: vi.fn(),
  navigate: vi.fn(),
  resolveChatLinks: vi.fn(async () => ({ links: [] as any[] })),
  chats: vi.fn(async () => ({ chats: [] as any[] })),
}));
vi.mock('@/buzz/work-board-store', () => ({ loadWorkBoard: work.loadWorkBoard }));
vi.mock('@/sync/transport/monolith-operation', () => ({
  MonolithPhoneOperationError: class MonolithPhoneOperationError extends Error {
    constructor(readonly operation: string, readonly status: number, readonly code: string) {
      super(code);
    }
  },
  monolithPhoneOperation: work.monolithPhoneOperation,
  phoneOperationFailureReason: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: work.openExternalUrl }));
vi.mock('@/buzz/message-link', () => ({
  messageLinkId: (url: string) => /^#beeline\/[^\s/()<>]+\/([0-9a-f]{64})$/.exec(url)?.[1] ?? null,
  openMessageLink: work.openMessageLink,
  openChatMessageLink: vi.fn(),
}));
vi.mock('@/modal', () => ({
  Modal: { prompt: work.prompt, alert: work.alert, actionSheet: work.actionSheet },
}));
vi.mock('expo-router', () => ({ router: { navigate: work.navigate } }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: 'viewer', secretKey: new Uint8Array(32) })),
  getEffectiveRelayUrl: vi.fn(async () => 'https://server.test'),
}));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    resolveChatLinks = work.resolveChatLinks;
    chats = work.chats;
  },
}));
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

it('attaches pasted Beeline links, refuses invalid links clearly, and opens message links in-app', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    work.monolithPhoneOperation.mockClear();
    work.alert.mockClear();
    work.actionSheet.mockClear();
    work.openMessageLink.mockClear();
    work.openExternalUrl.mockClear();
    const messageUrl = `#beeline/beeline/${'a'.repeat(64)}`;
    const item = {
        id: 'task-links',
        roomId: 'room',
        title: 'Task links',
        state: 'backlog',
        entries: [],
        attachments: [
            { id: 'att-1', kind: 'link', name: '#beeline', url: messageUrl, addedBy: { pubkey: 'viewer', kind: 'human', name: 'Ada' }, createdAt: 1 },
        ],
    } as unknown as WorkItemView;
    let tree: any;
    act(() => { tree = create(<WorkItemDetail item={item} workspaceId="ws" viewerId="viewer" desktop={false} now={0} />); });
    try {
        const addBtn = tree.root.find((node: any) => typeof node.type === 'string' && node.props.testID === 'work-attachment-add');
        // Invalid link shows a clear alert and sends no operation.
        work.prompt.mockResolvedValueOnce('not a valid link');
        await act(async () => { addBtn.props.onPress(); });
        const linkOption = work.actionSheet.mock.calls[0]![1].find((o: any) => o.text === 'Link');
        await act(async () => { linkOption.onPress(); });
        expect(work.alert).toHaveBeenCalledWith('Invalid link', expect.any(String));
        expect(work.monolithPhoneOperation).not.toHaveBeenCalled();

        // Beeline message token attaches cleanly.
        work.prompt.mockResolvedValueOnce('¶ada-42');
        await act(async () => { linkOption.onPress(); });
        expect(work.monolithPhoneOperation).toHaveBeenCalledWith('attachToWorkItem', {
            roomId: 'room',
            id: 'task-links',
            attachment: { kind: 'link', name: '¶ada-42', url: '¶ada-42' },
        });

        // Tapping an attached Beeline message link opens it in-app instead of externally.
        const attBtn = tree.root.find((node: any) => node.props['aria-label'] === '#beeline');
        await act(async () => { attBtn.props.onPress(); });
        expect(work.openMessageLink).toHaveBeenCalledWith(messageUrl);
        expect(work.openExternalUrl).not.toHaveBeenCalled();
    } finally { act(() => tree.unmount()); }
});

it('routes saved #beeline/<place> links to threads, chats, and room ids when tapped', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    work.navigate.mockClear();
    work.resolveChatLinks.mockReset();
    work.chats.mockReset();
    work.openExternalUrl.mockClear();
    const roomUuid = '22222222-2222-4222-8222-222222222222';
    const item = {
        id: 'task-places',
        roomId: 'room',
        title: 'Task places',
        state: 'backlog',
        entries: [],
        attachments: [
            { id: 'att-thread', kind: 'link', name: 'Thread place', url: '#beeline/fix-thread', addedBy: { pubkey: 'viewer', kind: 'human', name: 'Ada' }, createdAt: 1 },
            { id: 'att-chat', kind: 'link', name: 'Chat place', url: '#beeline/general', addedBy: { pubkey: 'viewer', kind: 'human', name: 'Ada' }, createdAt: 2 },
            { id: 'att-uuid', kind: 'link', name: 'Room id place', url: `#beeline/${roomUuid}`, addedBy: { pubkey: 'viewer', kind: 'human', name: 'Ada' }, createdAt: 3 },
        ],
    } as unknown as WorkItemView;
    let tree: any;
    act(() => { tree = create(<WorkItemDetail item={item} workspaceId="ws" viewerId="viewer" desktop={false} now={0} />); });
    try {
        // Thread place resolves through resolveChatLinks and navigates to the corner route.
        work.resolveChatLinks.mockResolvedValueOnce({
            links: [{ key: '↳fix-thread', kind: 'thread', roomId: 'thread-1', parentRoomId: 'room', name: 'fix-thread' }],
        });
        await act(async () => {
            tree.root.find((node: any) => node.props['aria-label'] === 'Thread place').props.onPress();
        });
        await vi.waitFor(() => {
            expect(work.resolveChatLinks).toHaveBeenCalledWith('room', ['↳fix-thread']);
            expect(work.navigate).toHaveBeenCalledWith({
                pathname: '/beeline/chat/[channelId]',
                params: { channelId: 'thread-1', parent: 'room', title: 'fix-thread' },
            });
        });

        // Chat place falls back to the workspace chat list and navigates to the chat room.
        work.resolveChatLinks.mockResolvedValueOnce({ links: [] });
        work.chats.mockResolvedValueOnce({
            chats: [{ room: { id: 'chat-general', name: 'general' } }],
        });
        await act(async () => {
            tree.root.find((node: any) => node.props['aria-label'] === 'Chat place').props.onPress();
        });
        await vi.waitFor(() => {
            expect(work.navigate).toHaveBeenCalledWith({
                pathname: '/beeline/chat/[channelId]',
                params: { channelId: 'chat-general', communityId: 'ws' },
            });
        });

        // Direct room UUID navigates straight to the room.
        await act(async () => {
            tree.root.find((node: any) => node.props['aria-label'] === 'Room id place').props.onPress();
        });
        await vi.waitFor(() => {
            expect(work.navigate).toHaveBeenCalledWith({
                pathname: '/beeline/chat/[channelId]',
                params: { channelId: roomUuid, communityId: 'ws' },
            });
        });
        expect(work.openExternalUrl).not.toHaveBeenCalled();
    } finally { act(() => tree.unmount()); }
});

import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('tamagui', async () => {
    const hosts = (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts();
    const R = await import('react');
    // The shared hosts have no Switch.Thumb; add it here.
    const Switch = Object.assign((props: any) => R.createElement('Switch', props, props.children),
        { Thumb: (props: any) => R.createElement('Switch.Thumb', props) });
    return { ...hosts, Switch };
});
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('@/buzz/latency-route-hook', () => ({ useLatencyRouteFrame: () => undefined }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('expo-router', () => ({ router }));
const panel = vi.hoisted(() => ({ openPlace: vi.fn(), closePanel: vi.fn() }));
vi.mock('@/ui/shell/panel', () => panel);
const operation = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: operation }));
const leave = vi.hoisted(() => vi.fn(async (_title: string, _deletes: boolean, run: (confirm: boolean) => Promise<unknown>) => { await run(false); return true; }));
vi.mock('@/buzz/room-leave', () => ({ leaveRoomWithConfirmation: leave }));
const modal = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock('@/modal', () => ({ Modal: modal }));
vi.mock('@/buzz/corner-navigation', () => ({ cornerHref: (id: string, parent: string, title: string) => ({ pathname: 'corner', params: { id, parent, title } }) }));
const data = vi.hoisted(() => ({ room: null as any, archived: [] as any[] }));
vi.mock('@/ui/screens/members/use-room-view', () => ({ useRoomView: () => ({ room: data.room, error: null, refresh: vi.fn() }) }));
vi.mock('@/ui/screens/people/use-workspace-roster', () => ({ useWorkspaceRoster: () => ({ surface: { workspace: { name: 'Beeline Work' } } }) }));
vi.mock('@/buzz/scheduled-work', () => ({
    useScheduledWork: () => ({ work: null }),
    scheduleTitle: () => '', scheduleTrigger: () => '', subscriptionTitle: () => '', subscriptionWhen: () => '',
}));
const loadArchived = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/buzz/use-room-corners', () => ({ useRoomCorners: () => ({ record: { archived: { corners: data.archived } }, loadArchived }) }));

import { ChatInfoScreen } from './ChatInfoScreen';

const ROOM = '22222222-2222-4222-8222-222222222222';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const CORNER = '33333333-3333-4333-8333-333333333333';
const flat = (tree: any) => tree.root.findAll((node: any) => node.type === 'Text').map((node: any) => node.props.children)
    .flat(3).filter((value: unknown) => typeof value === 'string').join('|');
const pressable = (tree: any, testID: string) => tree.root.find((node: any) => node.type === 'ListItem' && node.props.testID === testID);

function render() {
    let tree: any;
    act(() => { tree = create(<ChatInfoScreen roomId={ROOM} close={vi.fn()} />); });
    return tree;
}

beforeEach(() => {
    vi.clearAllMocks();
    data.room = {
        room: { id: ROOM, workspaceId: WORKSPACE, name: 'beeline', visibility: 'public' },
        members: [{ identity: { pubkey: 'a', kind: 'human', name: 'a' }, role: 'owner' }, { identity: { pubkey: 'b', kind: 'agent', name: 'b' }, role: 'member' }],
        viewer: { permissions: { manage: true, send: true } },
    };
    data.archived = [{ corner: { id: CORNER, name: 'agent-identity-tiles' }, closedAt: undefined }];
});

describe('Chat info', () => {
    it('says public or private, counts members and opens Members', () => {
        const tree = render();
        expect(flat(tree)).toContain('Public · anyone in Beeline Work can join · 2 members');
        act(() => { pressable(tree, 'chat-members').props.onPress(); });
        expect(panel.openPlace).toHaveBeenCalledWith({ kind: 'members', roomId: ROOM }, false);
    });

    it('lists finished threads (read on open) and opens one', () => {
        const tree = render();
        expect(loadArchived).toHaveBeenCalledWith(false);
        expect(flat(tree)).toContain('Finished threads · 1');
        act(() => { pressable(tree, `finished-${CORNER}`).props.onPress(); });
        expect(router.push).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ id: CORNER, parent: ROOM }) }));
    });

    it("leaves with today's confirmation and returns to Chats", async () => {
        const tree = render();
        await act(async () => { await pressable(tree, 'leave-chat').props.onPress(); });
        expect(leave).toHaveBeenCalledTimes(1);
        expect(operation).toHaveBeenCalledWith('leaveRoom', { roomId: ROOM });
        expect(panel.closePanel).toHaveBeenCalled();
        expect(router.replace).toHaveBeenCalledWith({ pathname: '/beeline/channels', params: { communityId: WORKSPACE } });
    });

    it('deletes only with manage authority, after confirming', async () => {
        let tree = render();
        await act(async () => { await pressable(tree, 'delete-chat').props.onPress(); });
        expect(modal.confirm).toHaveBeenCalledTimes(1);
        expect(operation).toHaveBeenCalledWith('deleteRoom', { roomId: ROOM });
        data.room = { ...data.room, viewer: { permissions: { manage: false, send: true } } };
        tree = render();
        expect(tree.root.findAll((node: any) => node.type === 'ListItem' && node.props.testID === 'delete-chat')).toHaveLength(0);
    });

    it('has no Workflows section', () => {
        expect(flat(render())).not.toMatch(/Workflows/);
    });
});

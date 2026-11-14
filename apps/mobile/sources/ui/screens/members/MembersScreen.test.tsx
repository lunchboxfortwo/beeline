import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('tamagui', async () => {
    const hosts = (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts();
    const R = await import('react');
    const Checkbox = Object.assign((props: any) => R.createElement('Checkbox', props, props.children),
        { Indicator: (props: any) => R.createElement('Checkbox.Indicator', props, props.children) });
    return { ...hosts, Checkbox };
});
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: (props: Record<string, unknown>) => React.createElement('IdentityMark', props) }));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@/buzz/latency-route-hook', () => ({ useLatencyRouteFrame: () => undefined }));
const panel = vi.hoisted(() => ({ openPlace: vi.fn() }));
vi.mock('@/ui/shell/panel', () => panel);
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: vi.fn() }));
vi.mock('@/ui/screens/people/InvitePeopleSheet', () => ({ InvitePeopleSheet: (props: Record<string, unknown>) => React.createElement('InvitePeopleSheet', props) }));
const data = vi.hoisted(() => ({ room: null as any, roster: null as any, records: new Map<string, any>() }));
vi.mock('./use-room-view', () => ({ useRoomView: () => ({ room: data.room, viewerPubkey: 'a'.repeat(64), error: null, refresh: vi.fn() }) }));
vi.mock('@/ui/screens/people/use-workspace-roster', () => ({ useWorkspaceRoster: () => data.roster }));
vi.mock('@/buzz/workspace-records', () => ({ workspaceRecord: (_scope: unknown, id: string) => data.records.get(id) }));

import { MembersScreen } from './MembersScreen';

const VIEWER = 'a'.repeat(64);
const ADMIN = 'b'.repeat(64);
const ALAN = 'c'.repeat(64);
const JIMMY = 'd'.repeat(64);
const RUBY = 'e'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const person = (pubkey: string, handle: string, role: string) => ({ identity: { pubkey, kind: 'human', name: handle, handle }, role });
const agent = (pubkey: string, handle: string, model?: string) => ({ identity: { pubkey, kind: 'agent', name: handle, handle }, role: 'member', ...(model ? { model } : {}) });

const text = (tree: any) => tree.root.findAll((node: any) => node.type === 'Text').map((node: any) => node.props.children);
const flat = (tree: any) => text(tree).flat(3).filter((value: unknown) => typeof value === 'string').join('|');

beforeEach(() => {
    panel.openPlace.mockClear();
    data.records.clear();
    data.room = {
        room: { id: ROOM, workspaceId: WORKSPACE, name: 'beeline', visibility: 'public', reviewerAgentId: JIMMY },
        members: [person(VIEWER, 'lunchboxfortwo', 'owner'), person(ADMIN, 'bananaman614305', 'admin'), agent(ALAN, 'alan'), agent(JIMMY, 'jimmy')],
        viewer: { permissions: { manage: true, send: true } },
    };
    data.roster = {
        surface: { workspace: { name: 'Beeline Work' }, viewer: { permissions: { manage: true } } },
        scope: 'scope', agents: [agent(ALAN, 'alan'), agent(JIMMY, 'jimmy'), agent(RUBY, 'ruby')],
    };
    data.records.set(JIMMY, {
        ...agent(JIMMY, 'jimmy'), owner: { pubkey: ADMIN, kind: 'human', name: 'b', handle: 'bananaman614305' },
        usage: { updatedAt: 1, windows: [{ rateLimitType: 'five_hour', status: 'allowed', utilization: 0.92, updatedAt: 1 }] },
    });
});

describe('chat Members', () => {
    it('has exactly two sections, People and Agents, each with its own +, and no visibility preamble', () => {
        let tree: any;
        act(() => { tree = create(<MembersScreen roomId={ROOM} close={vi.fn()} />); });
        const all = flat(tree);
        expect(String(all)).not.toMatch(/can join it/);
        expect(all).toContain('People · 2');
        expect(all).toContain('Agents · 2');
        expect(all).toContain('Owner');
        expect(all).toContain('Reviewer');
        expect(all).toContain('8% of limit left');
        expect(tree.root.findAll((node: any) => node.type === 'Button' && ['add-people', 'add-agents'].includes(node.props.testID))).toHaveLength(2);
    });

    it('opens profiles from rows, not for the viewer', () => {
        let tree: any;
        act(() => { tree = create(<MembersScreen roomId={ROOM} close={vi.fn()} />); });
        expect(tree.root.findAll((node: any) => node.type === 'ListItem' && node.props.testID === `member-${VIEWER}`)).toHaveLength(0);
        act(() => { tree.root.find((node: any) => node.type === 'ListItem' && node.props.testID === `member-${ADMIN}`).props.onPress(); });
        expect(panel.openPlace).toHaveBeenLastCalledWith({ kind: 'person', memberId: ADMIN, workspaceId: WORKSPACE }, false);
        act(() => { tree.root.find((node: any) => node.type === 'ListItem' && node.props.testID === `member-${ALAN}`).props.onPress(); });
        expect(panel.openPlace).toHaveBeenLastCalledWith({ kind: 'agent', agentId: ALAN, workspaceId: WORKSPACE }, false);
    });

    it('offers only the workspace agents not in the chat, and no + without authority', () => {
        let tree: any;
        act(() => { tree = create(<MembersScreen roomId={ROOM} close={vi.fn()} />); });
        // Sheet bodies mount when opened.
        act(() => { tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'add-agents').props.onPress(); });
        const sheet = tree.root.find((node: any) => node.props.testID === 'sheet-add-agent-member' && typeof node.type === 'string');
        expect(sheet).toBeDefined();
        expect(tree.root.findAll((node: any) => typeof node.props.testID === 'string' && node.props.testID.startsWith('pick-') && node.type === 'ListItem')
            .map((node: any) => node.props.testID)).toEqual([`pick-${RUBY}`]);
        data.room = { ...data.room, viewer: { permissions: { manage: false, send: true } } };
        data.roster = { ...data.roster, surface: { ...data.roster.surface, viewer: { permissions: { manage: false } } } };
        act(() => { tree = create(<MembersScreen roomId={ROOM} close={vi.fn()} />); });
        expect(tree.root.findAll((node: any) => node.type === 'Button' && ['add-people', 'add-agents'].includes(node.props.testID))).toHaveLength(0);
    });
});

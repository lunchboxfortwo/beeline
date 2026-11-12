import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('tamagui', async () => {
    const hosts = (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts();
    const R = await import('react');
    // The shared hosts have no Checkbox.Indicator; add it here.
    const Checkbox = Object.assign((props: any) => R.createElement('Checkbox', props, props.children),
        { Indicator: (props: any) => R.createElement('Checkbox.Indicator', props, props.children) });
    return { ...hosts, Checkbox };
});
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: (props: Record<string, unknown>) => React.createElement('IdentityMark', props) }));
const operation = vi.hoisted(() => vi.fn());
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: operation }));

import { AddChatAgentsSheet, addLabel } from './AddChatAgentsSheet';
import type { PeopleRow } from '@/ui/screens/people/people-rows';

const ROOM = '22222222-2222-4222-8222-222222222222';
const row = (id: string, handle: string): PeopleRow => ({
    id, kind: 'agent', identity: { pubkey: id, kind: 'agent', name: handle, handle }, handle: `@${handle}`, detail: 'Yours · DeepSeek V4.1 Flash',
});
const text = (tree: any) => tree.root.findAll((node: any) => node.type === 'Text').map((node: any) => node.props.children);
const primary = (tree: any) => tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'add-agents-confirm');

function render(candidates: PeopleRow[], onAdded = vi.fn(), close = vi.fn()) {
    let tree: any;
    act(() => {
        tree = create(<AddChatAgentsSheet open close={close} roomId={ROOM} roomTag="#beeline" workspaceName="Beeline Work" candidates={candidates} onAdded={onAdded} />);
    });
    return tree;
}

beforeEach(() => operation.mockReset());

describe('Agents + in a chat', () => {
    it('lists only the candidates, ticks them, and adds them in one addRoomMember', async () => {
        const onAdded = vi.fn();
        const close = vi.fn();
        operation.mockResolvedValueOnce({ joined: true });
        const tree = render([row('a'.repeat(64), 'beebee'), row('b'.repeat(64), 'luna')], onAdded, close);
        expect(text(tree)).toContain('Agents in Beeline Work that are not in #beeline yet.');
        expect(primary(tree).props.disabled).toBe(true);
        expect(primary(tree).props['aria-label']).toBe('Choose agents to add');
        await act(async () => { tree.root.find((node: any) => node.props.testID === `pick-${'a'.repeat(64)}` && node.type === 'ListItem').props.onPress(); });
        await act(async () => { tree.root.find((node: any) => node.props.testID === `pick-${'b'.repeat(64)}` && node.type === 'ListItem').props.onPress(); });
        expect(primary(tree).props['aria-label']).toBe('Add 2 agents');
        await act(async () => { await primary(tree).props.onPress(); });
        expect(operation).toHaveBeenCalledWith('addRoomMember', { roomId: ROOM, memberIds: ['a'.repeat(64), 'b'.repeat(64)] });
        expect(onAdded).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('says so and points to People when every agent is already in', () => {
        const tree = render([]);
        expect(text(tree)).toContain('Every Beeline Work agent is already in #beeline. To invite an outside agent or create one, use People.');
        expect(tree.root.findAll((node: any) => node.props.testID === 'add-agents-confirm')).toHaveLength(0);
    });

    it('counts the add action', () => {
        expect(addLabel(0)).toBe('Choose agents to add');
        expect(addLabel(1)).toBe('Add 1 agent');
        expect(addLabel(3)).toBe('Add 3 agents');
    });
});


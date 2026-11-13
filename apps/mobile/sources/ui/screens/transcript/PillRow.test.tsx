import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('tamagui', async () => (await import('./grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('./grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: (props: any) => React.createElement('IdentityMark', props) }));

import { PillRow, type PillItem } from './PillRow';
import { SYSTEM_IDENTITY_PUBKEY } from '@/buzz/system-identity';

const items: PillItem[] = [
    { id: 'joined', system: true, from: { kind: 'system', name: 'Beeline' }, to: { kind: 'agent', seed: 'jimmy', name: 'Jimmy' }, time: '09:45', body: React.createElement('Text', { testID: 'joined-body' }, '@jimmy joined') },
    { id: 'a2a', system: false, from: { kind: 'agent', seed: 'alan', name: 'Alan' }, to: { kind: 'agent', seed: 'jimmy', name: 'Jimmy' }, time: '10:00', body: React.createElement('Text', { testID: 'a2a-body' }, '@jimmy Keep it visible') },
];

describe('PillRow', () => {
    it('draws avatar-only pills, from face to face, in one wrapping row', () => {
        let tree: any;
        act(() => { tree = create(<PillRow items={items} />); });
        const row = tree.root.find((node: any) => node.type === 'XStack' && node.props.flexWrap === 'wrap');
        const pills = row.findAll((node: any) => node.type === 'Button');
        expect(pills.map((pill: any) => pill.props.testID)).toEqual(['system-pill', 'agent-pill']);
        expect(pills[0].props.borderRadius).toBe('full');
        expect(pills[0].props.minHeight).toBe(44);
        const faces = pills[0].findAll((node: any) => node.type === 'IdentityMark');
        expect(faces.map((face: any) => face.props.seed)).toEqual([SYSTEM_IDENTITY_PUBKEY, 'jimmy']);
        expect(tree.root.findAllByProps({ testID: 'pill-open' })).toHaveLength(0);
    });

    it('opens the tapped message under the row and closes it on a second tap', () => {
        let tree: any;
        act(() => { tree = create(<PillRow items={items} />); });
        const pill = () => tree.root.find((node: any) => node.type === 'Button' && node.props.testID === 'agent-pill');
        expect(pill().props['aria-label']).toBe('Read message from Alan → Jimmy, 10:00');
        act(() => pill().props.onPress());
        const open = tree.root.find((node: any) => node.type === 'YStack' && node.props.testID === 'pill-open');
        expect(open.findByProps({ testID: 'a2a-body' }).props.children).toBe('@jimmy Keep it visible');
        expect(open.find((node: any) => node.type === 'Text' && node.props.color === 'secondary').props.children).toBe('Alan → Jimmy · 10:00');
        expect(pill().props['aria-expanded']).toBe(true);
        act(() => pill().props.onPress());
        expect(tree.root.findAll((node: any) => node.type === 'YStack' && node.props.testID === 'pill-open')).toHaveLength(0);
    });
});

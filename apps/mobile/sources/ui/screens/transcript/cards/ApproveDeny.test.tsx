import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('tamagui', async () => (await import('../grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('../grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import { ApproveDeny } from './ApproveDeny';
import { RequestFrame } from './RequestCard';

const buttons = (tree: any) => tree.root.findAll((node: any) => node.type === 'Button');

describe('ApproveDeny', () => {
    it('leads with Approve, then Deny, each naming the request', () => {
        const approve = vi.fn();
        const deny = vi.fn();
        let tree: any;
        act(() => { tree = create(<ApproveDeny title="Add Figma" onApprove={approve} onDeny={deny} />); });
        const [first, second] = buttons(tree);
        expect(first.props['aria-label']).toBe('Approve: Add Figma');
        expect(second.props['aria-label']).toBe('Deny: Add Figma');
        act(() => { first.props.onPress(); });
        act(() => { second.props.onPress(); });
        expect(approve).toHaveBeenCalledTimes(1);
        expect(deny).toHaveBeenCalledTimes(1);
    });

    it('holds both while a decision is sending', () => {
        let tree: any;
        act(() => { tree = create(<ApproveDeny title="Add Figma" busy onApprove={() => undefined} onDeny={() => undefined} />); });
        expect(buttons(tree).every((button: any) => button.props.disabled)).toBe(true);
        expect(tree.root.findAll((node: any) => node.type === 'Spinner')).toHaveLength(1);
    });


    it('draws an agent question in brass on the highlight frame', () => {
        let tree: any;
        act(() => { tree = create(<RequestFrame ask="Approve the header?" testID="req" />); });
        const card = tree.root.find((node: any) => node.type === 'Card');
        expect(card.props.backgroundColor).toBe('highlight');
        const ask = tree.root.find((node: any) => node.type === 'Text' && node.props.children === 'Approve the header?');
        expect(ask.props.color).toBe('needsYou');
        expect(tree.root.findAll((node: any) => node.type === 'Icon.AtSign')).toHaveLength(1);
    });
});

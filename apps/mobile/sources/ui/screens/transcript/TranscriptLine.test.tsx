import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('tamagui', async () => (await import('./grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('./grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/components/buzz/IdentityMark', () => ({ IdentityMark: (props: any) => React.createElement('IdentityMark', props) }));

import { TranscriptLine } from './TranscriptLine';

function render(node: React.ReactElement) {
    let tree: any;
    act(() => { tree = create(node); });
    return tree;
}

describe('TranscriptLine', () => {
    it('opens a sender group with a 28 px face in a 44 px tap target, the name and the time', () => {
        const open = vi.fn();
        const tree = render(
            <TranscriptLine sender={{ name: 'Alan', stamp: '10:15', mark: { seed: 'alan', kind: 'agent', alive: true }, onOpenProfile: open }}>
                <React.Fragment>body</React.Fragment>
            </TranscriptLine>,
        );
        const target = tree.root.findByProps({ testID: 'chat-byline-profile' });
        expect(target.props.width).toBe(44);
        expect(target.props.minHeight).toBe(44);
        expect(target.props['aria-label']).toBe('Open Alan profile');
        expect(tree.root.findByProps({ testID: 'chat-byline-mark' }).props).toEqual(
            expect.objectContaining({ kind: 'agent', seed: 'alan', size: 28, alive: true }));
        expect(tree.root.findByProps({ testID: 'chat-byline-name' }).props.children).toBe('Alan');
        const stamp = tree.root.findByProps({ testID: 'chat-byline-stamp' });
        expect(stamp.props.children).toBe('10:15');
        expect(stamp.props.v).toBe('meta');
        act(() => target.props.onPress());
        expect(open).toHaveBeenCalledTimes(1);
    });

    it('sets a follow-up in the same column with no face and no name', () => {
        const tree = render(<TranscriptLine><React.Fragment>more</React.Fragment></TranscriptLine>);
        expect(tree.root.findAllByProps({ testID: 'chat-byline-mark' })).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'chat-byline-name' })).toHaveLength(0);
        expect(tree.root.findAll((node: any) => node.type === 'YStack' && node.props.width === 44)).toHaveLength(1);
    });

    it('shows the bookmark and reported states beside the time', () => {
        const tree = render(<TranscriptLine sender={{ name: 'Dan', stamp: '09:51', bookmarked: true, feedbackReported: true }} />);
        expect(tree.root.findByProps({ testID: 'chat-reported-marker' }).props.children).toBe('Reported');
        expect(tree.root.findAll((node: any) => node.type === 'YStack' && node.props.testID === 'chat-bookmark-marker')).toHaveLength(1);
        expect(tree.root.findAllByProps({ testID: 'chat-byline-profile' })).toHaveLength(0);
    });
});

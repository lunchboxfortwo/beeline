import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/components/buzz/CodeBlock', () => ({ CodeBlock: () => null }));
vi.mock('@/buzz/message-link', () => ({ messageLinkId: () => undefined, openMessageLink: vi.fn() }));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: vi.fn() }));
import { STEP } from '@/ui/grammar';
import { MonoMarkdown } from './MonoMarkdown';

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

it('keeps every nested list level 16 deeper than the one above, past depth two', () => {
    let tree: any;
    act(() => { tree = create(<MonoMarkdown textStyle={{}} markdown={'- one\n  - two\n    - three\n      - four'} />); });
    const indents = tree.root.findAll((node: any) => node.type === 'YStack' && node.props.paddingLeft !== undefined)
        .map((node: any) => node.props.paddingLeft);
    expect(indents).toEqual([0, 1, 2, 3].map((depth) => depth * STEP['4']));
});

it('renders plain prose in its paragraph without a redundant styled text span', () => {
    let tree: any;
    act(() => { tree = create(<MonoMarkdown textStyle={{}} markdown="Plain transcript words" />); });
    const texts = tree.root.findAll((node: any) => node.type === 'Text');
    expect(texts).toHaveLength(1);
    expect(texts[0].props.children).toBeDefined();
    act(() => tree.unmount());
});

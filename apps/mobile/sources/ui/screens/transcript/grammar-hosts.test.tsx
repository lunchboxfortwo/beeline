import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ useWindowDimensions: () => ({ height: 844, width: 390 }) }));
vi.mock('tamagui', async () => (await import('./grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('./grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import { Btn, Glyph, T } from '@/ui/grammar';
import { Check } from 'lucide-react-native';

describe('grammar hosts', () => {
    it('renders grammar primitives as named hosts', () => {
        let tree: any;
        act(() => {
            tree = create(<Btn kind="primary" label="Approve" onPress={() => undefined}><Glyph icon={Check} /><T>Approve</T></Btn>);
        });
        const button = tree.root.find((node: any) => node.type === 'Button');
        expect(button.props['aria-label']).toBe('Approve');
        expect(tree.root.find((node: any) => node.type === 'Text').props.children).toBe('Approve');
        expect(tree.root.findAll((node: any) => node.type === 'Icon.Check').length).toBe(1);
    });
});

import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const dismiss = vi.hoisted(() => vi.fn());
vi.mock('@/ui/lower-keyboard', () => ({ lowerKeyboard: dismiss }));
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import { SheetFrame } from './grammar';

describe('sheet frame', () => {
    it('lowers the keyboard as it opens, so the sheet is never drawn under it', () => {
        let tree: any;
        act(() => { tree = create(<SheetFrame open={false} close={() => undefined} title="Attach"><></></SheetFrame>); });
        expect(dismiss).not.toHaveBeenCalled();
        act(() => { tree.update(<SheetFrame open close={() => undefined} title="Attach"><></></SheetFrame>); });
        expect(dismiss).toHaveBeenCalledTimes(1);
    });
});

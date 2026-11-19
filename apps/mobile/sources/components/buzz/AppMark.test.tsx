import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('react-native-svg', () => ({ default: 'Svg', Circle: 'Circle', Ellipse: 'Ellipse', Path: 'Path' }));
vi.mock('@/ui/grammar', () => ({ T: 'T' }));

import { AppMark } from './AppMark';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Android F07/F08: a server logo still loading kept an empty plate; on web the
// image never loaded at all because Tamagui's web Image reads only `src`.
it('passes the logo as src and keeps the fallback until the logo has loaded', () => {
    let tree: ReturnType<typeof create>;
    const uri = 'https://server.example/v1/company-logos/askul.co.jp';
    act(() => { tree = create(<AppMark name="ASKUL" mark={{ kind: 'image', uri, plate: 'light' }} testID="mark" />); });
    const image = tree!.root.findByProps({ testID: 'mark-icon' });
    expect(image.props.src).toBe(uri);
    expect(tree!.root.findAllByType('Svg' as never)).toHaveLength(1);
    act(() => image.props.onLoad());
    expect(tree!.root.findAllByType('Svg' as never)).toHaveLength(0);
});

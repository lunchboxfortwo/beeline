import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('./HullDialog', () => ({ HullDialog: (props: any) => React.createElement('HullDialog', props) }));
import { ForwardCornerSheet } from './ForwardCornerSheet';

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

it('words the swipe prompt as a new thread, since the app has no corners', () => {
    let tree: any;
    act(() => { tree = create(<ForwardCornerSheet visible onClose={vi.fn()} onOpen={vi.fn()} />); });
    const dialog = tree.root.find((node: any) => node.type === 'HullDialog').props;
    const words = [dialog.title, dialog.body, dialog.accessibilityLabel, ...dialog.actions.map((a: any) => a.label)];
    expect(dialog.title).toBe('Begin a new thread');
    expect(dialog.actions.map((a: any) => a.label)).toEqual(['Cancel', 'Open thread']);
    expect(words.join(' ')).not.toMatch(/corner/i);
});

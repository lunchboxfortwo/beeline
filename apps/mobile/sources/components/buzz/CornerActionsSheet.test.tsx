import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('tamagui', () => ({
  ListItem: 'ListItem', Separator: 'Separator', XStack: 'XStack', YStack: 'YStack',
  Switch: Object.assign((props: any) => React.createElement('Switch', props, props.children), { Thumb: 'Thumb' }),
}));
vi.mock('lucide-react-native', () => ({ Archive: 'Archive', Lock: 'Lock' }));
vi.mock('@/ui/grammar', () => ({
  Btn: 'Btn', Copy: 'Copy', Glyph: 'Glyph', T: 'T', HEIGHT: { primary: 48, sheetRow: 56 },
  SheetFrame: (props: any) => (props.open ? React.createElement('SheetFrame', props, props.children) : null),
}));
import { CornerActionsSheet } from './CornerActionsSheet';

const byTestID = (tree: any, testID: string) => tree.root.find((node: any) => node.props.testID === testID && typeof node.type === 'string');
const flush = () => act(async () => { await Promise.resolve(); });

function props(overrides: Partial<React.ComponentProps<typeof CornerActionsSheet>> = {}) {
  return {
    visible: true, title: 'Reconnect keeps place', locked: false, connected: true,
    onClose: vi.fn(), closeCorner: vi.fn(async () => undefined), setLocked: vi.fn(async () => undefined),
    onClosed: vi.fn(), onSaved: vi.fn(), onError: vi.fn(), ...overrides,
  };
}

beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

it('locks the corner from the server value, then reports the save', async () => {
  const p = props();
  let tree: any;
  act(() => { tree = create(<CornerActionsSheet {...p} />); });
  expect(byTestID(tree, 'lock-corner-switch').props.checked).toBe(false);
  act(() => byTestID(tree, 'lock-corner-action').props.onPress());
  await flush();
  expect(p.setLocked).toHaveBeenCalledWith(true);
  expect(p.onSaved).toHaveBeenCalledTimes(1);
  act(() => tree.unmount());
});

it('closes the corner once, even when pressed twice, then leaves', async () => {
  let finish!: () => void;
  const p = props({ closeCorner: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) });
  let tree: any;
  act(() => { tree = create(<CornerActionsSheet {...p} />); });
  act(() => byTestID(tree, 'close-corner-action').props.onPress());
  act(() => byTestID(tree, 'close-corner-action').props.onPress());
  expect(p.closeCorner).toHaveBeenCalledTimes(1);
  expect(byTestID(tree, 'close-corner-action').findByType('T').props.children).toBe('Closing thread…');
  await act(async () => { finish(); await Promise.resolve(); });
  expect(p.onClosed).toHaveBeenCalledTimes(1);
  act(() => tree.unmount());
});

it('cannot change the lock while disconnected, and Cancel closes the sheet', () => {
  const p = props({ connected: false });
  let tree: any;
  act(() => { tree = create(<CornerActionsSheet {...p} />); });
  expect(byTestID(tree, 'lock-corner-action').props.disabled).toBe(true);
  act(() => byTestID(tree, 'corner-actions-close').props.onPress());
  expect(p.onClose).toHaveBeenCalledTimes(1);
  act(() => tree.unmount());
});

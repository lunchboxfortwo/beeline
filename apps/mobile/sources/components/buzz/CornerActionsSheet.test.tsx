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
  useTextSize: () => 'medium',
  typeStyle: (v: string) => ({ lineHeight: v === 'heading' ? 23 : 23 }),
  SheetFrame: (props: any) => (props.open ? React.createElement('SheetFrame', props, props.children) : null),
}));
import { CornerActionsSheet } from './CornerActionsSheet';

const byTestID = (tree: any, testID: string) => tree.root.find((node: any) => node.props.testID === testID && typeof node.type === 'string');
const flush = () => act(async () => { await Promise.resolve(); });

function props(overrides: Partial<React.ComponentProps<typeof CornerActionsSheet>> = {}) {
  return {
    visible: true, title: 'Reconnect keeps place', locked: false, canManage: false, connected: true,
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

it('offers unlock and Close on a locked thread only to a Workspace owner or admin', async () => {
  const closeRows = (tree: any) => tree.root.findAll((node: any) => node.props.testID === 'close-corner-action' && typeof node.type === 'string');
  let tree: any;
  act(() => { tree = create(<CornerActionsSheet {...props({ locked: true })} />); });
  expect(closeRows(tree)).toHaveLength(0);
  expect(tree.root.findAllByProps({ testID: 'lock-corner-action' })).toHaveLength(0);
  expect(tree.root.findAllByProps({ testID: 'lock-corner-switch' })).toHaveLength(0);
  const manager = props({ locked: true, canManage: true });
  act(() => tree.update(<CornerActionsSheet {...manager} />));
  expect(byTestID(tree, 'lock-corner-switch').props.checked).toBe(true);
  act(() => byTestID(tree, 'lock-corner-switch').props.onCheckedChange(false));
  await flush();
  expect(manager.setLocked).toHaveBeenCalledWith(false);
  expect(closeRows(tree)).toHaveLength(1);
  act(() => tree.unmount());
});

it('aligns Lock and Close row icons and switch to computed line-1 slots without paddingTop hacks', () => {
  let tree: any;
  act(() => { tree = create(<CornerActionsSheet {...props()} />); });
  const lockRow = byTestID(tree, 'lock-corner-action');
  const closeRow = byTestID(tree, 'close-corner-action');
  expect(lockRow.findAll((n: any) => n.props?.paddingTop === '0.5')).toHaveLength(0);
  expect(closeRow.findAll((n: any) => n.props?.paddingTop === '0.5')).toHaveLength(0);
  const lockSlots = lockRow.findAll((n: any) => n.type === 'YStack' && n.props.height === 28 && n.props.justifyContent === 'center');
  expect(lockSlots).toHaveLength(2);
  expect(lockRow.findAll((n: any) => n.type === 'YStack' && n.props.width === 0 && n.props.height === 28)).toHaveLength(1);
  const closeSlots = closeRow.findAll((n: any) => n.type === 'YStack' && n.props.height === 23 && n.props.justifyContent === 'center');
  expect(closeSlots).toHaveLength(1);
  act(() => tree.unmount());
});

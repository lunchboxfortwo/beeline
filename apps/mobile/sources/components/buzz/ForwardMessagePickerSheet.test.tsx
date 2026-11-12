import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
  return { ScrollView: host('ScrollView'), Text: host('Text'), View: host('View') };
});
vi.mock('tamagui', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).tamaguiHosts());
vi.mock('lucide-react-native', async () => (await import('@/ui/screens/transcript/grammar-hosts.test-support')).lucideHosts());
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/buzz/use-text-draft', () => ({ useTextDraft: () => ['', vi.fn()] }));
vi.mock('./SurfaceGlyphLoader', () => ({ SurfaceGlyphLoader: () => null }));
vi.mock('@/components/buzz/HullDialog', () => ({ HullDialogInput: () => null }));
vi.mock('@/components/buzz/RoomListSectionHeader', () => ({ RoomListSectionHeader: () => null }));
vi.mock('./HullActionSheet', async () => {
  const React = await import('react');
  return {
    HULL_SHEET_INSET: 16,
    HullActionSheetCancel: () => null,
    // The web modal retains children during its exit animation.
    HullActionSheetModal: (props: any) => React.createElement('Sheet', props, props.children),
    HullActionSheetRow: (props: any) => React.createElement('Row', props, props.metadata),
  };
});
import { ForwardMessagePickerSheet } from './ForwardMessagePickerSheet';

afterEach(() => vi.unstubAllGlobals());

for (const success of [true, false]) it(`accepted=${success} controls feedback before the closing sheet unmounts`, async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  let accept!: (ok: boolean) => void;
  const accepted = new Promise<boolean>(resolve => { accept = resolve; });
  const props = {
    busyRoomId: null, error: null, onClose: vi.fn(), onForward: () => accepted,
    targets: [{ kind: 'room' as const, id: 'target', label: '#target', group: 'rooms' as const }], visible: true,
  };
  let tree: any;
  await act(async () => { tree = create(<ForwardMessagePickerSheet {...props} />); });
  let sending: Promise<void>;
  await act(async () => { sending = tree.root.findByType('Row').props.onPress(); });
  expect(tree.root.findByType('Row').props.metadata).toBeUndefined();
  await act(async () => {
    accept(success);
    await sending!;
  });
  expect(props.onClose).not.toHaveBeenCalled();
  if (!success) {
    expect(tree.root.findByType('Row').props.metadata).toBeUndefined();
    expect(frames).toHaveLength(0);
    await act(async () => { tree.unmount(); });
    return;
  }
  expect(tree.root.findByType('Row').props.metadata).toBe('FORWARDED');
  expect(frames).toHaveLength(0);
  expect(tree.root.findByType('Row').props.disabled).toBe(false);
  expect(tree.root.findByType('Row').props.onPress).toBeUndefined();
  await act(async () => { tree.root.findByProps({ testID: 'forward-accepted-result' }).props.onLayout(); });
  await act(async () => { frames.shift()!(0); });
  expect(props.onClose).not.toHaveBeenCalled();
  await act(async () => { frames.shift()!(16); });
  expect(props.onClose).toHaveBeenCalledOnce();
  await act(async () => {
    tree.update(<ForwardMessagePickerSheet {...props} visible={false} />);
  });
  expect(tree.root.findByType('Sheet').props.visible).toBe(false);
  expect(tree.root.findByType('Row').props.metadata).toBe('FORWARDED');
  await act(async () => { tree.unmount(); });
});

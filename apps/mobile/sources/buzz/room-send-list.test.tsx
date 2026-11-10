import { afterEach, expect, it, vi } from 'vitest';
import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import type { ChatDisplayMessage } from './room-view-presentation';
vi.mock('react-native', () => ({
  FlatList: (props: Record<string, unknown>) => React.createElement('flat-list', props),
  View: (props: Record<string, unknown>) => React.createElement('view', props),
}));
import { RoomSendList, RoomSendPreview } from './room-send-list';

const message = (id: string): ChatDisplayMessage => ({ id, text: 'Complete first frame', timestamp: 1, isUser: true });
afterEach(() => vi.unstubAllGlobals());

it('keeps live-tail arrivals out of native pending-scroll anchoring, preserving history anchors', () => {
  const preview = new RoomSendPreview();
  const anchor = { minIndexForVisible: 1, autoscrollToTopThreshold: 50 };
  const props = { preview, initialNumToRender: 2, renderItem: null, maintainVisibleContentPosition: anchor };
  const first = message('first');
  let renderer!: ReturnType<typeof create>;
  act(() => { renderer = create(<RoomSendList {...props} data={[first]} />); });
  const list = () => renderer.root.findByType('flat-list');
  const instance = list();
  // At offset zero native may emit no scroll event for a prepend. Asking it
  // to preserve an anchor leaves VirtualizedList waiting and freezes its mask.
  expect(list().props.maintainVisibleContentPosition).toBeUndefined();
  act(() => { renderer.update(<RoomSendList {...props} data={[message('draft'), first]} />); });
  act(() => { renderer.update(<RoomSendList {...props} data={[message('settled'), first]} />); });
  expect(list()).toBe(instance);
  expect(list().props.maintainVisibleContentPosition).toBeUndefined();
  const scroll = (y: number) => act(() => list().props.onScroll({
    nativeEvent: { contentOffset: { y } },
  }));
  scroll(200);
  expect(list().props.maintainVisibleContentPosition).toBe(anchor);
  act(() => { renderer.update(<RoomSendList {...props} data={[message('next'), message('settled'), first]} />); });
  expect(list().props.maintainVisibleContentPosition).toBe(anchor);
  scroll(0);
  expect(list().props.maintainVisibleContentPosition).toBeUndefined();
  // Offset zero in a detached source window belongs to the jump target.
  const detachedAnchor = { minIndexForVisible: 1 };
  act(() => { renderer.update(<RoomSendList {...props} maintainVisibleContentPosition={detachedAnchor} data={[first]} />); });
  expect(list().props.maintainVisibleContentPosition).toBe(detachedAnchor);
  act(() => renderer.unmount());
});

it('releases preparation after layout and a painted host frame, without a timer', async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  const preview = new RoomSendPreview();
  let completed = false;
  const painted = preview.show(message('pending')).then(() => { completed = true; });
  expect(preview.snapshot()?.message.text).toBe('Complete first frame');
  expect(frames).toHaveLength(0);
  preview.laidOut('pending');
  frames.shift()!(0);
  await Promise.resolve();
  expect(completed).toBe(false);
  frames.shift()!(16);
  await painted;
  expect(preview.snapshot()?.painted).toBe(true);
});

it('settles a departing visit and keeps its delayed layout out of the next preview', async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  const preview = new RoomSendPreview();
  const first = preview.show(message('first'));
  preview.laidOut('first');
  preview.dispose();
  await first;
  preview.activate();
  const second = preview.show(message('second'));
  frames.shift()!(0);
  frames.shift()!(16);
  await Promise.resolve();
  expect(preview.snapshot()?.message.id).toBe('second');
  expect(preview.snapshot()?.painted).toBe(false);
  preview.remove('second');
  await second;
});

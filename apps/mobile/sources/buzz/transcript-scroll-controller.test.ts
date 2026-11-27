import { expect, it, vi } from 'vitest';
import { createTranscriptScrollController, desktopTranscriptList, phoneTranscriptList, type TranscriptScrollList } from './transcript-scroll-controller';

function transcript(step = 1, adapter?: TranscriptScrollList) {
  const rows = ['live', 'unread', 'read'].map(id => ({ id }));
  if (step < 0) rows.reverse();
  const list = { ...adapter, toRow: vi.fn<TranscriptScrollList['toRow']>(adapter?.toRow ?? (() => true)),
    toNewest: vi.fn(), toOffset: vi.fn(), toEstimatedRow: vi.fn(), shiftBy: vi.fn() };
  const frames: Array<() => void> = [];
  const controller = createTranscriptScrollController({
    list: () => list, rows: () => rows, precedingRowStep: () => step,
    rowIndex: (target, candidates) => candidates.findIndex(row => row.id === target.messageId),
    schedule: work => frames.push(work), holdsLanding: () => true,
  });
  return { rows, list, controller, flush: () => frames.splice(0).forEach(work => work()) };
}

it.each([1, -1])('aligns the preceding read row before settling a visible unread boundary (%i)', step => {
  const { controller, rows, list, flush } = transcript(step);
  controller.observeVisibleRows(rows);
  controller.request({ kind: 'firstUnread', messageId: 'unread' });
  expect(controller.isLanding()).toBe(true);
  expect(controller.isPinnedToTail()).toBe(false);
  flush();
  expect(list.toRow).toHaveBeenCalledWith(1 + step, 'read', 'top');
  expect(controller.isLanding()).toBe(true);
  controller.observeVisibleRows(rows);
  controller.observeTailPinned(true);
  controller.follow();
  flush();
  expect(controller.isHoldingLanding()).toBe(true);
  expect(list.toNewest).not.toHaveBeenCalled();
});

function phone(viewport: number, content: number, offset: { current: number },
  layouts: Record<string, { y: number; height: number }>) {
  const native = { scrollToIndex: vi.fn(), scrollToOffset: vi.fn() };
  return phoneTranscriptList(() => native, id => Boolean(layouts[id]), () => offset, {
    row: id => layouts[id], viewportHeight: () => viewport, contentHeight: () => content,
  });
}

it('holds a short unread transcript when a clamped scroll emits no visibility change', () => {
  const adapter = phone(600, 300, { current: 0 }, {
    unread: { y: 100, height: 100 }, read: { y: 200, height: 100 },
  });
  const { controller, rows, list, flush } = transcript(1, adapter);
  controller.observeVisibleRows(rows);
  controller.request({ kind: 'firstUnread', messageId: 'unread' });
  flush();
  expect(controller.isLanding()).toBe(true);
  flush();
  expect(controller.isLanding()).toBe(false);
  expect(controller.isHoldingLanding()).toBe(true);
  expect(list.toRow).toHaveBeenCalledTimes(1);
});

it('skips a measured viewport-tall context row on the inverted phone list', () => {
  const adapter = phone(600, 1800, { current: 0 }, {
    unread: { y: 650, height: 100 }, read: { y: 750, height: 600 },
  });
  const { controller, rows, list, flush } = transcript(1, adapter);
  controller.request({ kind: 'firstUnread', messageId: 'unread' });
  flush();
  expect(list.toRow.mock.calls).toEqual([[1, 'unread', 'top']]);
  flush();
  expect(controller.isLanding()).toBe(true);
  controller.observeVisibleRows([rows[1]!]);
  expect(controller.isHoldingLanding()).toBe(true);
});

it('uses the clamped top or center target to identify an already aligned phone row', () => {
  const offset = { current: 200 };
  const adapter = phone(600, 1500, offset, { unread: { y: 700, height: 100 } });
  expect(adapter.toRow(1, 'unread', 'top')).toBe('no-op');
  expect(adapter.toRow(1, 'unread', 'center')).toBe(true);
  offset.current = 450;
  expect(adapter.toRow(1, 'unread', 'center')).toBe('no-op');
});

it('waits for delayed native visibility before falling back from a tall context row', () => {
  const offset = { current: 0 };
  const layouts = { read: { y: 560, height: 90 }, unread: { y: 490, height: 70 } };
  const { controller, rows, list, flush } = transcript(1, phone(600, 1800, offset, layouts));
  // Native accepts the command before the JS offset or visible rows change.
  controller.observeVisibleRows(rows);
  controller.request({ kind: 'firstUnread', messageId: 'unread' });
  flush();
  flush();
  expect(controller.isLanding()).toBe(true);
  expect(list.toRow.mock.calls).toEqual([[2, 'read', 'top']]);

  // The context row occupies the entire viewport after its top alignment.
  layouts.read.height = 600;
  offset.current = 560;
  controller.observeVisibleRows([rows[2]!]);
  expect(list.toRow.mock.calls).toEqual([[2, 'read', 'top'], [1, 'unread', 'top']]);
  expect(controller.isLanding()).toBe(true);
  flush();
  expect(controller.isLanding()).toBe(true);
  offset.current = 0;
  controller.observeVisibleRows([rows[1]!]);
  expect(controller.isHoldingLanding()).toBe(true);
  expect(list.toRow).toHaveBeenCalledTimes(2);
});

it('skips the context scroll when desktop measurements put New below the viewport', () => {
  const rows = [{ id: 'read' }, { id: 'unread' }];
  const scrollContext = vi.fn();
  const scrollUnread = vi.fn();
  const list = desktopTranscriptList(
    () => ({ scrollTop: 0, scrollHeight: 1200, clientHeight: 600 }),
    id => id === 'read'
      ? { getBoundingClientRect: () => ({ top: 30 }), scrollIntoView: scrollContext }
      : { getBoundingClientRect: () => ({ top: 630 }), scrollIntoView: scrollUnread },
  );
  const controller = createTranscriptScrollController({
    list: () => list, rows: () => rows, precedingRowStep: () => -1,
    rowIndex: (target, candidates) => candidates.findIndex(row => row.id === target.messageId),
    schedule: work => work(),
  });
  controller.request({ kind: 'firstUnread', messageId: 'unread' });
  expect(scrollContext).not.toHaveBeenCalled();
  expect(scrollUnread).toHaveBeenCalledExactlyOnceWith({ block: 'start', behavior: 'instant' });
  expect(controller.isLanding()).toBe(true);
  controller.observeVisibleRows([rows[1]!]);
  expect(controller.isLanding()).toBe(false);
});

it('compensates streaming growth and collapse only while the live row owns the viewport', () => {
  const { controller, rows, list } = transcript();
  controller.observeVisibleRows(rows.slice(0, 1));
  controller.holdReadingPosition(30, 'live');
  controller.observeTailPinned(false);
  controller.holdReadingPosition(28, 'live');
  controller.holdReadingPosition(-16, 'live');
  controller.observeVisibleRows(rows);
  controller.holdReadingPosition(20, 'live');
  expect(list.shiftBy.mock.calls).toEqual([[28], [-16]]);
});

it('accumulates phone corrections between scroll events and clamps at the tail', () => {
  const offset = { current: 25 };
  const list = { scrollToIndex: vi.fn(), scrollToOffset: vi.fn() };
  const adapter = phoneTranscriptList(() => list, () => true, () => offset);
  for (const delta of [12, 7, -60]) adapter.shiftBy(delta);
  expect(list.scrollToOffset.mock.calls.map(([request]) => request.offset)).toEqual([37, 44, 0]);
});

it('respects an off-tail observation after layout and native momentum', () => {
  const { controller, list, flush } = transcript();
  controller.followAfterLayout();
  flush();
  controller.observeLayout();
  list.toNewest.mockClear();
  controller.observeTailPinned(false);
  controller.momentumStarted();
  controller.momentumEnded();
  expect(controller.isPinnedToTail()).toBe(false);
  expect(list.toNewest).not.toHaveBeenCalled();
});

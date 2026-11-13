import type { ChatDisplayMessage } from './room-view-presentation';
import { scrollBarPosition, scrubDate, type TranscriptScrollMetrics } from './transcript-scrubber';

/** How long the bar stays after the list stops, long enough to grab it. */
export const SCRUBBER_LINGER_MS = 2_000;

export type TranscriptScrubberSnapshot = {
  metrics: TranscriptScrollMetrics | null;
  /** Last position established by meaningful list movement, not row layout. */
  position: number | null;
  /** The day of the oldest message on screen, for the drag bubble. */
  date: string | null;
  /** The list is scrolling or just stopped. */
  visible: boolean;
};

/** The fields of a native scroll event the bar reads. */
type ScrollEventShape = {
  contentOffset: { y: number };
  contentSize: { height: number };
  layoutMeasurement: { height: number };
};

export type TranscriptScrubberStore = ReturnType<typeof createTranscriptScrubberStore>;

/**
 * State for `TranscriptScrubber`, kept outside React state so a scroll frame
 * re-renders only the bar, not the Room screen that feeds it. The Room
 * message store owns one per Room as its `positions`.
 */
export function createTranscriptScrubberStore() {
  let snapshot: TranscriptScrubberSnapshot = { metrics: null, position: null, date: null, visible: false };
  let linger: ReturnType<typeof setTimeout> | null = null;
  let positionedOffset: number | null = null;
  const listeners = new Set<() => void>();
  const update = (next: Partial<TranscriptScrubberSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    listeners.forEach((listener) => listener());
  };
  const reveal = (position?: number) => {
    if (position !== undefined) update({ position });
    if (!snapshot.visible) update({ visible: true });
    if (linger) clearTimeout(linger);
    linger = setTimeout(() => update({ visible: false }), SCRUBBER_LINGER_MS);
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Shows the bar and restarts its fade. */
    reveal,
    observeScroll(event: ScrollEventShape, readerScrolling = true) {
      const metrics = {
        offset: event.contentOffset.y,
        contentHeight: event.contentSize.height,
        viewportHeight: event.layoutMeasurement.height,
      };
      // Native anchoring can change the offset by hundreds of points while
      // keeping the reading row still. Only the controller's reader scroll
      // lifecycle may position or reveal the thumb; every event still refreshes
      // the metrics used when the reader grabs it. Within a gesture, accumulate
      // movement beyond the one-point rounding tolerance.
      const moved = readerScrolling && (positionedOffset === null || Math.abs(metrics.offset - positionedOffset) > 1);
      if (moved || !readerScrolling) positionedOffset = metrics.offset;
      update({
        metrics,
        position: moved ? scrollBarPosition(metrics) : snapshot.position,
      });
      if (moved) reveal();
    },
    /**
     * The list's content grew or shrank without scrolling, as when an older
     * page lands at the top. No scroll event reports that, so the list's
     * content-size callback does.
     */
    observeContentSize(contentHeight: number) {
      const { metrics } = snapshot;
      if (!metrics || metrics.contentHeight === contentHeight) return;
      update({ metrics: { ...metrics, contentHeight } });
    },
    observeVisibleRows(rows: readonly ChatDisplayMessage[]) {
      const date = scrubDate(rows);
      if (date !== snapshot.date) update({ date });
    },
    /** Forgets the last Room's list, so the next Room's bar starts fresh. */
    reset() {
      if (linger) clearTimeout(linger);
      linger = null;
      positionedOffset = null;
      update({ metrics: null, position: null, date: null, visible: false });
    },
    dispose() {
      if (linger) clearTimeout(linger);
      linger = null;
    },
  };
}

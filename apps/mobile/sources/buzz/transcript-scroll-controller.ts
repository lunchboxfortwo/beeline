import { useRef, useState } from 'react';

import { scheduleAnimationFrame } from './host-scheduler';

/**
 * The one owner of transcript list movement. Features ask for a destination
 * and never call a list's scroll methods; `transcript-scroll.boundary.test.ts`
 * fails if any other file does.
 *
 * One request runs at a time. A new request replaces the active one, and a
 * user drag cancels it. A row request stays active across layout and
 * visibility passes until a visibility report shows its row, so a scroll made
 * with stale row measurements is made again on the next pass.
 *
 * - `newest`: the newest end. Runs on the next frame. `untilRowId` keeps it
 *   armed until that row is drawn, then lands once more (a desktop send).
 * - `message`: the row that shows a message, at the top or the center. With
 *   `jump`, a reader reaching for that message (a notification, a quote, a
 *   forward source): the feature may open a store window around it and
 *   flashes it on landing. Without, a row that is already shown (the code
 *   reader's return).
 * - `firstUnread`: the row that holds the unread boundary, with its preceding row at the top
 *   when available. Visibility confirms the scroll.
 * - `offset`: a raw list offset (the scrubber). Runs at once. During
 *   momentum the list may coast past it, so it stays active and runs again
 *   when momentum ends. A drag on the list cancels it.
 *
 * A landed row request the feature holds (`holdsLanding`) keeps its row in
 * place while newer rows grow the list below it (`holdLanding`), and nothing
 * follows the newest end meanwhile. The hold ends with the next request, a
 * drag, a cancel or a reset.
 */
export type TranscriptScrollDestination =
  | { kind: 'newest'; untilRowId?: string }
  | { kind: 'message'; messageId: string; align: TranscriptRowAlign; jump: boolean }
  | { kind: 'firstUnread'; messageId: string }
  | { kind: 'offset'; offset: number };

export type TranscriptRowAlign = 'top' | 'center';

export type TranscriptRowDestination = Extract<
  TranscriptScrollDestination,
  { kind: 'message' | 'firstUnread' }
>;

export type TranscriptScrollCancelReason = 'replaced' | 'drag' | 'cancelled';

/** The calls a platform list answers. Only the adapters below implement it. */
export type TranscriptScrollList = {
  currentOffset?(): number | undefined;
  isRowVisible?(rowId: string): boolean | null;
  contextFitsViewport?(contextRowId: string, unreadRowId: string): boolean;
  toNewest(): void;
  /** False if unreachable, true for a native request, synced after a DOM move,
   * or no-op when the requested alignment cannot move the viewport. */
  toRow(index: number, rowId: string, align: TranscriptRowAlign): boolean | 'no-op' | 'synced';
  /** Scroll near a row the list could not reach, so its neighbours measure. */
  toEstimatedRow(index: number): void;
  toOffset(offset: number): void;
  /** Move by `delta` px to keep a reading row in place. */
  shiftBy(delta: number): void;
};

export type TranscriptScrollRow = { readonly id: string };

export type TranscriptScrollControllerOptions<Row extends TranscriptScrollRow> = {
  list(): TranscriptScrollList | null;
  precedingRowStep?(): number;
  /** Rows in list index order. */
  rows(): readonly Row[];
  /** Index in `rows` of the row that shows the destination, or -1. */
  rowIndex(destination: TranscriptRowDestination, rows: readonly Row[]): number;
  /**
   * Whether a row request may scroll to `index` before its first scroll. Lets
   * a feature fetch a better window first. Later passes always may.
   */
  canScrollTo?(destination: TranscriptRowDestination, index: number): boolean;
  /** A row request cannot scroll yet: the feature reveals or fetches its row. */
  onUnreachable?(destination: TranscriptRowDestination): void;
  /** First successful scroll of a row request. */
  onScrolled?(destination: TranscriptRowDestination, rowId: string): void;
  /** A visibility report shows the row; the request is done. */
  onLanded?(destination: TranscriptRowDestination, rowId: string): void;
  /** Whether a row that lands now stays held in place. */
  holdsLanding?(destination: TranscriptRowDestination): boolean;
  /** The request ended before it landed. */
  onCancelled?(
    destination: TranscriptScrollDestination,
    reason: TranscriptScrollCancelReason,
  ): void;
  schedule?(callback: () => void): void;
};

export type TranscriptScrollController<Row extends TranscriptScrollRow> = {
  request(destination: TranscriptScrollDestination): void;
  /** Follow new content to the newest end, unless a drag, a row request or a held landing owns the list. */
  follow(): void;
  /** Keep a pinned tail through the next native content layout, after React commits growing rows. */
  followAfterLayout(): void;
  /** Enter a live call at its tail unless the reader deliberately chose history. */
  enterCall(): boolean;
  /** Same as `follow`, without waiting a frame (a measured desktop resize). */
  followNow(): void;
  /** Keep a reading row in place while nothing else owns the list. */
  holdReadingPosition(delta: number, onlyVisibleRowId?: string): void;
  /** The content changed: move a held landing to `offset`, where it keeps its place. */
  holdLanding(offset: number): void;
  cancel(): void;
  /** The room changed: drop the request and the visible rows, no callbacks. */
  reset(): void;
  /** Re-attempt the active request after a layout change. */
  observeLayout(): void;
  /** A scroll event delivered the current viewport offset. */
  observeScroll(): void;
  observeVisibleRows(rows: readonly Row[]): void;
  observeTailPinned(pinned: boolean): void;
  /** A touch drag began. Cancels the active request. */
  dragStarted(): void;
  /**
   * Momentum began. After a drag it cancels the active request; a later
   * offset waits for its end. Without one (Android can start momentum after a
   * layout change) it is not the reader, and the request stays.
   */
  momentumStarted(): void;
  /** The finger lifted. With `momentumMayFollow`, wait a frame for momentum to claim it. */
  dragEnded(momentumMayFollow: boolean): void;
  momentumEnded(): void;
  /** A wheel or touch scroll with no drag lifecycle (web). Cancels the active request. */
  userScrolled(): void;
  active(): TranscriptScrollDestination | null;
  /** A row request owns the list. */
  isLanding(): boolean;
  /** A landed row is held in place (`holdsLanding`). */
  isHoldingLanding(): boolean;
  isPinnedToTail(): boolean;
  isUserDragging(): boolean;
};

type Active = {
  readonly destination: TranscriptScrollDestination;
  scrolled: boolean;
  following: boolean;
  verifyScroll?: () => void;
  scrollAttempt: number;
  lastScrollVisibilitySeq: number;
  contextScrolled: boolean;
  skipContextRow: boolean;
};

function isRowDestination(
  destination: TranscriptScrollDestination,
): destination is TranscriptRowDestination {
  return destination.kind === 'message' || destination.kind === 'firstUnread';
}

const defaultSchedule = (callback: () => void) => {
  if (scheduleAnimationFrame(() => callback()) === false) callback();
};

export function createTranscriptScrollController<Row extends TranscriptScrollRow>(
  options: TranscriptScrollControllerOptions<Row>,
): TranscriptScrollController<Row> {
  const schedule = options.schedule ?? defaultSchedule;
  let active: Active | null = null;
  let visibilitySeq = 0;
  let visibleRows: readonly Row[] = [];
  // The rows the last visibility report described. A report about other rows
  // (a window opened since) cannot settle a request.
  let visibleRowsOf: readonly Row[] | null = null;
  let pinned = true;
  let dragging = false;
  let momentum = false;
  let dragSequence = 0;
  // A drag ended with momentum still to come.
  let momentumOwed = false;
  let held = false;
  let readerMoved = false;
  let followPendingLayout = false;

  const end = (reason: TranscriptScrollCancelReason) => {
    followPendingLayout = false;
    held = false;
    const ended = active;
    if (!ended) return;
    active = null;
    options.onCancelled?.(ended.destination, reason);
  };

  const land = (current: Active, rowId: string) => {
    if (active !== current) return;
    active = null;
    const destination = current.destination as TranscriptRowDestination;
    held = options.holdsLanding?.(destination) ?? false;
    options.onLanded?.(destination, rowId);
  };

  /** The visible row that settles a row request, or null. */
  const settledRow = (current: Active): Row | null => {
    const destination = current.destination;
    if (!isRowDestination(destination)) return null;
    if (!current.scrolled || visibilitySeq <= current.lastScrollVisibilitySeq) return null;
    if (visibleRowsOf !== options.rows()) return null;
    const index = options.rowIndex(destination, visibleRows);
    return index >= 0 ? visibleRows[index]! : null;
  };

  const attempt = (current: Active) => {
    if (active !== current) return;
    const list = options.list();
    const destination = current.destination;
    if (destination.kind === 'newest') {
      const waiting = Boolean(
        destination.untilRowId && !options.rows().some((row) => row.id === destination.untilRowId),
      );
      if (current.scrolled && waiting) return;
      current.scrolled = true;
      if (!waiting) active = null;
      list?.toNewest();
      pinned = true;
      return;
    }
    if (destination.kind === 'offset') {
      if (!momentum) active = null;
      list?.toOffset(destination.offset);
      return;
    }
    const settled = settledRow(current);
    if (settled) {
      land(current, settled.id);
      return;
    }
    const rows = options.rows();
    const index = options.rowIndex(destination, rows);
    if (
      index < 0 ||
      !list ||
      (!current.scrolled && options.canScrollTo && !options.canScrollTo(destination, index))
    ) {
      options.onUnreachable?.(destination);
      return;
    }
    const rowId = rows[index]!.id;
    const align = destination.kind === 'message' ? destination.align : 'top';
    const contextIndex = index + (options.precedingRowStep?.() ?? 0);
    const context = rows[contextIndex];
    let target = index;
    if (destination.kind === 'firstUnread' && context && contextIndex !== index && !current.skipContextRow) {
      // A fresh report that could not settle the boundary means the context
      // hid it. Align the unread row itself for the rest of this request.
      if ((current.contextScrolled && visibilitySeq > current.lastScrollVisibilitySeq && visibleRowsOf === rows) ||
          list.contextFitsViewport?.(context.id, rowId) === false) {
        current.skipContextRow = true;
      } else {
        target = contextIndex;
      }
    }
    const scrollVisibilitySeq = visibilitySeq;
    const scrollAttempt = ++current.scrollAttempt;
    current.verifyScroll = undefined;
    const beforeOffset = list.currentOffset?.();
    current.lastScrollVisibilitySeq = scrollVisibilitySeq;
    const result = list.toRow(target, rows[target]!.id, align);
    if (!result) {
      // Scroll near the row so the list draws and measures it. A list that
      // has nothing left to draw sends no later pass by itself, and a row
      // request waiting for one never lands.
      list.toEstimatedRow(target);
      return;
    }
    current.contextScrolled = target !== index;
    if (!current.scrolled) {
      current.scrolled = true;
      options.onScrolled?.(destination, rowId);
    }
    const verify = () => {
      if (active !== current || current.scrollAttempt !== scrollAttempt ||
          visibilitySeq !== scrollVisibilitySeq || rows !== options.rows()) return;
      let visible = list.isRowVisible?.(rowId) ?? null;
      // Only an unchanged viewport can reuse its pre-scroll visibility report.
      if (visible === null && result === 'no-op' && visibleRowsOf === rows) {
        visible = options.rowIndex(destination, visibleRows) >= 0;
      }
      if (visible) land(current, rowId);
      else if (visible === false && current.contextScrolled) {
        current.skipContextRow = true;
        attempt(current);
      }
    };
    current.verifyScroll = () => {
      // A queued native scroll event can still carry the pre-command offset.
      if (result === true && beforeOffset !== undefined && list.currentOffset?.() === beforeOffset) return;
      verify();
    };
    if (result === 'synced') verify();
    else if (result === 'no-op') schedule(verify);
  };

  const request = (destination: TranscriptScrollDestination, following = false) => {
    if (destination.kind === 'message' || destination.kind === 'offset') readerMoved = true;
    end('replaced');
    const current: Active = {
      destination, scrolled: false, following,
      scrollAttempt: 0, lastScrollVisibilitySeq: visibilitySeq, contextScrolled: false, skipContextRow: false,
    };
    active = current;
    if (destination.kind === 'offset') {
      attempt(current);
      return;
    }
    // The viewer asked for the newest end; an arrival in the meantime follows.
    if (destination.kind === 'newest') pinned = true;
    if (isRowDestination(destination)) pinned = false;
    schedule(() => attempt(current));
  };

  const followAllowed = () =>
    !dragging && !held && !(active && isRowDestination(active.destination));

  return {
    request,
    enterCall() {
      if (dragging || (!pinned && readerMoved)) return false;
      request({ kind: 'newest' });
      return true;
    },
    follow() {
      if (!followAllowed()) return;
      if (active?.destination.kind === 'newest') return;
      request({ kind: 'newest' }, true);
    },
    followAfterLayout() {
      // Like follow(), the caller has already decided against the pre-commit
      // tail pin. Native anchoring may have moved it before this effect runs.
      if (!followAllowed()) return;
      if (active?.destination.kind !== 'newest') request({ kind: 'newest' }, true);
      followPendingLayout = true;
    },
    followNow() {
      if (!followAllowed()) return;
      options.list()?.toNewest();
    },
    holdReadingPosition(delta, onlyVisibleRowId) {
      if (onlyVisibleRowId && (visibleRows.length !== 1 || visibleRows[0]?.id !== onlyVisibleRowId)) return;
      if (active || pinned || delta === 0) return;
      options.list()?.shiftBy(delta);
    },
    holdLanding(offset) {
      if (!held || active) return;
      options.list()?.toOffset(offset);
    },
    cancel() {
      end('cancelled');
    },
    reset() {
      pinned = true;
      followPendingLayout = false;
      active = null;
      held = false;
      momentumOwed = false;
      readerMoved = false;
      visibleRows = [];
      visibleRowsOf = null;
    },
    observeLayout() {
      if (active) attempt(active);
      if (followPendingLayout && followAllowed()) {
        followPendingLayout = false;
        options.list()?.toNewest();
        pinned = true;
      }
    },
    observeScroll() {
      active?.verifyScroll?.();
    },
    observeVisibleRows(rows) {
      visibilitySeq += 1;
      visibleRows = rows;
      visibleRowsOf = options.rows();
      if (active) attempt(active);
    },
    observeTailPinned(next) {
      if (held || (active && isRowDestination(active.destination))) return;
      // A native anchor can move while a pinned draft commit is laying out.
      // Its one pending layout completes the follow; later offsets stand.
      if (!next && followPendingLayout) return;
      if (!next && active?.following) active = null;
      pinned = next;
    },
    dragStarted() {
      readerMoved = true;
      dragSequence += 1;
      dragging = true;
      momentum = false;
      momentumOwed = false;
      end('drag');
    },
    momentumStarted() {
      dragSequence += 1;
      momentum = true;
      const fromDrag = dragging || momentumOwed;
      momentumOwed = false;
      if (!fromDrag) return;
      dragging = true;
      end('drag');
    },
    dragEnded(momentumMayFollow) {
      const current = ++dragSequence;
      if (!momentumMayFollow) {
        dragging = false;
        return;
      }
      momentumOwed = true;
      schedule(() => {
        if (dragSequence === current) dragging = false;
      });
    },
    momentumEnded() {
      dragSequence += 1;
      dragging = false;
      momentum = false;
      momentumOwed = false;
      if (active?.destination.kind === 'offset') attempt(active);
    },
    userScrolled() {
      readerMoved = true;
      end('drag');
    },
    active: () => active?.destination ?? null,
    isLanding: () => Boolean(active && isRowDestination(active.destination)),
    isHoldingLanding: () => held && !active,
    isPinnedToTail: () => pinned,
    isUserDragging: () => dragging,
  };
}

/**
 * Land a message jump (a notification, a quote, a retry) at the top of the
 * screen, reading its row into the window first when `read` is given. The
 * request goes first: it cancels the request it replaces, and that request's
 * cancellation drops its own read. Reading first would let that cancellation
 * drop the new read instead.
 */
export function requestMessageJump(
  controller: Pick<TranscriptScrollController<TranscriptScrollRow>, 'request'>,
  messageId: string,
  read: ((messageId: string) => void) | null,
): void {
  controller.request({ kind: 'message', messageId, align: 'top', jump: true });
  read?.(messageId);
}

/** One controller per transcript surface; option callbacks always read the latest render. */
export function useTranscriptScrollController<Row extends TranscriptScrollRow>(
  options: TranscriptScrollControllerOptions<Row>,
): TranscriptScrollController<Row> {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [controller] = useState(() =>
    createTranscriptScrollController<Row>({
      precedingRowStep: () => optionsRef.current.precedingRowStep?.() ?? 0,
      list: () => optionsRef.current.list(),
      rows: () => optionsRef.current.rows(),
      rowIndex: (destination, rows) => optionsRef.current.rowIndex(destination, rows),
      canScrollTo: (destination, index) =>
        optionsRef.current.canScrollTo?.(destination, index) ?? true,
      onUnreachable: (destination) => optionsRef.current.onUnreachable?.(destination),
      onScrolled: (destination, rowId) => optionsRef.current.onScrolled?.(destination, rowId),
      onLanded: (destination, rowId) => optionsRef.current.onLanded?.(destination, rowId),
      holdsLanding: (destination) => optionsRef.current.holdsLanding?.(destination) ?? false,
      onCancelled: (destination, reason) => optionsRef.current.onCancelled?.(destination, reason),
      schedule: (callback) => (optionsRef.current.schedule ?? defaultSchedule)(callback),
    }),
  );
  return controller;
}

type PhoneList = {
  scrollToIndex(params: { index: number; viewPosition: number; animated: boolean }): void;
  scrollToOffset(params: { offset: number; animated: boolean }): void;
};

type PhoneRowLayout = { y: number; height: number };
type PhoneListGeometry = {
  row(id: string): PhoneRowLayout | undefined;
  viewportHeight(): number;
  contentHeight(): number;
};

function phoneTargetOffset(row: PhoneRowLayout, viewport: number, content: number, position: number) {
  const target = row.y - position * (viewport - row.height);
  return Math.max(0, Math.min(target, content - viewport));
}

/**
 * The inverted phone FlatList. Offset 0 is the newest end, and view position 1
 * puts a row's start at the top of the viewport. Pass `scrollToIndexFailed`
 * as the list's `onScrollToIndexFailed`: the list calls it synchronously from
 * `scrollToIndex` when the row is beyond every row it measured. `isMeasured`
 * says whether the list has laid out a row's cell; the list places a row it
 * has not measured by an estimate, so that row is not reached yet.
 */
export function phoneTranscriptList(
  getList: () => PhoneList | null,
  isMeasured: (rowId: string) => boolean,
  getOffsetRef?: () => { current: number },
  geometry?: PhoneListGeometry,
): TranscriptScrollList & {
  scrollToIndexFailed(info: { averageItemLength: number }): void;
} {
  let failed = false;
  let averageItemLength = 0;
  return {
    currentOffset: () => getOffsetRef?.().current,
    isRowVisible(rowId) {
      const row = geometry?.row(rowId);
      const viewport = geometry?.viewportHeight();
      const offset = getOffsetRef?.().current;
      if (!row || !viewport || offset === undefined) return null;
      return row.y + row.height > offset && row.y < offset + viewport;
    },
    contextFitsViewport(contextId, unreadId) {
      const context = geometry?.row(contextId);
      const unread = geometry?.row(unreadId);
      const viewport = geometry?.viewportHeight();
      const content = geometry?.contentHeight();
      if (!context || !unread || !viewport || !content) return true;
      const offset = phoneTargetOffset(context, viewport, content, 1);
      return context.height < viewport && unread.y + unread.height > offset && unread.y < offset + viewport;
    },
    toNewest() {
      getList()?.scrollToOffset({ offset: 0, animated: false });
    },
    toRow(index, rowId, align) {
      const list = getList();
      if (!list) return false;
      failed = false;
      const viewPosition = align === 'top' ? 1 : 0.5;
      const row = geometry?.row(rowId);
      const viewport = geometry?.viewportHeight() ?? 0;
      const content = geometry?.contentHeight() ?? 0;
      const offset = getOffsetRef?.().current;
      list.scrollToIndex({ index, viewPosition, animated: false });
      if (failed || !isMeasured(rowId)) return false;
      if (!geometry) return true;
      if (!row || viewport <= 0 || content <= 0) return false;
      if (content <= viewport) return 'no-op';
      const target = phoneTargetOffset(row, viewport, content, viewPosition);
      return offset !== undefined && Math.abs(target - offset) <= 1 ? 'no-op' : true;
    },
    toEstimatedRow(index) {
      // Variable-height rows cannot provide getItemLayout. Scroll near the
      // row, let that window measure, then the next pass resolves it again.
      // A row below the measured ones was already scrolled near by its estimate.
      if (failed && averageItemLength > 0)
        getList()?.scrollToOffset({ offset: averageItemLength * index, animated: false });
    },
    toOffset(offset) {
      getList()?.scrollToOffset({ offset, animated: false });
    },
    shiftBy(delta) {
      const offsetRef = getOffsetRef?.();
      if (!offsetRef) return;
      offsetRef.current = Math.max(0, offsetRef.current + delta);
      getList()?.scrollToOffset({ offset: offsetRef.current, animated: false });
    },
    scrollToIndexFailed(info) {
      failed = true;
      averageItemLength = info.averageItemLength;
    },
  };
}

type DesktopNode = {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight?: number;
  getBoundingClientRect?(): { top: number; bottom: number };
};

type DesktopRowNode = {
  scrollIntoView(options: { block: 'start' | 'center'; behavior: 'instant' }): void;
  getBoundingClientRect?(): { top: number; bottom?: number };
};

/** The desktop transcript: a plain scrollable DOM node with one node per row. */
export function desktopTranscriptList(
  getScrollNode: () => DesktopNode | null,
  getRowNode: (rowId: string) => DesktopRowNode | undefined,
): TranscriptScrollList {
  return {
    isRowVisible(rowId) {
      const viewport = getScrollNode()?.getBoundingClientRect?.();
      const row = getRowNode(rowId)?.getBoundingClientRect?.();
      if (!viewport || !row || row.bottom === undefined || viewport.bottom <= viewport.top) return null;
      return row.bottom > viewport.top && row.top < viewport.bottom;
    },
    contextFitsViewport(contextId, unreadId) {
      const height = getScrollNode()?.clientHeight;
      const context = getRowNode(contextId)?.getBoundingClientRect?.();
      const unread = getRowNode(unreadId)?.getBoundingClientRect?.();
      return !height || !context || !unread || unread.top - context.top < height;
    },
    toNewest() {
      const node = getScrollNode();
      if (node) node.scrollTop = node.scrollHeight;
    },
    toRow(_index, rowId, align) {
      const row = getRowNode(rowId);
      if (!row) return false;
      const node = getScrollNode();
      const before = node?.scrollTop;
      row.scrollIntoView({ block: align === 'top' ? 'start' : 'center', behavior: 'instant' });
      return node && node.scrollTop === before ? 'no-op' : 'synced';
    },
    toEstimatedRow() {},
    toOffset(offset) {
      const node = getScrollNode();
      if (node) node.scrollTop = offset;
    },
    shiftBy(delta) {
      const node = getScrollNode();
      if (node) node.scrollTop += delta;
    },
  };
}

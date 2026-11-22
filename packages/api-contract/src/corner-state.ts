import type { CornerBlocker, CornerState, CornerStateReason } from './phone-types.js';

export type DerivedCornerState = {
  readonly state: CornerState;
  readonly reason?: CornerStateReason;
  readonly itemId?: string;
  readonly blocker?: CornerBlocker;
};

/**
 * A thread's Tasks state for one viewer: the corner machine's output in Work-board words.
 * The one per-viewer mapping (server projections, chat list order and labels, Tasks board); the
 * state mark is `threadWorkMark`. Needs you only when the thread waits on this viewer.
 */
export function threadWorkState(
  thread: Pick<DerivedCornerState, 'state' | 'reason' | 'blocker'>,
  viewer: string | undefined,
): import('./work-board.js').WorkState {
  if (thread.state === 'archived') return 'done';
  if (thread.state === 'review') return 'in-review';
  if (thread.state === 'waiting' && viewer !== undefined && thread.blocker?.personId === viewer) return 'needs-you';
  if (thread.state === 'idle' && thread.reason === 'backlog') return 'backlog';
  return 'in-progress';
}

/**
 * The thread's state mark, the same for every viewer: a waiting thread draws the waiting @ whoever
 * it waits on, and the ring is idle only while the machine is idle. Whom a wait asks stays with
 * the message the implementer addressed (Tasks, `threadWorkState`).
 */
export function threadWorkMark(
  thread: Pick<DerivedCornerState, 'state' | 'reason'>,
): { state: import('./work-board.js').WorkState; idle: boolean } {
  if (thread.state === 'waiting') return { state: 'needs-you', idle: false };
  const state = threadWorkState(thread, undefined);
  return { state, idle: state === 'in-progress' && thread.state === 'idle' };
}

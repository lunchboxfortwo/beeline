import type { CornerBlocker, CornerState, CornerStateReason } from './phone-types.js';

export type DerivedCornerState = {
  readonly state: CornerState;
  readonly reason?: CornerStateReason;
  readonly itemId?: string;
  readonly blocker?: CornerBlocker;
};

/**
 * A thread's Tasks state for one viewer: the corner machine's output in Work-board words.
 * The one mapping every reader uses (server projections, chat list, header, Tasks board).
 * Needs you only when the thread waits on this viewer; a wait on anyone else is in progress.
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

/** The thread's state mark: its Tasks state, drawn idle while nothing runs (a wait on someone else included). */
export function threadWorkMark(
  thread: Pick<DerivedCornerState, 'state' | 'reason' | 'blocker'>,
  viewer: string | undefined,
): { state: import('./work-board.js').WorkState; idle: boolean } {
  const state = threadWorkState(thread, viewer);
  return { state, idle: state === 'in-progress' && (thread.state === 'idle' || thread.state === 'waiting') };
}

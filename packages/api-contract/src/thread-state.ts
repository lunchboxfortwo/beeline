import type { CornerState } from './phone-types.js';

/** What the one thread-state rule reads. The ids name who the state is about. */
type ThreadStateFacts = { ended?: boolean; implementerRunning?: boolean; reviewerActive?: boolean; checksRunning?: boolean;
  decisionOpen?: boolean; backlog?: boolean; peerRunning?: boolean; implementer?: string; reviewer?: string; peer?: string };
export type ThreadState =
  | { state: 'archived' | 'waiting' } | { state: 'idle'; reason?: 'backlog' }
  | { state: 'working' | 'review'; agent?: string };

/** The only thread state. Work and review outrank a block: a blocked agent would not be running. */
export function threadState(f: ThreadStateFacts): ThreadState {
  const named = (state: 'working' | 'review', agent?: string) => ({ state, ...(agent ? { agent } : {}) });
  if (f.ended) return { state: 'archived' };
  if (f.implementerRunning) return named('working', f.implementer);
  if (f.reviewerActive) return named('review', f.reviewer);
  if (f.checksRunning) return { state: 'review' };
  if (f.decisionOpen) return { state: 'waiting' };
  if (f.backlog) return { state: 'idle', reason: 'backlog' };
  if (f.peerRunning) return named('working', f.peer);
  return { state: 'idle' };
}

/** The only thread activity words, naming the agent the state names. */
export function threadActivityLabel(t: { state?: CornerState; workingAgentName?: string }): string | undefined {
  if (t.workingAgentName && t.state === 'working') return `${t.workingAgentName} is working`;
  if (t.workingAgentName && t.state === 'review') return `${t.workingAgentName} is reviewing`;
  return undefined;
}

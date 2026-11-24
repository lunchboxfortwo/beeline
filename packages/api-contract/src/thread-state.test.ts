import { describe, expect, it } from 'vitest';
import { threadActivityLabel, threadState } from './thread-state.js';

// The frozen thread-state rule. Change a row only with the owner: work and review outrank a block.
const ids = { implementer: 'ruby', reviewer: 'speedy', peer: 'ada' };
const names: Record<string, string> = { ruby: 'Ruby', speedy: 'Speedy', ada: 'Ada' };
const CASES: [string, Parameters<typeof threadState>[0], string, string?][] = [
  ['screenshot: stale block + open PR + reviewer running', { decisionOpen: true, reviewerActive: true }, 'review', 'Speedy is reviewing'],
  ['block + implementer running', { decisionOpen: true, implementerRunning: true }, 'working', 'Ruby is working'],
  ['block + checks running, nobody running', { decisionOpen: true, checksRunning: true }, 'review'],
  ['block, nothing running', { decisionOpen: true }, 'waiting'],
  ['merge hold only', { decisionOpen: true }, 'waiting'],
  ['merge hold + reviewer running', { decisionOpen: true, reviewerActive: true }, 'review', 'Speedy is reviewing'],
  ['implementer and reviewer both running', { implementerRunning: true, reviewerActive: true }, 'working', 'Ruby is working'],
  ['checks running + peer running', { checksRunning: true, peerRunning: true }, 'review'],
  ['block + peer running', { decisionOpen: true, peerRunning: true }, 'waiting'],
  ['backlog', { backlog: true }, 'idle'],
  ['backlog + implementer running', { backlog: true, implementerRunning: true }, 'working', 'Ruby is working'],
  ['backlog + peer running', { backlog: true, peerRunning: true }, 'idle'],
  ['peer running only', { peerRunning: true }, 'working', 'Ada is working'],
  ['ended while everything runs', { ended: true, implementerRunning: true, reviewerActive: true, decisionOpen: true }, 'archived'],
  ['nothing', {}, 'idle'],
];

describe('threadState', () => {
  it.each(CASES)('%s', (_label, facts, state, label) => {
    const result = threadState({ ...ids, ...facts });
    expect(result.state).toBe(state);
    const agent = 'agent' in result ? result.agent : undefined;
    expect(threadActivityLabel({ state: result.state, workingAgentName: agent && names[agent] })).toBe(label);
  });

  it('marks backlog idle with its reason and names nobody without an id', () => {
    expect(threadState({ backlog: true })).toEqual({ state: 'idle', reason: 'backlog' });
    expect(threadState({ implementerRunning: true })).toEqual({ state: 'working' });
    expect(threadState({ checksRunning: true, ...ids })).toEqual({ state: 'review' });
  });

  it('labels only working and review, never another state', () => {
    for (const state of ['waiting', 'idle', 'archived'] as const)
      expect(threadActivityLabel({ state, workingAgentName: 'Speedy' })).toBeUndefined();
    expect(threadActivityLabel({ state: 'review' })).toBeUndefined();
  });
});

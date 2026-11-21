import { expect, it } from 'vitest';
import { transitionCorner, type CornerMachineFacts } from './corner-machine.js';

const facts: CornerMachineFacts = { archived: false, turnRunning: false };
const state = (input: CornerMachineFacts) =>
  transitionCorner({ state: 'idle' }, { facts: input, event: { kind: 'reconcile' } }).state.state;
// Transition precedence is covered by corner-machine and the independent exhaustive/reference suites.
it('a running turn overrides waiting on the owner, then restores the wait', () => {
  const blocker = { reason: 'question' as const, itemId: 'report',
    blocker: { kind: 'report' as const, personId: 'commander', personName: 'Commander' } };
  const waiting = { ...facts, reviewerActive: true,
    lifecycle: { lifecycle: 'in-review' as const, checks: 'pending' as const }, blocker };
  expect(state(waiting)).toBe('waiting');
  expect(state({ ...waiting, turnRunning: true })).toBe('working');
  expect(state(waiting)).toBe('waiting');
});

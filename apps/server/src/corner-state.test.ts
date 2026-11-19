import { expect, it } from 'vitest';
import { deriveCornerState } from './corner-state.js';
import type { CornerStateFacts } from '@beeline/api-contract/phone';

const facts: CornerStateFacts = { archived: false, turnRunning: false };
// Transition precedence is covered by corner-machine and the independent exhaustive/reference suites.
it.each(['landed', 'closed', 'ask_human', 'implement', 'checks', 'review'])(
  'the compatibility view ignores a historical %s lifecycle card', state => {
    expect(deriveCornerState({ ...facts, run: { state } })).toEqual({ state: 'idle' });
  },
);
it('a running turn overrides waiting on the owner, then restores the same blocker', () => {
  const blocker = { reason: 'question' as const, itemId: 'report',
    blocker: { kind: 'report' as const, personId: 'commander', personName: 'Commander' } };
  const waiting = { ...facts, reviewerActive: true,
    lifecycle: { lifecycle: 'in-review' as const, checks: 'pending' as const }, blocker };
  expect(deriveCornerState(waiting)).toEqual({ state: 'waiting', ...blocker });
  expect(deriveCornerState({ ...waiting, turnRunning: true })).toEqual({ state: 'working' });
  expect(deriveCornerState(waiting)).toEqual({ state: 'waiting', ...blocker });
});
it('the public review view omits machine phases and effect receipts', () => {
  expect(deriveCornerState({ ...facts, lifecycle: { lifecycle: 'in-review', checks: 'pending' } }))
    .toEqual({ state: 'review' });
});

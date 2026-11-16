import { describe, expect, it } from 'vitest';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';
import { threadListLabel, threadPrLine } from './thread-status';

const pr = { number: 4181, url: 'https://github.com/o/r/pull/4181', title: 'Keep place', targetBranch: 'main', headSha: 'abc' };
const lifecycle = (extra: Partial<CornerLifecycleView>): CornerLifecycleView => ({ lifecycle: 'in-review', checks: 'unknown', pr, ...extra });

describe('thread status (header B)', () => {
  it('reads list words as the Chats list does', () => {
    const viewer = 'v'.repeat(64);
    const blocker = { kind: 'report' as const, personId: viewer, personName: 'Vera' };
    expect(threadListLabel({ state: 'waiting', blocker }, viewer)).toEqual({ word: 'waiting on you', you: true });
    expect(threadListLabel({ state: 'waiting', blocker }, 'o'.repeat(64))).toEqual({ word: 'waiting on Vera', you: false });
    // Never a bare "waiting", even before the server names the person.
    expect(threadListLabel({ state: 'waiting', reason: 'approve' }, viewer).word).toBe('waiting on approval');
    expect(threadListLabel({ state: 'waiting', blocker: { kind: 'ci' } }, viewer).word).toBe('waiting on checks');
    expect(threadListLabel({ state: 'waiting' }, viewer).word).toBe('waiting on a reply');
    expect(threadListLabel({ state: 'review' }, viewer).word).toBe('review');
    expect(threadListLabel({ state: 'archived' }, viewer).word).toBe('done');
  });

  it('writes the PR row from the lifecycle', () => {
    expect(threadPrLine(undefined, false)).toBeUndefined();
    expect(threadPrLine({ lifecycle: 'working', checks: 'unknown' }, false)).toBeUndefined();
    expect(threadPrLine(lifecycle({ checksSummary: { status: 'passing', total: 14, failing: [], checks: [], updatedAt: 1 } }), false))
      .toBe('#4181 · Open · All 14 checks passed');
    expect(threadPrLine(lifecycle({
      checksSummary: { status: 'pending', total: 12, failing: [], updatedAt: 1, checks: [
        ...Array.from({ length: 9 }, (_, i) => ({ name: `c${i}`, status: 'passed' as const })),
        ...Array.from({ length: 3 }, (_, i) => ({ name: `p${i}`, status: 'pending' as const })),
      ] },
    }), false)).toBe('#4181 · Open · 9 of 12 checks passed · running');
    expect(threadPrLine(lifecycle({ checksSummary: { status: 'failing', total: 3, failing: ['Mobile suite'], checks: [], updatedAt: 1 } }), false))
      .toBe('#4181 · Open · 1 check failed · Mobile suite');
    expect(threadPrLine(lifecycle({ pr: { ...pr, mergedAt: '2026-11-11' } }), false)).toBe('#4181 · Merged');
    expect(threadPrLine(lifecycle({}), true)).toBe('#4181 · Closed');
    expect(threadPrLine(lifecycle({ pr: { ...pr, mergeability: 'dirty' } }), false)).toBe('#4181 · Open · Merge conflict');
    expect(threadPrLine(lifecycle({ pr: { ...pr, mergeability: 'draft' }, checks: 'unknown' }), false)).toBe('#4181 · Draft · No checks ran');
  });
});

import { describe, expect, it } from 'vitest';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';
import { threadDotTone, threadListWord, threadPrLine, threadStatusText } from './thread-status';

const pr = { number: 4181, url: 'https://github.com/o/r/pull/4181', title: 'Keep place', targetBranch: 'main', headSha: 'abc' };
const lifecycle = (extra: Partial<CornerLifecycleView>): CornerLifecycleView => ({ lifecycle: 'in-review', checks: 'unknown', pr, ...extra });

describe('thread status (header B)', () => {
  it('names the state and adds the running count only when something runs', () => {
    expect(threadStatusText('review', 2)).toBe('In review · 2 running');
    expect(threadStatusText('waiting', 0)).toBe('Waiting on you');
    expect(threadStatusText('working', 1)).toBe('Working · 1 running');
  });

  it('colours the dot brass when it needs you, green while working, stroke otherwise', () => {
    expect(threadDotTone('waiting')).toBe('needsYou');
    expect(threadDotTone('review')).toBe('needsYou');
    expect(threadDotTone('working')).toBe('added');
    expect(threadDotTone('idle')).toBe('strongStroke');
    expect(threadDotTone('archived')).toBe('strongStroke');
  });

  it('reads list words as the Chats list does', () => {
    expect(threadListWord('waiting')).toBe('waiting on you');
    expect(threadListWord('review')).toBe('review');
    expect(threadListWord('archived')).toBe('done');
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
    expect(threadPrLine(lifecycle({ pr: { ...pr, mergeability: 'draft' }, checks: 'unknown' }), false)).toBe('#4181 · Draft · No checks configured');
  });
});

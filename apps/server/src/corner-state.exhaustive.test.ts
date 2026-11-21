
import { describe, expect, it } from 'vitest';

import { transitionCorner, type CornerMachineFacts } from "./corner-machine.js";

import type { CornerLifecycleView, CornerState } from "@beeline/api-contract/phone";

const PR = {
  number: 1,
  url: 'https://github.com/o/r/pull/1',
  title: 'Fix',
  targetBranch: 'main',
  headSha: 'a'.repeat(40),
} as const;

type CheckShape = 'pending' | 'passing' | 'failing' | 'unknown' | 'unreported' | 'no-checks';

type Closure = 'none' | 'landed' | 'done' | 'abandoned' | 'merged';

type BlockerKind =
  | 'none'
  | 'human-approve'
  | 'human-connect'
  | 'human-question'
  | 'merge-hold'
  | 'agent'
  | 'human+agent';

const CHECKS: readonly CheckShape[] = ['pending', 'passing', 'failing', 'unknown', 'unreported', 'no-checks'];

const BLOCKERS: readonly BlockerKind[] = [
  'none',
  'human-approve',
  'human-connect',
  'human-question',
  'merge-hold',
  'agent',
  'human+agent',
];

function lifecycleFor(shape: CheckShape, prPresent: boolean, closure: Closure): CornerLifecycleView {
  const checks =
    shape === 'pending' ? 'pending' : shape === 'passing' ? 'passing' : shape === 'failing' ? 'failing' : 'unknown';
  let lifecycle: CornerLifecycleView = {
    lifecycle: 'in-review',
    checks,
    ...(prPresent ? { pr: PR } : {}),
  };
  if (shape === 'unreported' || shape === 'no-checks') {
    lifecycle = {
      ...lifecycle,
      checks: 'unknown',
      checksSummary: {
        status: 'unknown',
        total: 0,
        failing: [],
        checks: [],
        updatedAt: 1,
        ...(shape === 'no-checks' ? { fetchStartedAt: 1 } : {}),
      },
    };
  }
  if (closure === 'landed') lifecycle = { ...lifecycle, outcome: 'landed' };
  if (closure === 'done') lifecycle = { ...lifecycle, lifecycle: 'done' };
  if (closure === 'abandoned') lifecycle = { ...lifecycle, outcome: 'abandoned' };
  if (closure === 'merged' && lifecycle.pr) {
    lifecycle = { ...lifecycle, pr: { ...lifecycle.pr, mergedAt: '2026-10-20T00:00:00.000Z' } };
  }
  return lifecycle;
}

function blockerFacts(kind: BlockerKind): Pick<CornerMachineFacts, 'blocker'> {
  if (kind === 'none') return {};
  if (kind === 'agent') {
    return {
      blocker: { reason: 'question', blocker: { kind: 'report', personId: 'commander' } },
    };
  }
  if (kind === 'merge-hold') {
    return {
      blocker: { reason: 'approve', blocker: { kind: 'merge-hold', personId: 'human' } },
    };
  }
  const reason = kind === 'human-approve' ? 'approve' : kind === 'human-connect' ? 'connect' : 'question';
  return {
    blocker: { reason, blocker: { kind: 'message', personId: 'human' } },
  };
}

function pendingOnHead(facts: CornerMachineFacts): boolean {
  const lifecycle = facts.lifecycle;
  const checks = lifecycle?.checksSummary?.status ?? lifecycle?.checks;
  const summary = lifecycle?.checksSummary;
  const unreported =
    Boolean(lifecycle?.pr) &&
    summary?.status === 'unknown' &&
    summary.total === 0 &&
    summary.fetchStartedAt === undefined;
  return checks === 'pending' || unreported;
}

function isClosed(facts: CornerMachineFacts): boolean {
  if (facts.archived) return true;
  const lifecycle = facts.lifecycle;
  const raw = String(lifecycle?.lifecycle ?? '').trim().toLowerCase();
  if (lifecycle?.pr?.mergedAt || lifecycle?.outcome === 'landed') return true;
  if (lifecycle?.outcome === 'abandoned') return true;
  if (raw === 'done') return true;
  return false;
}

function scan(
  failures: string[],
  closures: readonly Closure[],
): number {
  let count = 0;
  for (const archived of [false, true]) {
    {
      for (const closure of closures) {
        for (const turnRunning of [false, true]) {
            for (const locked of [false, true]) {
              for (const reviewerActive of [false, true]) {
                for (const shape of CHECKS) {
                  for (const prPresent of [false, true]) {
                    if (closure === 'merged' && !prPresent) continue;
                    for (const blocker of BLOCKERS) {
                      count += 1;
                      const facts: CornerMachineFacts = {
                        archived,
                        locked,
                        turnRunning,
                        reviewerActive,
                        lifecycle: lifecycleFor(shape, prPresent, closure),
                        ...blockerFacts(blocker),
                      };
                      const actual: CornerState = transitionCorner({ state: 'idle' }, { facts, event: { kind: 'reconcile' } }).state.state;
                      const closed = facts.archived || (!locked && isClosed(facts));
                      const pending = pendingOnHead(facts);
                      const anyBlocker = blocker !== 'none';
                      let expected: CornerState;
                      if (closed) expected = 'archived';
                      else if (turnRunning) expected = 'working';
                      else if (anyBlocker && (blocker !== 'merge-hold' || !turnRunning && !reviewerActive && !pending)) expected = 'waiting';
                      else if (reviewerActive || pending) expected = 'review';
                      else if (anyBlocker) expected = 'waiting';
                      else expected = 'idle';
                      if (actual !== expected && failures.length < 8) {
                        failures.push(
                          `got ${actual} expected ${expected} archived=${archived} closure=${closure} turn=${turnRunning} locked=${locked} reviewer=${reviewerActive} checks=${shape} pr=${prPresent} blocker=${blocker}`,
                        );
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  return count;
}

describe('corner machine state invariants', () => {
  it('enumerates archived, turns, checks, pull requests, and blockers', () => {
    const failures: string[] = [];
    const started = performance.now();
    const count = scan(failures, ['none', 'landed', 'done', 'abandoned', 'merged']);
    const elapsed = performance.now() - started;
    expect(failures).toEqual([]);
    expect(count).toBeGreaterThan(5_000);
    expect(elapsed).toBeLessThan(1_000);
  });
});

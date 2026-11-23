import { ciGateChecks } from './corner-ci-gate.js';
import { advanceCorner } from './corner-lifecycle.js';
import {
  cornerFeatureBranch, describe, expect, it, vi, C, R, REVIEWER, URL, SHA, gate, rootFixture,
} from './test-support-pr-checks-status.test-support.js';

/** The corner's PR is open on `main`; nothing has reported checks for its head. */
async function openPr() {
  await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [C,
    JSON.stringify({
      lifecycle: 'in-review', checks: 'unknown',
      pr: { number: 614, url: URL, headSha: SHA, title: 'Work', targetBranch: 'main', mergeability: 'clean' },
    })]);
  rootFixture.mergeableState = 'clean';
  rootFixture.pullBaseSha = rootFixture.mainHead;
}

/** GitHub's pull_request opened webhook for the corner branch. */
const opened = () => rootFixture.operations.processWebhook('pull_request', {
  action: 'opened', installation: { id: 77 }, repository: { id: 101, full_name: 'owner/widgets' },
  pull_request: { number: 614, html_url: URL, title: 'Work', mergeable_state: 'clean',
    head: { ref: cornerFeatureBranch(C), sha: SHA }, base: { ref: 'main' } },
});

const pendingCommands = async (agentId: string) => (await rootFixture.db.query<{ reason: string }>(
  `SELECT reason FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND state='pending'`, [C, agentId],
)).rows.map((row) => row.reason);

describe('CI gate from base-branch protection', () => {
  it('NO-CI-1: an unprotected repo PR with workflow files but no checks merges with no reviewer', async () => {
    await openPr();
    // Workflow files exist but never register for this head (path filters).
    rootFixture.rollupState = null;
    rootFixture.workflowCount = 2;
    rootFixture.registeredCount = 0;
    vi.mocked(rootFixture.operations.landCorner).mockRestore();
    const merge = vi.spyOn(rootFixture.app, 'mergePullRequest').mockResolvedValue(undefined);
    await opened();
    expect(merge).toHaveBeenCalledWith(77, 101, 'owner/widgets', 614, SHA);
    // People see the same checks read as before: nothing has reported.
    expect(await gate()).toMatchObject({ checks: 'pending', checkCount: 0, reviewerExists: false });
  });

  it('NO-CI-2: an unprotected repo PR wakes the reviewer when the whole rollup passes', async () => {
    await openPr();
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, REVIEWER]);
    rootFixture.rollupState = null;
    rootFixture.workflowCount = 2;
    rootFixture.registeredCount = 0;
    await opened();
    expect(await pendingCommands(REVIEWER)).toEqual([]);
    expect(await gate()).toMatchObject({
      checks: 'pending', checkCount: 0, mergeAllowed: false,
      blockedReason: 'no yes on this head', reviewerWake: { status: 'waiting' },
    });
    rootFixture.rollupState = 'PENDING';
    expect(await gate()).toMatchObject({ checks: 'pending', reviewerWake: { status: 'waiting' } });
    expect(await pendingCommands(REVIEWER)).toEqual([]);
    rootFixture.rollupState = 'SUCCESS';
    await opened();
    await rootFixture.db.query(`SELECT beeline_finish_agent_command(id,'complete',NULL,NULL)
      FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND reason='corner_review_dispatch'`, [C, REVIEWER]);
    await opened();
    expect(await pendingCommands(REVIEWER)).toEqual([]);
    expect((await rootFixture.db.query(`SELECT id FROM agent_commands
      WHERE room_id=$1 AND agent_id=$2 AND reason='corner_review_dispatch'`, [C, REVIEWER])).rowCount).toBe(1);
    expect(rootFixture.operations.landCorner).not.toHaveBeenCalled();
  });

  it('NO-CI-3: a legacy cached passing gate waits for an explicit green checks read', async () => {
    await openPr();
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, REVIEWER]);
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=lifecycle || $2::jsonb WHERE corner_id=$1`,
      [C, JSON.stringify({ checks: 'pending', ciGate: { headSha: SHA, checks: 'passing' } })]);
    await advanceCorner(rootFixture.db, C, { kind: 'reconcile' });
    expect(await pendingCommands(REVIEWER)).toEqual([]);
    expect(await gate()).toMatchObject({ checks: 'passed', reviewerWake: { status: 'dispatched' } });
    expect(await pendingCommands(REVIEWER)).toEqual(['corner_review_dispatch']);
  });

  it('REQUIRED-1: a protected repo waits for exactly its required checks', async () => {
    await openPr();
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, REVIEWER]);
    rootFixture.requiredContexts = ['test'];
    rootFixture.rollupState = 'PENDING';
    rootFixture.registeredCount = 0;
    await opened();
    expect(await pendingCommands(REVIEWER)).toEqual([]);
    expect(await gate()).toMatchObject({ checks: 'pending', mergeAllowed: false, reviewerWake: { status: 'waiting' } });
    // The required check passes while another, unrequired check is still running.
    rootFixture.rollupState = 'PENDING';
    rootFixture.rollupContexts = { totalCount: 2, nodes: [
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS',
        checkSuite: { app: { databaseId: 15368 } } },
      { __typename: 'CheckRun', name: 'docs', status: 'IN_PROGRESS', conclusion: null },
    ] };
    expect(await gate()).toMatchObject({ checks: 'pending', checkCount: 2, reviewerWake: { status: 'dispatched' } });
    expect(await pendingCommands(REVIEWER)).toEqual(['corner_review_dispatch']);
  });

  it('REQUIRED-2: the gate verdict is exactly the required checks', () => {
    const rollup = (checks: { name: string; status: 'passed' | 'failed' | 'pending' }[], required?: string[]) => ({
      state: 'pending' as const, total: checks.length, failing: [], checks,
      ...(required ? { required: required.map((name) => ({ name, appId: null })) } : {}),
    });
    expect(ciGateChecks(rollup([], []))).toBe('passed');
    expect(ciGateChecks(rollup([{ name: 'lint', status: 'failed' }], []))).toBe('passed');
    expect(ciGateChecks(rollup([], ['test']))).toBe('pending');
    expect(ciGateChecks(rollup([{ name: 'test', status: 'passed' }, { name: 'lint', status: 'failed' }], ['test']))).toBe('passed');
    expect(ciGateChecks(rollup([{ name: 'test', status: 'failed' }], ['test']))).toBe('failed');
    // A read without the base branch keeps the whole-rollup verdict.
    expect(ciGateChecks(rollup([]))).toBe('pending');
    // An app-pinned requirement needs that app's report.
    expect(ciGateChecks({ ...rollup([{ name: 'test', status: 'passed' }]),
      required: [{ name: 'test', appId: 7 }], passedContexts: [{ name: 'test', appId: 8 }] })).toBe('pending');
  });
});

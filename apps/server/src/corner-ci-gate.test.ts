import { ciGateChecks } from './corner-ci-gate.js';
import { advanceCorner } from './corner-lifecycle.js';
import { readAgentCommands } from './agent-command.js';
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
  it('NO-CI-1: an unprotected repo PR with no workflows merges when it opens', async () => {
    await openPr();
    rootFixture.rollupState = null;
    rootFixture.registeredCount = 0;
    vi.mocked(rootFixture.operations.landCorner).mockRestore();
    const merge = vi.spyOn(rootFixture.app, 'mergePullRequest').mockResolvedValue(undefined);
    await opened();
    expect(merge).toHaveBeenCalledWith(77, 101, 'owner/widgets', 614, SHA);
    expect(await gate()).toMatchObject({ checks: 'passed', checkCount: 0, mergeAllowed: true });
  });

  it('blocks the same head when a newly configured workflow has yet to register', async () => {
    await openPr();
    rootFixture.rollupState = null;
    rootFixture.registeredCount = 0;
    await opened();
    expect(await gate()).toMatchObject({ headSha: SHA, checks: 'passed', checkCount: 0, mergeAllowed: true });

    rootFixture.workflowCount = 1;
    expect(await gate()).toMatchObject({ headSha: SHA, checks: 'pending', checkCount: 0, mergeAllowed: false });
    expect(await rootFixture.operations.lifecycle(C)).toMatchObject({ checks: 'pending', checksSummary: { total: 0 } });
  });

  it('Reproduction 1: an approved PR on an unprotected base waits for all head checks', async () => {
    await openPr();
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, REVIEWER]);
    rootFixture.rollupState = null;
    rootFixture.workflowCount = 2;
    vi.mocked(rootFixture.operations.landCorner).mockRestore();
    const merge = vi.spyOn(rootFixture.app, 'mergePullRequest').mockResolvedValue(undefined);

    await opened();
    expect(await pendingCommands(REVIEWER)).toEqual([]);
    expect(merge).not.toHaveBeenCalled();

    await rootFixture.daemon.execute('approveCornerMerge', { cornerId: C, headSha: SHA }, REVIEWER);

    rootFixture.rollupState = 'PENDING';
    await opened();
    expect(await gate()).toMatchObject({
      checks: 'pending', checkCount: 1, approved: true, mergeAllowed: false,
      reviewerWake: { status: 'waiting' },
    });
    expect(await pendingCommands(REVIEWER)).toEqual([]);
    expect(merge).not.toHaveBeenCalled();

    rootFixture.rollupState = 'SUCCESS';
    rootFixture.rollupContexts = { totalCount: 3, nodes: [
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'NEUTRAL' },
    ] };
    await rootFixture.operations.processWebhook('check_run', {
      action: 'completed', installation: { id: 77 }, repository: { full_name: 'owner/widgets' },
      check_run: { name: 'test', status: 'completed', conclusion: 'success', head_sha: SHA,
        check_suite: { head_branch: cornerFeatureBranch(C), head_sha: SHA } },
    });
    expect(merge).toHaveBeenCalledTimes(1);
    expect(merge).toHaveBeenCalledWith(77, 101, 'owner/widgets', 614, SHA);
  });

  it('names a failed head check when refusing a merge on an unprotected base', async () => {
    await openPr();
    rootFixture.rollupState = 'FAILURE';
    rootFixture.rollupContexts = { totalCount: 101, pageInfo: { endCursor: 'next' }, nodes:
      Array.from({ length: 100 }, (_, index) => ({
        __typename: 'CheckRun', name: `shard ${index + 1}`, status: 'COMPLETED', conclusion: 'SUCCESS',
      })),
    };
    rootFixture.rollupPages.next = { totalCount: 101, nodes: [
      { __typename: 'StatusContext', context: 'deploy/preview', state: 'FAILURE' },
    ] };
    const merge = vi.spyOn(rootFixture.app, 'mergePullRequest').mockResolvedValue(undefined);

    expect(await rootFixture.daemon.execute('mergeCorner', { cornerId: C }, REVIEWER)).toMatchObject({
      status: 'blocked', blocker: expect.stringContaining('deploy/preview'),
    });
    expect(merge).not.toHaveBeenCalled();
  });

  it('renders a queued check-triggered review from the current check rollup on the same head', async () => {
    await openPr();
    await rootFixture.db.query('UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1', [R, REVIEWER]);
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=lifecycle || '{"checks":"passing"}' WHERE corner_id=$1`, [C]);
    await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,system_event)
      SELECT 'review-check-passed', $1, created_by, 'Checks passed', jsonb_build_object('kind','check-passed','object',jsonb_build_object('headSha',$2::text))
      FROM rooms WHERE id=$1`, [C, SHA]);
    await advanceCorner(rootFixture.db, C, { kind: 'checks', result: 'passing', sourceMessageId: 'review-check-passed' });
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=lifecycle || $2::jsonb WHERE corner_id=$1`, [C,
      JSON.stringify({ checks: 'passing', checksSummary: { status: 'pending', total: 1, failing: [],
        checks: [{ name: 'test', status: 'pending' }] } })]);
    const wake = (await readAgentCommands(rootFixture.db, REVIEWER, C)).commands
      .find(item => item.reason === 'corner_review_dispatch');
    expect(wake?.source.body).toContain('Checks: pending');
    expect(wake?.source.body).toContain('test');
    expect(wake?.source.body).not.toContain('Checks passed');
  });

  it.each(['passing', null])('NO-CI-3: a legacy cached %s gate waits for an explicit green checks read', async checks => {
    await openPr();
    await rootFixture.db.query(`UPDATE rooms SET reviewer_agent_id=$2 WHERE id=$1`, [R, REVIEWER]);
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=lifecycle || $2::jsonb WHERE corner_id=$1`,
      [C, JSON.stringify({ checks: 'pending', ciGate: { headSha: SHA, checks } })]);
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

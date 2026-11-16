import { describe, expect, it, DaemonService, PhoneService, LiveHub, H, A, B, R,
  rootFixture, inReview, approve, reasons, SHA, branchOf } from './test-support-corner-lifecycle.test-support.js';

function wireLanding() {
  const daemon = new DaemonService(rootFixture.db, new LiveHub(), undefined, undefined, false, undefined, false, undefined,
    (input, confirmZeroChecks) => rootFixture.github.prChecksStatus(input, confirmZeroChecks), undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, (id, onBlocked) => rootFixture.github.landCornerOutcome(id, onBlocked));
  Object.assign(daemon, { github: rootFixture.github });
  return daemon;
}

async function noBrief() {
  const cornerId = await inReview();
  await rootFixture.db.query('DELETE FROM corner_brief_revisions WHERE corner_id=$1', [cornerId]);
  rootFixture.githubHead = SHA;
  rootFixture.githubRollupState = 'passed';
  return cornerId;
}

async function checksGreen(cornerId: string) {
  rootFixture.githubRollupState = 'passed';
  await rootFixture.github.processWebhook('check_run', {
    action: 'completed', installation: { id: 77 }, repository: { full_name: 'owner/widgets' },
    check_run: { id: 71, name: 'typecheck', status: 'completed', conclusion: 'success', head_sha: SHA,
      check_suite: { head_branch: branchOf(cornerId) } },
  });
}

describe('the server lands an approved head without an implementer turn', () => {
  it('records reviewer yes and merges a green head with no brief, even while the reviewer is active', async () => {
    const cornerId = await noBrief();
    const daemon = wireLanding();
    await expect(daemon.execute('approveCornerMerge', { cornerId, headSha: SHA }, B)).resolves.toMatchObject({ status: 'approved' });
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledWith(77, 101, 'owner/widgets', 7, SHA);
    expect(await reasons(cornerId, A)).not.toContain('corner_land');
    // Re-delivery on the same head cannot replenish the existing land receipt.
    await daemon.execute('approveCornerMerge', { cornerId, headSha: SHA }, B);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it('records reviewer yes against live green checks even when the saved check snapshot is pending', async () => {
    const cornerId = await noBrief();
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`, [cornerId]);
    await wireLanding().execute('approveCornerMerge', { cornerId, headSha: SHA }, B);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(await reasons(cornerId, A)).not.toContain('corner_land');
  });

  it('merges when checks become green after a reviewer yes, with no brief and no agent merge call', async () => {
    const cornerId = await noBrief();
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`, [cornerId]);
    rootFixture.githubRollupState = 'pending';
    await wireLanding().execute('approveCornerMerge', { cornerId, headSha: SHA }, B);
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
    await checksGreen(cornerId);
    await checksGreen(cornerId);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledWith(77, 101, 'owner/widgets', 7, SHA);
    expect(await reasons(cornerId, A)).not.toContain('corner_land');
  });

  it('holds an approved green head, then merges when the phone releases the hold', async () => {
    const cornerId = await noBrief();
    const phone = new PhoneService(rootFixture.db, 'http://test', rootFixture.github);
    const hold = await phone.execute('setCornerHold', { cornerId }, H);
    await wireLanding().execute('approveCornerMerge', { cornerId, headSha: SHA }, B);
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
    // The release event must read GitHub even if the display snapshot missed green.
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`, [cornerId]);
    await phone.execute('setCornerHold', { cornerId, releaseHoldId: hold.holdId }, H);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(await reasons(cornerId, A)).not.toContain('corner_land');
  });

  it('without a reviewer, a green event lands with no approval row', async () => {
    const cornerId = await noBrief();
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: null }, H);
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`, [cornerId]);
    rootFixture.githubRollupState = 'pending';
    expect(await rootFixture.github.prChecksStatus({ cornerId })).toMatchObject({ mergeAllowed: false });
    await checksGreen(cornerId);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
    expect((await rootFixture.db.query('SELECT 1 FROM corner_merge_approvals WHERE corner_id=$1', [cornerId])).rowCount).toBe(0);
    expect(await reasons(cornerId, A)).not.toContain('corner_land');
  });

  it('without a reviewer, a hold prevents landing until it is released', async () => {
    const cornerId = await noBrief();
    await rootFixture.phone.execute('updateRoom', { roomId: R, reviewerAgentId: null }, H);
    const phone = new PhoneService(rootFixture.db, 'http://test', rootFixture.github);
    const hold = await phone.execute('setCornerHold', { cornerId }, H);
    await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=jsonb_set(lifecycle,'{checks}','"pending"') WHERE corner_id=$1`, [cornerId]);
    await checksGreen(cornerId);
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
    await phone.execute('setCornerHold', { cornerId, releaseHoldId: hold.holdId }, H);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it('a configured reviewer still needs to approve the exact head; a stored owner yes cannot substitute', async () => {
    const cornerId = await noBrief();
    await rootFixture.db.query(`INSERT INTO corner_merge_approvals(corner_id,approved_by,pull_request_number,head_sha)
      VALUES($1,$2,7,$3)`, [cornerId, H, SHA]);
    expect(await rootFixture.github.prChecksStatus({ cornerId })).toMatchObject({ stage: 'checking', approved: false, mergeAllowed: false });
    await checksGreen(cornerId);
    expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
    await wireLanding().execute('approveCornerMerge', { cornerId, headSha: SHA }, B);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it('a legacy corner without machine state still attempts a refused head only once', async () => {
    const cornerId = await noBrief();
    await approve(cornerId);
    await rootFixture.db.query('UPDATE corner_facts SET machine=NULL WHERE corner_id=$1', [cornerId]);
    rootFixture.githubApp.mergePullRequest.mockRejectedValue(new Error('provider refused the merge'));
    await rootFixture.github.landCorner(cornerId);
    await rootFixture.github.landCorner(cornerId);
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it('does not merge into a different repository linked during the live gate read', async () => {
    const cornerId = await noBrief();
    await approve(cornerId);
    await rootFixture.db.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
      VALUES(102,77,'owner/other','main')`);
    rootFixture.githubApp.readCommitCheckRollup.mockImplementationOnce(async () => {
      await rootFixture.db.query(`UPDATE rooms SET repository_key='owner/other',repository_remote='https://github.com/owner/other.git' WHERE id=$1`, [R]);
      return { state: 'passed', total: 1, failing: [], checks: [{ name: 'typecheck', status: 'passed' }] };
    });
    try {
      expect(await rootFixture.github.landCorner(cornerId)).toBe(false);
      expect(rootFixture.githubApp.mergePullRequest).not.toHaveBeenCalled();
    } finally {
      await rootFixture.db.query(`UPDATE rooms SET repository_key='owner/widgets',repository_remote='https://github.com/owner/widgets.git' WHERE id=$1`, [R]);
    }
  });

  it('any reachable agent can call merge_thread through the same gate', async () => {
    const cornerId = await noBrief();
    await approve(cornerId);
    await expect(wireLanding().execute('mergeCorner', { cornerId }, B)).resolves.toMatchObject({ status: 'merge-started' });
    expect(rootFixture.githubApp.mergePullRequest).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { GitHubAppClient, GitHubHttpError, GitHubOAuthClient } from '@beeline/auth/github';
import { GitHubOperations } from './github-operations.js';
import { fixtureScope1, HUMAN, REVIEWER } from './test-support-github-operations.test-support.js';
import { insertCornerFacts, seedCornerOpening } from './test-support.js';

describe('linked PR access failures', () => {
  const scope = fixtureScope1();

  it.each(['checks event', 'mergeability', 'explicit read'])(
    'keeps the association and review target after a 404 on %s', async path => {
      const { corners, headSha, app, payload } = await scope.checksFixture();
      const corner = corners[0]!;
      await scope.database.query(`UPDATE corner_facts SET machine=$2::jsonb WHERE corner_id=$1`,
        [corner, JSON.stringify({ state: 'review', headSha, pullRequest: 1 })]);
      const unavailable = new GitHubHttpError('GitHub pull request', 404);
      app.readPullRequest.mockRejectedValue(unavailable);
      const operations = new GitHubOperations(scope.database, {} as GitHubOAuthClient,
        app as unknown as GitHubAppClient, 'secret');
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const refresh = () => path === 'checks event' ? operations.processWebhook('check_run', payload)
          : path === 'mergeability' ? operations.refreshStaleMergeability(corner)
          : operations.prChecksStatus({ cornerId: corner });
        if (path === 'mergeability') await refresh();
        else await expect(refresh()).rejects.toBe(unavailable);
        expect((await operations.lifecycle(corner)).pr).toMatchObject({ number: 1, headSha });
        expect((await scope.database.query(`SELECT machine->'pullRequest' pr FROM corner_facts WHERE corner_id=$1`,
          [corner])).rows[0].pr).toBe(1);
        expect((await scope.database.query(`SELECT archived_at FROM rooms WHERE id=$1`,
          [corner])).rows[0].archived_at).toBeNull();
        expect(app.mergePullRequest).not.toHaveBeenCalled();
        // An explicit later event/read can observe restored access. No timer retries it.
        app.readPullRequest.mockResolvedValue({ number: 1, headSha,
          url: 'https://github.com/owner/widgets/pull/1', mergeability: 'clean' });
        await refresh();
        expect(app.readPullRequest).toHaveBeenCalledTimes(2);
      } finally { error.mockRestore(); }
    });

  it('AVATAR-PR-LINK: an external PR open and edit survive App 404s, then checks wake the thread reviewer', async () => {
    const { room, headSha, app } = await scope.checksFixture(0);
    const corner = '7253d3e7-2617-43a5-8723-58110d3ca282';
    const branch = 'feature/corner-7253d3e72617';
    const repository = 'Beeline-Work/beeline';
    const url = 'https://github.com/Beeline-Work/beeline/pull/4521';
    const worker = 'c'.repeat(64);
    await scope.database.query(`UPDATE github_repositories SET full_name=$1 WHERE repository_id=101`, [repository]);
    await scope.database.query(`UPDATE rooms SET repository_key='github:1327312394',
      repository_remote=$2 WHERE id=$1`, [room, `git://github.com/${repository}`]);
    await scope.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Jellybean')`, [worker]);
    await scope.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [worker, HUMAN]);
    await scope.database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      SELECT workspace_id,id,$2,'member' FROM rooms WHERE id=$1`, [room, worker]);
    await scope.database.query(`INSERT INTO rooms(id,workspace_id,parent_id,created_by,name)
      SELECT $1,workspace_id,id,$3,'avatar-background-color' FROM rooms WHERE id=$2`, [corner, room, worker]);
    await insertCornerFacts(scope.database, { cornerId: corner, lifecycle: JSON.stringify({ checks: 'unknown' }) });
    await seedCornerOpening(scope.database, { cornerId: corner, agentId: worker });
    const pr = { number: 4521, headSha, url, title: 'Avatar background color',
      headRef: branch, baseRef: 'main', state: 'open' as const, merged: false, mergeability: 'clean' as const };
    app.readPullRequest.mockRejectedValue(new GitHubHttpError('GitHub pull request', 404));
    app.readCommitCheckRollup.mockResolvedValue({ state: 'pending', total: 0, failing: [], checks: [] });
    const operations = new GitHubOperations(scope.database, {} as GitHubOAuthClient,
      app as unknown as GitHubAppClient, 'secret');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const payload = { installation: { id: 77 }, repository: { full_name: repository },
        sender: { login: 'lunchboxfortwo' }, pull_request: { number: pr.number, html_url: url,
          title: pr.title, user: { login: 'lunchboxfortwo' }, mergeable_state: 'unknown',
          head: { ref: branch, sha: headSha, repo: { full_name: repository } }, base: { ref: 'main' } } };
      for (const action of ['opened', 'edited']) {
        await operations.processWebhook('pull_request', { ...payload, action });
        expect((await operations.lifecycle(corner)).pr).toMatchObject({ number: 4521, url, headSha });
      }
      expect((await scope.database.query(`SELECT implementer_agent_id FROM corner_facts WHERE corner_id=$1`,
        [corner])).rows[0].implementer_agent_id).toBe(worker);
      expect((await scope.database.query(`SELECT 1 FROM agent_commands WHERE review_context IS NOT NULL`,
        [])).rows).toEqual([]);
      app.readPullRequest.mockResolvedValue(pr);
      app.readCommitCheckRollup.mockResolvedValue({ state: 'passed', total: 1, failing: [],
        checks: [{ name: 'TYPECHECK', status: 'passed' }] });
      const check = { installation: { id: 77 }, repository: { full_name: repository },
        check_run: { name: 'TYPECHECK', status: 'completed', conclusion: 'success', head_sha: headSha,
          check_suite: { head_branch: branch, head_sha: headSha } } };
      await operations.processWebhook('check_run', check);
      await operations.processWebhook('check_run', check);
      const requests = await scope.database.query(`SELECT room_id,agent_id,review_context FROM agent_commands
        WHERE review_context->>'headSha'=$1`, [headSha]);
      expect(requests.rows).toEqual([expect.objectContaining({ room_id: corner, agent_id: REVIEWER,
        review_context: expect.objectContaining({ cornerId: corner, pullRequest: 4521, headSha }) })]);
      expect((await scope.database.query(`SELECT 1 FROM agent_commands WHERE room_id=$1`, [room])).rows).toEqual([]);
      expect(app.mergePullRequest).not.toHaveBeenCalled();
    } finally { error.mockRestore(); }
  });
});

import { it, expect, vi } from 'vitest';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { GitHubOperations } from './github-operations.js';
import { open, worker, authority, commands, claim, rootFixture, RUBY, WORKER, HUMAN } from './test-support-commander.integration.test-support.js';

it.each(['blocked', 'failed', 'done', 'done-unregistered'] as const)('Reproduction R1: GitHub 404 does not block posts, %s reports or orders', async scenario => {
  const status = scenario === 'done-unregistered' ? 'done' : scenario;
  const opened = await open(), turn = await worker(opened.cornerId);
  await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
    [opened.cornerId, JSON.stringify({ checks: 'unknown', pr: { number: 4301, headSha: 'a'.repeat(40) } })]);
  const unavailable = vi.fn(async () => { throw new Error('GitHub PR checks GET /repos/acme/repo/pulls/4301 failed: HTTP 404'); });
  const previous = rootFixture.daemon.github;
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const github = new GitHubOperations(rootFixture.db, {} as GitHubOAuthClient,
    { readPullRequest: unavailable, openPullRequestsForBranch: unavailable } as unknown as GitHubAppClient, 'test-secret');
  vi.spyOn(github, 'roomWorkflowTarget').mockResolvedValue({ token: 'fixture-token', repository: 'acme/repo' } as Awaited<ReturnType<typeof github.roomWorkflowTarget>>);
  // Also cover the done-report repair failing before it can register a PR.
  if (scenario !== 'done-unregistered')
    vi.spyOn(github, 'resolveUnregisteredCornerPullRequest').mockImplementation(unavailable);
  Object.assign(rootFixture.daemon, { github });
  try {
    // The same user path can exercise the compiled service for local proof.
    const builtModule = '../dist/daemon/execute.js';
    const execute: typeof rootFixture.daemon.execute = process.env.BEELINE_PROVE_BUILT_DELIVERY
      ? (await import(/* @vite-ignore */ builtModule)).daemonExecute.bind(null, rootFixture.daemon)
      : rootFixture.daemon.execute.bind(rootFixture.daemon);
    const posted = await execute('postCornerMessage', { ...authority(turn), cornerId: opened.cornerId, text: 'GitHub is unavailable; work continues.' }, WORKER);
    expect((await rootFixture.phone.readRoom(opened.cornerId, HUMAN))?.messages.some(message => message.id === posted.id)).toBe(true);
    if (scenario === 'done-unregistered') {
      await rootFixture.db.query(`UPDATE corner_github_cache SET lifecycle=lifecycle-'pr' WHERE corner_id=$1`, [opened.cornerId]);
      await rootFixture.db.query(`UPDATE corner_brief_revisions SET approval_basis=approval_basis || '{"repositoryWork":true}'::jsonb WHERE corner_id=$1`, [opened.cornerId]);
    }
    await execute('report', { ...authority(turn), status, text: `${status}: GitHub is unavailable` }, WORKER);
    const report = (await commands(opened.cornerId, RUBY)).find(command => command.reason === 'report')!;
    expect(report.source.body).toBe(`${status}: GitHub is unavailable`);
    await claim(report);
    await execute('order', { ...authority(report), address: opened.cornerId, text: 'Continue with local proof' }, RUBY);
    expect((await commands(opened.cornerId, WORKER)).find(command => command.reason === 'order')?.source.body).toBe('Continue with local proof');
    expect(unavailable).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  } finally {
    Object.assign(rootFixture.daemon, { github: previous });
    warning.mockRestore();
  }
});

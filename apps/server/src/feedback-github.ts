import { GitHubHttpError, type GitHubAppClient } from '@beeline/auth/github';
import type { SqlDatabase } from './database.js';
import type { FeedbackPullRequests } from './feedback.js';

/**
 * The GitHub reads the feedback loop makes: whether a fix pull request in the
 * configured repository merged, and whether a release commit contains that
 * merge. Installation tokens are downgraded to read access on that one
 * repository, which must already be in the Beeline GitHub App's catalog.
 */
export class FeedbackGitHub implements FeedbackPullRequests {
  constructor(
    private readonly database: SqlDatabase,
    private readonly app: GitHubAppClient,
  ) {}

  private async token(repository: string, permissions: Record<string, 'read'>) {
    const installed = (
      await this.database.query<{
        installation_id: string;
        repository_id: string;
        full_name: string;
      }>(
        `SELECT installation_id,repository_id,full_name FROM github_repositories
         WHERE lower(full_name)=lower($1) AND active LIMIT 1`,
        [repository],
      )
    ).rows[0];
    if (!installed) throw new Error(`${repository} is not installed for the Beeline GitHub App`);
    const token = await this.app.installationToken(Number(installed.installation_id), {
      repositoryIds: [Number(installed.repository_id)],
      permissions,
    });
    return { token: token.token, fullName: installed.full_name };
  }

  async merged(repository: string, number: number): Promise<boolean> {
    const { token, fullName } = await this.token(repository, { pull_requests: 'read' });
    try {
      return (await this.app.readPullRequest(token, fullName, number)).merged;
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) return false;
      throw error;
    }
  }

  async shipped(repository: string, number: number, sha: string): Promise<boolean> {
    const { token, fullName } = await this.token(repository, {
      pull_requests: 'read',
      contents: 'read',
    });
    try {
      const pull = await this.app.readPullRequest(token, fullName, number);
      if (!pull.merged || !pull.mergeCommitSha) return false;
      // `ahead` or `identical`: the merge commit is an ancestor of the release.
      const comparison = await this.app.readRepositoryJson(
        token,
        fullName,
        `compare/${encodeURIComponent(pull.mergeCommitSha)}...${encodeURIComponent(sha)}?per_page=1`,
      );
      return comparison.status === 'ahead' || comparison.status === 'identical';
    } catch (error) {
      if (error instanceof GitHubHttpError && (error.status === 404 || error.status === 422))
        return false;
      throw error;
    }
  }
}

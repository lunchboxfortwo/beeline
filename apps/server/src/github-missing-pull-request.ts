import { GitHubHttpError } from '@beeline/auth/github';
import type { GitHubOperations } from './github-operations.js';
import type { SqlDatabase } from './database.js';

/** Only a PR read's 404 retires that association; missing jobs/commits do not. */
export async function readRecordedPullRequest(
  ctx: GitHubOperations, cornerId: string, token: string, repository: string,
  number: number, database: SqlDatabase = ctx.database,
) {
  try { return await ctx.app.readPullRequest(token, repository, number); }
  catch (error) {
    if (!(error instanceof GitHubHttpError) || error.status !== 404) throw error;
    // The conditional removal fences concurrent heads and gives one observer
    // the log, including across server instances and subsequent webhooks.
    if (await ctx.recordClosedCornerPullRequest(cornerId, number, database))
      console.warn('[github] stopped refreshing unavailable pull request', { cornerId, repository, number });
    return undefined;
  }
}

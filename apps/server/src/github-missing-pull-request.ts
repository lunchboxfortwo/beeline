import { forgetCornerPullRequest } from './github-operations-read-pr-checks-status.js';
import { advanceCorner, lockCornerLifecycle } from './corner-lifecycle.js';
import { GitHubHttpError } from '@beeline/auth/github';
import type { GitHubOperations } from './github-operations.js';
import type { SqlDatabase } from './database.js';

/** A PR read's 404 forgets its association without claiming GitHub confirmed a close. */
export async function readRecordedPullRequest(
  ctx: GitHubOperations, cornerId: string, token: string, repository: string,
  number: number, database: SqlDatabase = ctx.database,
) {
  try { return await ctx.app.readPullRequest(token, repository, number); }
  catch (error) {
    if (!(error instanceof GitHubHttpError) || error.status !== 404) throw error;
    // The conditional removal fences concurrent heads and gives one observer
    // the log, including across server instances and subsequent webhooks.
    if (await database.transaction(async db => {
      await lockCornerLifecycle(db, cornerId);
      const removed = await forgetCornerPullRequest(db, cornerId, number);
      if (removed && !removed.archived) await advanceCorner(db, cornerId, { kind: 'reconcile' });
      return Boolean(removed);
    }))
      console.warn('[github] stopped refreshing unavailable pull request', { cornerId, repository, number });
    return undefined;
  }
}

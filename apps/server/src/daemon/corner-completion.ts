import { cornerReviewerSql } from '../corner-reviewer.js';
import { cornerImplementerSql } from '../corner-worker.js';
import { advanceCorner, lockCornerLifecycle } from '../corner-lifecycle.js';
import { cornerLifecycleSql, writeCornerGithubCache } from '../corner-github-cache.js';
import type { DaemonContext } from './context.js';
import { Output } from './values.js';



  /**
   * A repository with no checks emits no check webhook, so its review
   * otherwise waits forever. Resolve that absence only after the
   * worker has finished its PR turn; at PR-open time the same empty rollup is
   * merely a race with GitHub registering workflows. Require independent
   * registration evidence even at worker completion. Completion uses the
   * registered PR, regardless of whether the worker's reply contains its URL.
   */
  export async function daemonReconcileZeroCheckWorkerCompletion(ctx: DaemonContext,
    cornerId: string,
    workerAgentId: string,
  ): Promise<void> {
    if (!ctx.prChecksStatus) return;
    const candidate = (
      await ctx.database.query<{
        reviewer_agent_id: string | null;
        owner_agent_id: string;
      }>(
        `SELECT ${cornerReviewerSql()} reviewer_agent_id,${cornerImplementerSql('fact', 'corner')} owner_agent_id
         FROM rooms corner
         JOIN rooms parent ON parent.id=corner.parent_id
         JOIN corner_facts fact ON fact.corner_id=corner.id
         WHERE corner.id=$1 AND (${cornerReviewerSql()} IS NULL OR ${cornerReviewerSql()}<>$2)
           AND ${cornerImplementerSql('fact', 'corner')}=$2
           AND ${cornerLifecycleSql('fact.corner_id')} ? 'pr'`,
        [cornerId, workerAgentId],
      )
    ).rows[0];
    if (!candidate) return;

    const fetchStartedAt = (await ctx.database.query<{ now: number }>(
      `SELECT extract(epoch FROM clock_timestamp())::double precision now`,
    )).rows[0]!.now;
    let verdict: Output<'getPrChecksStatus'> & { zeroChecksConfirmed?: boolean };
    try {
      verdict = await ctx.prChecksStatus({ cornerId }, true);
    } catch (error) {
      console.error(`[server] zero-check completion read failed for thread ${cornerId}:`, error);
      return;
    }
    if (verdict.checks !== 'pending' || verdict.checkCount !== 0 || !verdict.zeroChecksConfirmed) return;
    const advanced = await ctx.database.transaction(async (db) => {
      await lockCornerLifecycle(db, cornerId);
      const current = (
        await db.query<{
          reviewer_agent_id: string | null;
          owner_agent_id: string;
          lifecycle: import('@beeline/api-contract/phone').CornerLifecycleView;
        }>(
          `SELECT ${cornerReviewerSql()} reviewer_agent_id,${cornerImplementerSql('fact', 'corner')} owner_agent_id,gh.lifecycle
           FROM rooms corner
           JOIN rooms parent ON parent.id=corner.parent_id
           JOIN corner_facts fact ON fact.corner_id=corner.id
           JOIN corner_github_cache gh ON gh.corner_id=corner.id
           WHERE corner.id=$1 FOR UPDATE OF gh,fact`,
          [cornerId],
        )
      ).rows[0];
      if (
        !current ||
        current.owner_agent_id !== workerAgentId ||
        current.reviewer_agent_id !== candidate.reviewer_agent_id ||
        current.lifecycle.pr?.headSha !== verdict.headSha ||
        (current.lifecycle.checksSummary?.total ?? 0) > 0 ||
        ((current.lifecycle.checksSummary as { fetchStartedAt?: number } | undefined)?.fetchStartedAt ??
          current.lifecycle.checksSummary?.updatedAt ?? 0) > fetchStartedAt ||
        current.lifecycle.checks === 'passing'
      )
        return;
      const lifecycle = {
        ...current.lifecycle,
        checks: 'passing' as const,
        checksSummary: {
          status: 'passing' as const,
          total: 0,
          failing: [],
          checks: [],
          updatedAt: Math.floor((await db.query<{ now: number }>(`SELECT extract(epoch FROM clock_timestamp())::double precision now`)).rows[0]!.now),
          fetchStartedAt,
        },
      };
      await writeCornerGithubCache(db, cornerId, lifecycle);
      return advanceCorner(db, cornerId, { kind: 'checks', result: 'passing' });
    });
    if (advanced?.land && ctx.landCorner) {
      const land = async () => { await ctx.landCorner!(cornerId); };
      if (ctx.afterCommit) ctx.afterCommit(land);
      else await land();
    }
  }

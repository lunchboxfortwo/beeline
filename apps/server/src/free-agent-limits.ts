import type { SqlDatabase } from './database.js';

export const DEFAULT_FREE_AGENT_DAILY_TOKENS = 3_000_000;

/** A person's allowance during their first 24 hours, so day one does not run out. */
export const DEFAULT_FREE_AGENT_FIRST_DAY_TOKENS = 10_000_000;

export function freeAgentDailyTokenCapFromEnv(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.BEELINE_FREE_AGENT_DAILY_TOKENS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_FREE_AGENT_DAILY_TOKENS;
}

/** First-24h allowance; always at least the daily cap. */
export function freeAgentFirstDayTokenCapFromEnv(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.BEELINE_FREE_AGENT_FIRST_DAY_TOKENS);
  const daily = freeAgentDailyTokenCapFromEnv(env);
  const firstDay = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_FREE_AGENT_FIRST_DAY_TOKENS;
  return Math.max(firstDay, daily);
}

/**
 * The owner's token cap at `now`: the larger first-24h allowance until 24 hours
 * after their first model call settles, then the daily cap. An owner with no
 * model call yet is in their first day.
 */
export async function freeAgentTokenCapAt(
  db: Pick<SqlDatabase, 'query'>,
  ownerId: string,
  now: Date,
  caps: { dailyTokenCap: number; firstDayTokenCap: number },
): Promise<number> {
  const row = (await db.query<{ first_at: Date | string | null }>(
    `SELECT MIN(e.at) first_at FROM free_agent_events e JOIN free_agents f ON f.agent_id=e.agent_id
     WHERE f.owner_id=$1 AND e.kind='model_usage'`,
    [ownerId],
  )).rows[0];
  const firstAt = row?.first_at ? new Date(row.first_at).getTime() : undefined;
  const firstDay = firstAt === undefined || now.getTime() < firstAt + 24 * 60 * 60_000;
  return firstDay ? Math.max(caps.dailyTokenCap, caps.firstDayTokenCap) : caps.dailyTokenCap;
}

export interface FreeAgentLimits {
  cachedTokenWeight: number;
  dailyBudgetUsd: number;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  /** Largest reply a call may ask the upstream for, whatever the harness requests. */
  maxOutputTokens: number;
}

export const DEFAULT_FREE_AGENT_LIMITS: FreeAgentLimits = {
  cachedTokenWeight: 0.25,
  dailyBudgetUsd: 25,
  // Conservative fallback prices; operators must update these when changing models.
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 5,
  maxOutputTokens: 32_768,
};

export function freeAgentLimitsFromEnv(env: NodeJS.ProcessEnv): FreeAgentLimits {
  const positive = (name: string, fallback: number) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    cachedTokenWeight: Math.min(0.25, Math.max(0.1, positive('BEELINE_FREE_AGENT_CACHED_TOKEN_WEIGHT', 0.25))),
    dailyBudgetUsd: positive('BEELINE_FREE_AGENT_DAILY_BUDGET_USD', 25),
    inputUsdPerMillion: positive('BEELINE_FREE_AGENT_INPUT_USD_PER_MILLION', 1),
    outputUsdPerMillion: positive('BEELINE_FREE_AGENT_OUTPUT_USD_PER_MILLION', 5),
    maxOutputTokens: Math.max(1, Math.floor(positive('BEELINE_FREE_AGENT_MAX_OUTPUT_TOKENS', 32_768))),
  };
}

export const FREE_AGENT_BUDGET_MESSAGE = "I've reached today's shared free-agent budget, so I have to pause until midnight UTC. To continue now, connect your own agent in Members → Add agent.";

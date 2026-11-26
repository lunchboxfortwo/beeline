import type { SqlDatabase } from './database.js';
import { OwnerScheduleClock } from './owner-schedule-clock.js';

const WEBHOOK_CLAIM_LEASE_MS = 120_000;
const WEBHOOK_CLAIM_RENEW_MS = 30_000;
const WEBHOOK_CLAIM_RENEW_RETRY_MS = 5_000;
const WEBHOOK_CLAIM_EXPIRY_GUARD_MS = 10_000;

let webhookWritesSincePrune = 0;

export interface GitHubWebhookClaim {
  readonly signal: AbortSignal;
  assertActive(): void;
  assertOwned(db: SqlDatabase): Promise<void>;
}

/**
 * Claims a GitHub webhook delivery in the database with a renewable lease, a
 * pre-expiry abort guard, and transactional write fencing. Concurrent or
 * redelivered webhooks across server instances stay exclusive while the handler
 * runs, and a stalled renewal aborts the owning handler and fences its writes
 * before another server can reclaim the delivery.
 */
export async function runClaimedGitHubWebhook(
  database: SqlDatabase,
  delivery: string,
  run: (claim: GitHubWebhookClaim) => Promise<void>,
): Promise<'accepted' | 'duplicate'> {
  const claimStartedAt = Date.now();
  const claimed = await database.query<{ received_at: string; claim_expires_at: string }>(
    `INSERT INTO github_webhook_deliveries(delivery_id,received_at,claim_expires_at)
     VALUES($1,clock_timestamp(),clock_timestamp()+interval '2 minutes')
     ON CONFLICT (delivery_id) DO UPDATE
       SET received_at=GREATEST(clock_timestamp(),github_webhook_deliveries.received_at+interval '1 microsecond'),
           claim_expires_at=clock_timestamp()+interval '2 minutes'
       WHERE github_webhook_deliveries.claim_expires_at IS NOT NULL
         AND github_webhook_deliveries.claim_expires_at<=clock_timestamp()
     RETURNING received_at::text received_at, claim_expires_at::text claim_expires_at`,
    [delivery],
  );
  const claimOwnerAt = claimed.rows[0]?.received_at;
  const initialToken = claimed.rows[0]?.claim_expires_at;
  if (!claimOwnerAt || !initialToken) return 'duplicate';
  let claimToken = initialToken;

  let handlerAlive = true;
  let claimLost = false;
  const claimAbort = new AbortController();
  let rejectOnClaimLoss!: (error: Error) => void;
  const claimLossPromise = new Promise<never>((_, reject) => {
    rejectOnClaimLoss = reject;
  });
  claimLossPromise.catch(() => undefined);

  const releaseClaimToken = (token: string) =>
    database
      .query(
        `DELETE FROM github_webhook_deliveries
         WHERE delivery_id=$1 AND received_at=$2::timestamptz AND claim_expires_at=$3::timestamptz`,
        [delivery, claimOwnerAt, token],
      )
      .catch(() => undefined);

  let renewWrite: Promise<void> = Promise.resolve();
  const loseClaim = (reason: string) => {
    if (claimLost) return;
    claimLost = true;
    handlerAlive = false;
    renewClock.stop();
    expiryClock.stop();
    const error = new Error(reason);
    claimAbort.abort(error);
    rejectOnClaimLoss(error);
  };

  const claimError = () =>
    claimAbort.signal.reason instanceof Error
      ? claimAbort.signal.reason
      : new Error('GitHub webhook delivery claim expired');

  const assertActive = () => {
    if (claimLost || claimAbort.signal.aborted) throw claimError();
  };

  const assertOwned = async (db: SqlDatabase): Promise<void> => {
    assertActive();
    const owned = await db.query(
      `SELECT 1 FROM github_webhook_deliveries
       WHERE delivery_id=$1
         AND received_at=$2::timestamptz
         AND claim_expires_at IS NOT NULL
         AND claim_expires_at>clock_timestamp()
       FOR SHARE`,
      [delivery, claimOwnerAt],
    );
    if (!owned.rowCount) {
      loseClaim('GitHub webhook delivery claim was lost');
      throw claimError();
    }
    assertActive();
  };

  const claim: GitHubWebhookClaim = {
    signal: claimAbort.signal,
    assertActive,
    assertOwned,
  };

  const expiryClock = new OwnerScheduleClock(() => {
    loseClaim('GitHub webhook delivery claim expired before renewal completed');
  });
  const armExpiryGuard = (leaseStartedAt: number) => {
    const remaining =
      leaseStartedAt + WEBHOOK_CLAIM_LEASE_MS - WEBHOOK_CLAIM_EXPIRY_GUARD_MS - Date.now();
    if (remaining <= 0) {
      loseClaim('GitHub webhook delivery claim expired before renewal completed');
      return;
    }
    expiryClock.arm(remaining);
  };

  const renewClock = new OwnerScheduleClock(() => {
    if (!handlerAlive || claimLost || !claimToken) return;
    const expectedToken = claimToken;
    const renewStartedAt = Date.now();
    renewWrite = renewWrite.then(async () => {
      if (!handlerAlive || claimLost || claimToken !== expectedToken) return;
      try {
        const renewed = await database.query<{ claim_expires_at: string }>(
          `UPDATE github_webhook_deliveries
           SET claim_expires_at=clock_timestamp()+interval '2 minutes'
           WHERE delivery_id=$1 AND received_at=$2::timestamptz AND claim_expires_at=$3::timestamptz
           RETURNING claim_expires_at::text claim_expires_at`,
          [delivery, claimOwnerAt, expectedToken],
        );
        const nextToken = renewed.rows[0]?.claim_expires_at;
        if (!nextToken) {
          loseClaim('GitHub webhook delivery claim was lost');
          return;
        }
        if (claimLost) {
          void releaseClaimToken(nextToken);
          return;
        }
        claimToken = nextToken;
        if (handlerAlive) {
          armExpiryGuard(renewStartedAt);
          if (!claimLost) renewClock.arm(WEBHOOK_CLAIM_RENEW_MS);
        }
      } catch (error) {
        console.warn('[github-webhook] delivery claim renewal failed', error);
        if (handlerAlive && !claimLost) renewClock.arm(WEBHOOK_CLAIM_RENEW_RETRY_MS);
      }
    });
  });

  armExpiryGuard(claimStartedAt);
  if (!claimLost) renewClock.arm(WEBHOOK_CLAIM_RENEW_MS);

  let handlerSettled = false;
  let handlerPromise: Promise<void> = Promise.resolve();
  try {
    if (claimLost) throw claimAbort.signal.reason;
    handlerPromise = Promise.resolve(run(claim)).finally(() => {
      handlerSettled = true;
    });
    handlerPromise.catch(() => undefined);
    try {
      await Promise.race([handlerPromise, claimLossPromise]);
    } finally {
      handlerAlive = false;
      renewClock.stop();
    }
    await Promise.race([renewWrite, claimLossPromise]);
    expiryClock.stop();
    if (claimLost) throw claimAbort.signal.reason;
    const completed = await database.query(
      `UPDATE github_webhook_deliveries
       SET claim_expires_at=NULL
       WHERE delivery_id=$1 AND received_at=$2::timestamptz AND claim_expires_at=$3::timestamptz`,
      [delivery, claimOwnerAt, claimToken],
    );
    if (!completed.rowCount) {
      throw new Error('GitHub webhook delivery claim was lost before completion');
    }
  } catch (error) {
    expiryClock.stop();
    if (!claimLost) {
      await releaseClaimToken(claimToken);
    } else {
      await Promise.race([
        handlerPromise.catch(() => undefined),
        Promise.resolve().then(() => Promise.resolve()),
      ]);
      if (handlerSettled) {
        await releaseClaimToken(claimToken);
      } else {
        void handlerPromise
          .then(() => undefined, () => undefined)
          .then(() => releaseClaimToken(claimToken));
      }
    }
    throw error;
  }

  if (++webhookWritesSincePrune % 64 === 1) {
    try {
      await database.query(
        `DELETE FROM github_webhook_deliveries delivery
         WHERE delivery.delivery_id IN (
           SELECT delivery_id FROM github_webhook_deliveries
           WHERE received_at<now()-interval '30 days'
           ORDER BY received_at,delivery_id LIMIT 1024 FOR UPDATE SKIP LOCKED)`,
      );
    } catch (error) {
      console.warn('[github-webhook] retention prune failed', error);
    }
  }
  return 'accepted';
}

import type { SqlDatabase } from '../database.js';
import { savedScheduleCommand, verifiedScheduleCommand } from '../scheduled-command-authority.js';
import { SENTRY_TRIAGE_ROOM } from '../sentry-wake-source.js';

/** The owner approved retaining this recorded Sentry request as the standing
 * digest definition. Never infer authority from the recipient's current owner. */
export async function seedSentryDigestAuthority(db: SqlDatabase): Promise<void> {
  const agentId = '7eafb2e0cc049a9b3345f4322024b604358af04cb551d1fc71084ca3a99d7877';
  const command = await savedScheduleCommand(db,
    'd2b76f066b956e94428a559e5510339637fe235a5e2d39874c4974121e60e89b', SENTRY_TRIAGE_ROOM, agentId);
  if (!command) return; // Other installations do not contain this definition.
  const verified = await verifiedScheduleCommand(db, SENTRY_TRIAGE_ROOM, agentId, command.turn_request_id);
  if (!verified) throw new Error('standing Sentry digest request has no verified authority');
  await db.query(`UPDATE sentry_wake_state SET requester_command_id=$1
    WHERE singleton AND requester_command_id IS NULL`, [verified.id]);
}

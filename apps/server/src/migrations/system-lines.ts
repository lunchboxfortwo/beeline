import { SCHEDULE_RAN_VERB } from '@beeline/api-contract/scheduled-prompts';
import { boundedMigrationUpdate } from '../database-backfill-squire-approval-expiry.js';
import type { SqlDatabase } from '../database.js';

/** Retire historical human-facing browser observations without losing agent context. */
export async function backfillComputerObservations(database: SqlDatabase): Promise<void> {
  // Old viewer lines remain agent context, but never return in phone history.
  await database.query(`UPDATE messages SET presentation='activity',durable_fact=NULL,
      text=replace(text,'A person','Shared browser'),
      system_event=jsonb_set(system_event,'{subject,name}',
        to_jsonb(replace(system_event->'subject'->>'name','A person','Shared browser')))
    WHERE system_event->>'kind'='computer-session-activity'`);

}

/**
 * Scheduled-prompt lines predate the `kind` beside their verb. They are the one
 * shape a live subscriber can already be waiting on, so they are stamped; older
 * join/corner/check lines get nothing, because no subscriber can want an event
 * that already happened. Idempotent through the `IS NULL` guard.
 */
export async function backfillSystemEventKinds(database: SqlDatabase): Promise<void> {
  await boundedMigrationUpdate(database, 'system event kinds',
    `UPDATE messages SET system_event = system_event || jsonb_build_object('kind','schedule-ran')
     WHERE id IN (SELECT id FROM messages WHERE system_event->>'verb'=$1
       AND system_event->>'kind' IS NULL ORDER BY id LIMIT $2)`,
    [SCHEDULE_RAN_VERB],
  );
}

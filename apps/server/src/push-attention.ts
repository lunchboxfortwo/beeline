import { addressedToPersonSql } from './corner-owed.js';

/** Shared direct-attention policy for enqueue filtering and delivery. */
export function pushDirectAttentionSql(): string {
  return `(
    (room.direct_participants IS NOT NULL AND (m.presentation='message' OR m.card_type IS NULL OR m.card_type='grant-request'))
    -- A permission request reaches the person who decides it, in any Room.
    OR (m.card_type='grant-request' AND m.card->'owner'->>'pubkey'=recipient.id)
    OR (m.card_type='away-warning' AND m.card->>'ownerId'=recipient.id)
    OR (m.card_type='machine-offline' AND m.card->>'status'='open'
      AND m.card->>'ownerId'=recipient.id)
    OR (m.card_type='work-assignment' AND m.card->>'assigneeId'=recipient.id)
    OR ${addressedToPersonSql('m', 'recipient.id', 'recipient.handle', 'recipient.kind', false)}
  )`;
}

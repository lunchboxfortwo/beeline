import type { SqlDatabase } from './database.js';

export const MAX_REPLY_STEPS = 2_000;

export const MAX_REPLY_NOTE_LENGTH = 16_000;

/** The whole stored steps payload; a note longer than one row spans several. */
export const MAX_REPLY_STEPS_BYTES = 4_000_000;

/**
 * A reply's steps (`PostRoomMessageInput.steps`) as the JSON its `activity`
 * column stores, or null when it has none. Only tool rows and notes belong
 * there; anything else is refused rather than stored.
 */
export function replySteps(steps: unknown): string | null {
  if (steps === undefined) return null;
  if (!Array.isArray(steps) || steps.length > MAX_REPLY_STEPS)
    throw new Error('reply steps are invalid');
  for (const step of steps as Record<string, unknown>[]) {
    if (!step || typeof step !== 'object') throw new Error('reply steps are invalid');
    if (step.kind !== 'tool' && step.kind !== 'note') throw new Error('reply steps are invalid');
    if (typeof step.title !== 'string' || step.title.length > 240)
      throw new Error('reply steps are invalid');
    if (step.kind === 'note' &&
      (typeof step.text !== 'string' || !step.text || step.text.length > MAX_REPLY_NOTE_LENGTH))
      throw new Error('reply steps are invalid');
    if (step.continues !== undefined && (step.kind !== 'note' || step.continues !== true))
      throw new Error('reply steps are invalid');
  }
  const json = JSON.stringify(steps);
  if (Buffer.byteLength(json) > MAX_REPLY_STEPS_BYTES) throw new Error('reply steps are invalid');
  return steps.length ? json : null;
}

export async function recordAnswerActivity(db: SqlDatabase, agentId: string, messageId: string,
  input: {steps?:unknown}): Promise<void> {
  if (input.steps) await db.query('UPDATE messages SET activity=$2::jsonb WHERE id=$1 AND author_id=$3',
    [messageId,replySteps(input.steps),agentId]);
}

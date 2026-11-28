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

/**
 * A turn's closing text that was not posted because the agent already replied
 * in the same place. It stays readable in the turn's activity: the turn's
 * steps, then the text as notes.
 */
export async function recordSuppressedFinal(db: SqlDatabase, input: {
  id: string; roomId: string; agentId: string; requestId: string; text: string; steps?: unknown;
}): Promise<void> {
  let steps: unknown[] = [];
  try {
    if (replySteps(input.steps)) steps = input.steps as unknown[];
  } catch {
    // Invalid steps never block the turn; the closing text is still kept.
  }
  const notes = [];
  for (let at = 0; at < input.text.length; at += MAX_REPLY_NOTE_LENGTH)
    notes.push({kind:'note', title:'Note', text:input.text.slice(at, at + MAX_REPLY_NOTE_LENGTH), ...(at ? {continues:true} : {})});
  let activity: string | null;
  try {
    activity = replySteps([...steps, ...notes].slice(-MAX_REPLY_STEPS));
  } catch {
    activity = replySteps(notes.slice(0, MAX_REPLY_STEPS));
  }
  if (!activity) return;
  await db.query(
    `INSERT INTO messages(id,room_id,author_id,text,presentation,request_id,activity,agent_model)
     VALUES($1,$2,$3,'','activity',$4,$5::jsonb,(SELECT selected_model FROM agents WHERE agent_id=$3))
     ON CONFLICT(id) DO NOTHING`,
    [input.id, input.roomId, input.agentId, input.requestId, activity]);
}

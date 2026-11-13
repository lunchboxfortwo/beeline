export const MAX_REPLY_STEPS = 2_000;

export const MAX_REPLY_NOTE_LENGTH = 16_000;

/** The whole stored steps payload; a note longer than one row spans several. */
export const MAX_REPLY_STEPS_BYTES = 4_000_000;

/**
 * A reply's steps (`PostRoomMessageInput.steps`) as the JSON its `activity`
 * column stores, or null when it has none. Only tool rows and notes belong
 * there; anything else is refused rather than stored.
 */
// Reserve internal notes beyond the validated helper payload for closing prose.
export function replySteps(steps: unknown, summaryNotes = 0): string | null {
  if (steps === undefined) return null;
  if (!Array.isArray(steps) || steps.length > MAX_REPLY_STEPS + summaryNotes)
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
  if (Buffer.byteLength(json) > MAX_REPLY_STEPS_BYTES + summaryNotes * 100_000) throw new Error('reply steps are invalid');
  return steps.length ? json : null;
}

/** Closing prose is history after a reply, preserving every character. */
export function closingActivity(text: string, steps: unknown): string | null {
  let history: unknown[] = [];
  try { history = JSON.parse(replySteps(steps) ?? '[]'); } catch { /* Optional tool history cannot erase the closing prose. */ }
  const notes: {kind:'note';title:string;text:string;continues?:true}[] = [];
  let from = 0;
  while (from < text.length) {
    let to = Math.min(from + MAX_REPLY_NOTE_LENGTH, text.length);
    if (to < text.length && /[\uD800-\uDBFF]/.test(text[to - 1]!)) to--;
    notes.push({kind:'note',title:'Turn summary',text:text.slice(from,to),...(from ? {continues:true} : {})});
    from = to;
  }
  return replySteps([...history,...notes], notes.length);
}

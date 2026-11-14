/**
 * Whether each turn prompt section repeats what the same harness session was
 * last sent, so a trace shows which resent sections actually changed.
 *
 *  - one instance per Room or corner turn runner, so Rooms never share it.
 *  - the baseline belongs to ONE session id; a new id, or `reset()` on a cold
 *    activation, starts over and every section reports `no-baseline`.
 *  - only a sha256 of each section is kept, never its text.
 */
export type PromptSectionChange = 'unchanged' | 'changed' | 'no-baseline';

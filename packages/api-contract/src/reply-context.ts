export const REPLY_EXCERPT_MAX_LENGTH = 1500;

/** Keep short parents whole and preserve both the context and the final ask. */
export function boundReplyExcerpt(text: string): string {
  if (text.length <= REPLY_EXCERPT_MAX_LENGTH) return text;
  const half = REPLY_EXCERPT_MAX_LENGTH / 2;
  return `${text.slice(0, half)}…${text.slice(-half)}`;
}

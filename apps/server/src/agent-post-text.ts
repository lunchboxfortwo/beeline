export type AgentPostRepair = { text: string; removed: string[] };

const FENCED_CODE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE = /`[^`\n]*`/g;

/** Code blanked in place so a tag inside an example is not treated as this reply's reasoning. */
function maskCode(text: string): string {
  return text
    .replace(FENCED_CODE, (block) => block.replace(/[^\n]/g, ' '))
    .replace(INLINE_CODE, (span) => ' '.repeat(span.length));
}

/**
 * The first `<think>` or `<thinking>` that never closes. A blank line is not a
 * close: every paragraph after the opening tag is still private. Text before
 * that tag, and text after a real closing tag, is the public reply.
 */
function firstUnclosedThinking(text: string): { index: number; tag: string } | undefined {
  const masked = maskCode(text);
  for (const match of masked.matchAll(/<(think|thinking)>/gi)) {
    const tagName = match[1]!;
    const from = (match.index ?? 0) + match[0].length;
    if (new RegExp(`</${tagName}>`, 'i').test(masked.slice(from))) continue;
    return { index: match.index ?? 0, tag: tagName.toLowerCase() };
  }
  return undefined;
}

/**
 * Drop reasoning blocks. A closed block is removed. An unclosed block is
 * removed through the end of the reply: a paragraph break is not a public
 * boundary. Public text before the unclosed tag stays. Examples in code stay.
 * An unclosed block with no public reply stays empty so the caller can refuse it.
 */
export function repairAgentPost(input: string): AgentPostRepair {
  let text = input.trim();
  const removed: string[] = [];
  for (;;) {
    const opening = /^<(think|thinking)>/i.exec(text);
    if (!opening) break;
    const tagName = opening[1]!;
    const after = text.slice(opening[0].length);
    const closing = new RegExp(`</${tagName}>`, 'i').exec(after);
    if (!closing) break;
    removed.push(`<${tagName.toLowerCase()}> block`);
    text = after.slice(closing.index + closing[0].length).trim();
  }
  const unclosed = firstUnclosedThinking(text);
  if (unclosed) {
    removed.push(`unclosed <${unclosed.tag}> block`);
    text = text.slice(0, unclosed.index).trim();
  }
  return { text, removed };
}

/** Remove only leading inline reasoning blocks, never examples within a reply. */
export function agentPostText(input: string): string {
  return repairAgentPost(input).text;
}

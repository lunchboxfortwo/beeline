/**
 * The brief's spec as plain blocks for the grammar's type styles: the first
 * `#` heading is the title, other headings are headings, list items are
 * bullets, fenced code is code, and consecutive lines are one paragraph.
 * Emphasis markers are dropped; inline code is kept as spans.
 */
export type BriefBlock =
  | { readonly kind: 'title' | 'heading' | 'bullet' | 'paragraph' | 'code'; readonly text: string };

export type BriefSpan = { readonly code: boolean; readonly text: string };

export function briefBlocks(spec: string): BriefBlock[] {
  const blocks: BriefBlock[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;
  let titled = false;
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: plain(paragraph.join(' ')) });
    paragraph = [];
  };
  for (const raw of spec.replace(/\r\n?/g, '\n').split('\n')) {
    if (code) {
      if (/^\s*```/.test(raw)) { blocks.push({ kind: 'code', text: code.join('\n') }); code = null; }
      else code.push(raw);
      continue;
    }
    const line = raw.trim();
    if (/^```/.test(line)) { flush(); code = []; continue; }
    if (!line) { flush(); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const kind = heading[1].length === 1 && !titled ? 'title' : 'heading';
      if (kind === 'title') titled = true;
      blocks.push({ kind, text: plain(heading[2]) });
      continue;
    }
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) { flush(); blocks.push({ kind: 'bullet', text: plain(bullet[1]) }); continue; }
    paragraph.push(line);
  }
  if (code) blocks.push({ kind: 'code', text: code.join('\n') });
  flush();
  return blocks;
}

/** Inline code spans of one block's text. */
export function briefSpans(text: string): BriefSpan[] {
  return text.split('`').map((part, index) => ({ code: index % 2 === 1, text: part })).filter((span) => span.text);
}

function plain(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
}

import type { MarkdownSpan } from "./parseMarkdown";
import { formatInlineMath } from "./parseMath";

// Streaming text may end in the middle of a construct. Match only completed
// delimiters so a later chunk can turn the original plain text into Markdown
// instead of permanently consuming its opening syntax.
const pattern = /(\*\*(.*?)\*\*)|((?<!\*)\*(?!\*)(.*?)\*(?!\*))|(\[([^\]]+)\]\(([^)]+)\))|(`(.*?)`)/g;

// Inline math uses strict closed `\( ... \)` pairs after Markdown constructs
// (code spans, links, emphasis) and bare autolinks are already separated, so
// dollar amounts ($5, $0.15/1M), code spans, and URLs stay untouched.
const inlineMathPattern = /(?<!\\)\\\(((?:(?!(?<!\\)\\\()[^\n])+?)\\\)/g;

function pushTextWithInlineMath(spans: MarkdownSpan[], text: string, styles: MarkdownSpan['styles']) {
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    inlineMathPattern.lastIndex = 0;

    while ((match = inlineMathPattern.exec(text)) !== null) {
        const before = text.slice(lastIndex, match.index);
        if (before) {
            spans.push({ styles, text: before, url: null });
        }
        const rawMath = match[1] ?? '';
        if (rawMath.trim().length > 0) {
            spans.push({ styles: [...styles, 'math'], text: formatInlineMath(rawMath), url: null });
        } else {
            spans.push({ styles, text: match[0], url: null });
        }
        lastIndex = inlineMathPattern.lastIndex;
    }

    if (lastIndex < text.length) {
        spans.push({ styles, text: text.slice(lastIndex), url: null });
    }
}

export function pushTextWithAutoLinks(spans: MarkdownSpan[], text: string, styles: MarkdownSpan['styles']) {
    const urlPattern = /https?:\/\/[^\s<]+|(?<![A-Za-z0-9_/#])#beeline\/[^\s/()<>]+\/[0-9a-f]{64}(?![A-Za-z0-9_/-])/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = urlPattern.exec(text)) !== null) {
        const plainText = text.slice(lastIndex, match.index);
        if (plainText) {
            pushTextWithInlineMath(spans, plainText, styles);
        }

        let url = match[0];
        let trailing = '';
        while (/[),.;:!?]$/.test(url)) {
            trailing = url.slice(-1) + trailing;
            url = url.slice(0, -1);
        }

        if (url) {
            spans.push({ styles, text: url, url });
        }
        if (trailing) {
            spans.push({ styles, text: trailing, url: null });
        }

        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
        pushTextWithInlineMath(spans, text.slice(lastIndex), styles);
    }
}

export function parseMarkdownSpans(markdown: string, header: boolean) {
    const spans: MarkdownSpan[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;

    while ((match = pattern.exec(markdown)) !== null) {
        // Capture the text between the end of the last match and the start of this match as plain text
        const plainText = markdown.slice(lastIndex, match.index);
        if (plainText) {
            pushTextWithAutoLinks(spans, plainText, []);
        }

        if (match[1]) {
            // Bold
            if (header) {
                pushTextWithAutoLinks(spans, match[2], []);
            } else {
                pushTextWithAutoLinks(spans, match[2], ['bold']);
            }
        } else if (match[3]) {
            // Italic
            if (header) {
                pushTextWithAutoLinks(spans, match[4], []);
            } else {
                pushTextWithAutoLinks(spans, match[4], ['italic']);
            }
        } else if (match[5]) {
            // Link - handle incomplete links (no URL part)
            if (match[7]) {
                spans.push({ styles: [], text: match[6], url: match[7] });
            } else {
                // If no URL part, treat as plain text with brackets
                pushTextWithAutoLinks(spans, `[${match[6]}]`, []);
            }
        } else if (match[8]) {
            // Inline code
            spans.push({ styles: ['code'], text: match[9], url: null });
        }

        lastIndex = pattern.lastIndex;
    }

    // If there's any text remaining after the last match, treat it as plain
    if (lastIndex < markdown.length) {
        pushTextWithAutoLinks(spans, markdown.slice(lastIndex), []);
    }

    return spans;
}

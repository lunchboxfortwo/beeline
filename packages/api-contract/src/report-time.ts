// A named zone carries the historical offset rules needed for report dates.
export function namedTimeZone(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_+/-]{0,99}$/.test(value)) return;
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const instant = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
// Consume literal Markdown before looking for instants, including an open span
// or fence in a streaming message.
const literalStart =
  /^(?: {0,3}>| {4}|\t)[^\n]*|^ {0,3}(?<fence>`{3,}|~{3,})[^\n]*(?:\n|$)|(?<ticks>`+)[^\n]*?(?:\k<ticks>(?!`)|$)|^ {0,3}\[[^\]\n]+\]:[^\n]*|\[[^\]\n]*\](?:(?<destination>\()|\[[^\]\n]*\])|"[^"\n]*"|“[^”\n]*”|(?:[a-z][\w+.-]*:\/\/|www\.)[^\s<>]+/gim;

function fenceEnd(text: string, start: number, opening: string): number {
  const closer = /^ {0,3}(`+|~+)[ \t]*\r?$/gm;
  closer.lastIndex = start;
  let match;
  while ((match = closer.exec(text))) {
    if (match[1]!.startsWith(opening)) return closer.lastIndex;
  }
  return text.length;
}

function destinationEnd(text: string, start: number): number {
  let i = start;
  while (text[i] === ' ' || text[i] === '\t') i++;
  const destinationStart = i;
  let depth = 1;
  // Parentheses are data inside <destinations> and quoted titles.
  let delimiter: string | undefined;
  let firstNewline = -1;
  for (; i < text.length; i++) {
    const char = text[i];
    if (char === '\n') {
      if (!delimiter || delimiter === '>') return i;
      if (firstNewline === -1) firstNewline = i;
    }
    if (char === '\\') {
      i++;
      continue;
    }
    if (delimiter) {
      if (char === delimiter) {
        delimiter = undefined;
        firstNewline = -1;
      }
      continue;
    }
    if (char === '<' && i === destinationStart) delimiter = '>';
    else if ((char === '"' || char === "'") && depth === 1 && /\s/.test(text[i - 1]!)) {
      delimiter = char;
    } else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return i + 1;
  }
  return firstNewline < 0 ? text.length : firstNewline;
}

export function localizeReportTimes(
  text: string,
  zone: string,
  locale = 'en-US',
  speakZone = false,
): string {
  if (!text.includes('T') || !text.includes('Z')) return text;
  let formatter: Intl.DateTimeFormat | undefined;
  function prose(value: string): string {
    return value.replace(instant, (token) => {
      const date = new Date(token);
      if (
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 19) !== token.slice(0, 19)
      )
        return token;
      try {
        formatter ??= new Intl.DateTimeFormat(locale, {
          timeZone: namedTimeZone(zone) ?? 'UTC',
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit',
          timeZoneName: 'shortOffset',
        });
        const formatted = formatter.format(date);
        return speakZone ? `${formatted} (${formatter.resolvedOptions().timeZone})` : formatted;
      } catch {
        return token;
      }
    });
  }
  let result = '';
  let start = 0;
  const literals = new RegExp(literalStart);
  let match;
  while ((match = literals.exec(text))) {
    let end = literals.lastIndex;
    if (match.groups?.fence) end = fenceEnd(text, end, match.groups.fence);
    else if (match.groups?.destination) end = destinationEnd(text, end);
    result += prose(text.slice(start, match.index)) + text.slice(match.index, end);
    start = literals.lastIndex = end;
  }
  return result + prose(text.slice(start));
}

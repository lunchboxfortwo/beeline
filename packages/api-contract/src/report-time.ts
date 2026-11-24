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
const literal =
  /^(?: {0,3}>| {4}|\t)[^\n]*|^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[\t ]*$|(?![\s\S]))|(`+)[^\n]*?(?:\2(?!`)|$)|^ {0,3}\[[^\]\n]+\]:[^\n]*|\[[^\]\n]*\](?:\([^\n]*?\)|\[[^\]\n]*\])|"[^"\n]*"|“[^”\n]*”|(?:[a-z][\w+.-]*:\/\/|www\.)[^\s<>]+/gim;

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
  for (const match of text.matchAll(literal)) {
    result += prose(text.slice(start, match.index)) + match[0];
    start = match.index! + match[0].length;
  }
  return result + prose(text.slice(start));
}

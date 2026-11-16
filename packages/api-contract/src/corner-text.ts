/** Corner names are continuous titles; objectives remain normalized paragraphs.
 * Legacy display names retain their original word-based truncation.
 */

export const CORNER_NAME_MAX_WORDS = 3;
export const CORNER_OBJECTIVE_MAX_WORDS = 24;
export const CORNER_NAME_MAX_LENGTH = 120;
export const CORNER_OBJECTIVE_MAX_LENGTH = 2000;

export type CornerTextField = 'name' | 'objective';

const LIMITS: Readonly<
  Record<CornerTextField, { readonly words: number; readonly characters: number }>
> = {
  name: { words: CORNER_NAME_MAX_WORDS, characters: CORNER_NAME_MAX_LENGTH },
  objective: { words: CORNER_OBJECTIVE_MAX_WORDS, characters: CORNER_OBJECTIVE_MAX_LENGTH },
};

/** One trimmed paragraph: every whitespace run, line break included, becomes one space. */
export function normalizeCornerText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * The plain sentence a refusal is owed, or `undefined` when the normalised
 * text is acceptable. It always names both the limit and what actually
 * arrived, so the agent can fix the call without guessing.
 */
export function cornerTextRefusal(field: CornerTextField, value: unknown): string | undefined {
  const limit = LIMITS[field];
  if (typeof value !== 'string' || !normalizeCornerText(value)) {
    return `the ${field} is required; give ${
      field === 'name' ? 'a title' : 'one statement'
    } of at most ${limit.words} words`;
  }
  const normalized = normalizeCornerText(value);
  if (field === 'name' && /\s/.test(value)) {
    return 'the name must not contain whitespace; use hyphens between words';
  }
  if (normalized.length > limit.characters) {
    return `the ${field} is ${normalized.length} characters; the limit is ${limit.characters}`;
  }
  // A name's words are its hyphen-separated parts, so hyphens cannot hide a fourth word.
  const words = (field === 'name' ? normalized.split(/[ -]+/).filter(Boolean) : normalized.split(' ')).length;
  if (words > limit.words) {
    return `the ${field} is ${words} words; the limit is ${limit.words}`;
  }
  return undefined;
}

export type FixedCornerText = { readonly text: string; readonly note?: string };

/** Cut on the last space or hyphen that still fits, never mid-word. */
function cutAtWord(value: string, max: number): string {
  if (value.length <= max) return value;
  const boundary = Math.max(value.lastIndexOf(' ', max), value.lastIndexOf('-', max));
  const cut = (boundary > 0 ? value.slice(0, boundary) : value.slice(0, max)).trim();
  return cut || value.slice(0, max).trim();
}

/**
 * A name with spaces becomes its first three words joined by hyphens.
 * An objective past the word or character limit is cut on a word boundary.
 * Empty text still throws. The note says what changed.
 */
export function fixCornerText(field: CornerTextField, value: unknown): FixedCornerText {
  const limit = LIMITS[field];
  if (typeof value !== 'string' || !normalizeCornerText(value)) {
    throw new Error(
      `the ${field} is required; give ${field === 'name' ? 'a title' : 'one statement'} of at most ${limit.words} words`,
    );
  }
  let normalized = normalizeCornerText(value);
  const notes: string[] = [];
  if (field === 'name') {
    const words = normalized.split(/[ -]+/).filter(Boolean);
    const hyphenated = words.slice(0, limit.words).join('-');
    if (hyphenated !== normalized || /\s/.test(value)) {
      normalized = hyphenated;
      notes.push(
        words.length > limit.words
          ? `the name had spaces and was ${words.length} words; saved as ${hyphenated} (first ${limit.words} words)`
          : `the name had spaces; saved as ${hyphenated}`,
      );
    }
  } else {
    const words = normalized.split(' ');
    if (words.length > limit.words) {
      normalized = words.slice(0, limit.words).join(' ');
      notes.push(`the objective was ${words.length} words; cut to ${limit.words} at a word boundary`);
    }
  }
  if (normalized.length > limit.characters) {
    const before = normalized.length;
    normalized = cutAtWord(normalized, limit.characters);
    notes.push(`the ${field} was ${before} characters; cut to ${normalized.length} at a word boundary`);
  }
  return { text: normalized, ...(notes.length ? { note: notes.join('; ') } : {}) };
}

/**
 * The title a corner is drawn with. Corners opened before the name existed
 * stored the whole objective in that slot, so the first three words stand in
 * — cut on a word boundary, never mid-word, and never with an ellipsis.
 */
export function cornerDisplayName(name: string | null | undefined): string {
  const normalized = normalizeCornerText(name ?? '');
  if (!normalized) return '';
  const words = normalized.split(' ');
  return words.length <= CORNER_NAME_MAX_WORDS
    ? normalized
    : words.slice(0, CORNER_NAME_MAX_WORDS).join(' ');
}

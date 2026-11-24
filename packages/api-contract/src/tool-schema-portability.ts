/**
 * Tool input schemas are compiled by every harness we serve. Some (Antigravity,
 * Go-based) compile `pattern` with RE2 and refuse the whole toolbox when one
 * pattern fails, so advertised patterns must stay inside the syntax that both
 * ECMA-262 and RE2 accept.
 */
export type PortablePatternProblem = { path: string; pattern: string; reason: string };

/** Returns why a pattern is not portable to RE2 and ECMA-262, or undefined when it is. */
export function regexPortabilityProblem(pattern: string): string | undefined {
  try {
    new RegExp(pattern, 'u');
  } catch (error) {
    return `not a valid ECMA-262 regex: ${(error as Error).message}`;
  }
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') {
      const next = pattern[i + 1] ?? '';
      if (next === 'u') return 'uses a \\u escape, which RE2 rejects (use \\x{...} or a literal)';
      if (/[1-9]/.test(next)) return 'uses a backreference, which RE2 rejects';
      if (next === 'k' && pattern[i + 2] === '<') return 'uses a named backreference, which RE2 rejects';
      i++;
      continue;
    }
    if (inClass) {
      if (char === ']') inClass = false;
      continue;
    }
    if (char === '[') {
      // ECMA-262 reads `[]` as an empty class, so a `]` right after `[` closes it.
      inClass = true;
      continue;
    }
    if (char === '(' && pattern[i + 1] === '?') {
      const flag = pattern[i + 2];
      if (flag === '=' || flag === '!') return 'uses a lookahead, which RE2 rejects';
      if (flag === '<') return pattern[i + 3] === '=' || pattern[i + 3] === '!'
        ? 'uses a lookbehind, which RE2 rejects'
        : 'uses (?<name>, which older RE2 rejects (use a plain group)';
    }
  }
  return undefined;
}

/** Walks a JSON Schema and lists every `pattern` or `patternProperties` key that is not portable. */
export function nonPortableSchemaPatterns(schema: unknown, path = ''): PortablePatternProblem[] {
  if (Array.isArray(schema)) return schema.flatMap((item, index) => nonPortableSchemaPatterns(item, `${path}/${index}`));
  if (!schema || typeof schema !== 'object') return [];
  const problems: PortablePatternProblem[] = [];
  for (const [key, value] of Object.entries(schema)) {
    const at = `${path}/${key}`;
    if (key === 'pattern' && typeof value === 'string') {
      const reason = regexPortabilityProblem(value);
      if (reason) problems.push({ path: at, pattern: value, reason });
      continue;
    }
    if (key === 'patternProperties' && value && typeof value === 'object') {
      for (const name of Object.keys(value)) {
        const reason = regexPortabilityProblem(name);
        if (reason) problems.push({ path: `${at}/${name}`, pattern: name, reason });
      }
    }
    problems.push(...nonPortableSchemaPatterns(value, at));
  }
  return problems;
}

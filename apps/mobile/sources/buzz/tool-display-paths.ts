const GENERIC_BASENAMES = new Set([
  'skill.md',
  'readme.md',
  'index.ts',
  'index.tsx',
  'index.js',
  'index.jsx',
  'index.mjs',
  'index.cjs',
  'route.ts',
  'route.tsx',
  'page.tsx',
  'page.ts',
  'layout.tsx',
  'layout.ts',
  'package.json',
  'tsconfig.json',
  'mod.rs',
  'lib.rs',
  'main.rs',
  'main.go',
  'main.ts',
  '__init__.py',
  'types.ts',
  'constants.ts',
  'utils.ts',
  'helpers.ts',
  'config.ts',
  'schema.ts',
  'styles.ts',
]);

const RECOGNIZED_DISPLAY_PREFIXES = [
  /(?:file:\/\/)?\/(?:home|Users)\/[^/\s"'`]+\/\.local\/state\/beeline\/agents\/[0-9a-f]+\/rooms\/[0-9a-f-]+\/agent-home\/(?:codex|claude|pi|user)\//gi,
  /(?:file:\/\/)?\/(?:home|Users)\/[^/\s"'`]+\/\.local\/state\/beeline\/corners\/[0-9a-f]+\//gi,
  /(?:file:\/\/)?\/(?:home|Users)\/[^/\s"'`]+\/\.local\/state\/beeline\/worktrees\/[^/\s"'`]+\//gi,
  /(?:file:\/\/)?(?:\/(?:home|Users)\/[^/\s"'`]+\/\.local\/state\/beeline\/[^/\s"'`]+\/)?agent-home\/(?:codex|claude|pi|user)\//gi,
] as const;

export function stripRecognizedDisplayPrefix(value: string): string {
  let current = value;
  for (const pattern of RECOGNIZED_DISPLAY_PREFIXES) {
    current = current.replace(pattern, '');
  }
  return current;
}

/**
 * Keep enough parent context when a basename is generic (`waiting-and-wakes/SKILL.md`,
 * `server/index.ts`, `server/src/index.ts`) while keeping distinctive files compact (`Ledger.tsx`)
 * and stripping recognized internal Beeline sandbox/host prefixes.
 */
export function displayFilePath(path: string): string {
  const cleaned = stripRecognizedDisplayPrefix(path)
    .replace(/^file:\/\//i, '')
    .replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  const base = parts.at(-1);
  if (!base) return cleaned || path;
  if (parts.length >= 2 && GENERIC_BASENAMES.has(base.toLowerCase())) {
    const parent = parts[parts.length - 2]!;
    if (parts.length >= 3 && /^(?:src|lib|dist|app)$/i.test(parent)) {
      return `${parts[parts.length - 3]}/${parent}/${base}`;
    }
    return `${parent}/${base}`;
  }
  return base;
}

/** Format a file path with optional 1-based line or line–endLine range. */
export function displayFileLocation(file: {
  path: string;
  line?: number;
  endLine?: number;
}): string {
  const base = displayFilePath(file.path);
  if (typeof file.line === 'number' && file.line > 0) {
    if (typeof file.endLine === 'number' && file.endLine > file.line) {
      return `${base}:${file.line}–${file.endLine}`;
    }
    return `${base}:${file.line}`;
  }
  return base;
}

/** Replace embedded absolute paths while preserving disambiguating parent segments and relative repo paths. */
export function redactDisplayPaths(value: string): string {
  return stripRecognizedDisplayPrefix(value).replace(
    /(^|[\s"'`(=:])((?:file:\/\/)?\/(?:[\w.@~+%=,:-]+\/)+[\w.@~+%=,:-]+)/g,
    (_match, lead: string, path: string) => `${lead}${displayFilePath(path)}`,
  );
}

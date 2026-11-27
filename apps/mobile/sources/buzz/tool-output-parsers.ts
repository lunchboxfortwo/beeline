import { sanitizeIdsInText, type ToolIdentityLookup } from './tool-identity-lookup';
import { stripRecognizedDisplayPrefix } from './tool-display-paths';

const OSC_ESCAPE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OUTER_FENCE_COMPLETE = /^\s*```[a-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/i;
const OUTER_FENCE_OPEN_ONLY = /^\s*```(?:console|json|txt|text|sh|bash|zsh|diff|patch|log)?[ \t]*\r?\n([\s\S]+)$/i;

/**
 * Strip OSC terminal hyperlinks, CSI ANSI escapes, `\r` progress overwrites,
 * and outer markdown code fences (` ```console `, ` ```json `) before JSON or
 * text rendering.
 */
export function cleanToolOutputText(raw: string): string {
  const withoutEscapes = raw.replace(OSC_ESCAPE, '').replace(CSI_ESCAPE, '');
  const collapsedCr = withoutEscapes
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const cleaned = line.replace(/\r$/, '');
      if (!cleaned.includes('\r')) return cleaned;
      const segments = cleaned.split('\r');
      for (let i = segments.length - 1; i >= 0; i -= 1) {
        if (segments[i]!.length > 0) return segments[i]!;
      }
      return '';
    })
    .join('\n');
  const completeFence = collapsedCr.match(OUTER_FENCE_COMPLETE);
  if (completeFence?.[1] !== undefined) return completeFence[1];
  const openFence = collapsedCr.match(OUTER_FENCE_OPEN_ONLY);
  if (openFence?.[1] !== undefined) return openFence[1];
  return collapsedCr;
}

export type ParsedJsonResult = {
  value: unknown;
  truncated: boolean;
  bounded: boolean;
  omittedCount?: number;
};

function scanJsonValueEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length && /\s/.test(text[i]!)) i += 1;
  if (i >= text.length) return -1;
  const ch = text[i]!;
  if (ch === '"') {
    i += 1;
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2;
        continue;
      }
      if (text[i] === '"') return i + 1;
      i += 1;
    }
    return -1;
  }
  if (ch === '{' || ch === '[') {
    const stack: string[] = [ch];
    let inString = false;
    i += 1;
    while (i < text.length && stack.length > 0) {
      const c = text[i]!;
      if (inString) {
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '"') inString = false;
        i += 1;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' && stack.at(-1) === '{') stack.pop();
      else if (c === ']' && stack.at(-1) === '[') stack.pop();
      i += 1;
    }
    return stack.length === 0 ? i : -1;
  }
  const rest = text.slice(i);
  const prim = rest.match(/^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=[\s,}\]]|$)/);
  return prim ? i + prim[0].length : -1;
}

function recoverPartialJsonObject(text: string): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  let i = text.indexOf('{');
  if (i < 0) return undefined;
  i += 1;
  let recovered = 0;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i]!)) i += 1;
    if (i >= text.length || text[i] === '}') break;
    if (text[i] !== '"') break;
    const keyEnd = scanJsonValueEnd(text, i);
    if (keyEnd < 0) break;
    let key: string;
    try {
      key = JSON.parse(text.slice(i, keyEnd)) as string;
    } catch {
      break;
    }
    i = keyEnd;
    while (i < text.length && /\s/.test(text[i]!)) i += 1;
    if (text[i] !== ':') break;
    i += 1;
    const valEnd = scanJsonValueEnd(text, i);
    if (valEnd < 0) break;
    try {
      result[key] = JSON.parse(text.slice(i, valEnd)) as unknown;
      recovered += 1;
    } catch {
      break;
    }
    i = valEnd;
  }
  return recovered > 0 ? result : undefined;
}

function recoverPartialJsonArray(text: string): unknown[] | undefined {
  const result: unknown[] = [];
  let i = text.indexOf('[');
  if (i < 0) return undefined;
  i += 1;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i]!)) i += 1;
    if (i >= text.length || text[i] === ']') break;
    const valEnd = scanJsonValueEnd(text, i);
    if (valEnd < 0) break;
    try {
      result.push(JSON.parse(text.slice(i, valEnd)) as unknown);
    } catch {
      break;
    }
    i = valEnd;
  }
  return result.length > 0 ? result : undefined;
}

function extractOmittedCount(value: unknown): number | undefined {
  if (Array.isArray(value)) {
    const last = value.at(-1);
    if (
      last &&
      typeof last === 'object' &&
      !Array.isArray(last) &&
      typeof (last as Record<string, unknown>)._omittedCount === 'number'
    ) {
      return (last as Record<string, unknown>)._omittedCount as number;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const count = (value as Record<string, unknown>)._omittedCount;
    if (typeof count === 'number' && count > 0) return count;
  }
  return undefined;
}

/**
 * Parse JSON cleanly, or recover complete top-level keys/items from a truncated
 * `>4 KiB` / `head -c` JSON snippet.
 */
export function parseTolerantJson(raw: string): ParsedJsonResult | undefined {
  const cleaned = cleanToolOutputText(raw).trim();
  if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) return undefined;
  try {
    const value = JSON.parse(cleaned) as unknown;
    if (value && typeof value === 'object') {
      const omittedCount = extractOmittedCount(value);
      return {
        value,
        truncated: false,
        bounded: Boolean(omittedCount),
        ...(omittedCount ? { omittedCount } : {}),
      };
    }
    return undefined;
  } catch {
    const beforeCut = cleaned.split('\n[… omitted …]\n')[0] ?? cleaned;
    const recovered = beforeCut.startsWith('{')
      ? recoverPartialJsonObject(beforeCut)
      : recoverPartialJsonArray(beforeCut);
    if (!recovered) return undefined;
    return { value: recovered, truncated: true, bounded: false };
  }
}

export function humanizeFieldKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!spaced) return key;
  const words = spaced.split(/\s+/).map((word, index) => {
    const upper = word.toUpperCase();
    if (['ID', 'URL', 'URLS', 'PR', 'CI', 'API', 'MCP', 'UTC', 'JSON', 'SHA'].includes(upper)) {
      return upper === 'URLS' ? 'URLs' : upper;
    }
    return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase();
  });
  return words.join(' ');
}

export function formatScalarValue(value: unknown, lookup?: ToolIdentityLookup): {
  text: string;
  mono?: boolean;
  muted?: boolean;
} {
  if (value === null || value === undefined || value === '') {
    return { text: 'None', muted: true };
  }
  if (typeof value === 'boolean') return { text: value ? 'Yes' : 'No' };
  if (typeof value === 'number') return { text: String(value), mono: true };
  if (typeof value === 'string') {
    const clean = sanitizeIdsInText(value.trim(), lookup);
    if (!clean) return { text: 'None', muted: true };
    const isIsoDate = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?/.test(clean);
    const isPathOrUrl = /^(?:https?:\/\/|\/|\.{1,2}\/)/.test(clean);
    return { text: clean, mono: isIsoDate || isPathOrUrl };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { text: 'None', muted: true };
    if (value.every((item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')) {
      return { text: value.map((item) => sanitizeIdsInText(String(item), lookup)).join(', ') };
    }
    return { text: `${value.length} ${value.length === 1 ? 'item' : 'items'}` };
  }
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const entries = Object.entries(rec).filter(([, v]) => v !== undefined && v !== null && v !== '');
    if (entries.length === 0) return { text: 'None', muted: true };
    if (typeof rec.start === 'string' && typeof rec.end === 'string' && entries.length <= 3) {
      return { text: `${rec.start} – ${rec.end}`, mono: true };
    }
    if (typeof rec.name === 'string') {
      const handle = typeof rec.handle === 'string' ? ` (@${rec.handle.replace(/^@/, '')})` : '';
      return { text: `${rec.name}${handle}` };
    }
    if (typeof rec.handle === 'string') {
      return { text: `@${rec.handle.replace(/^@/, '')}` };
    }
    const parts: string[] = [];
    for (const [k, v] of entries.slice(0, 4)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        parts.push(`${v} ${k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}`);
      }
    }
    if (parts.length) return { text: parts.join(' · ') };
    return { text: `${entries.length} fields` };
  }
  return { text: String(value) };
}

export type SheetMatchGroup = {
  path: string;
  matches: Array<{ line: number; text: string }>;
};

const KNOWN_CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'mdx', 'yml', 'yaml',
  'toml', 'css', 'scss', 'html', 'xml', 'svg', 'py', 'go', 'rs', 'java', 'kt',
  'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'rb', 'php', 'sh', 'bash', 'zsh',
  'sql', 'graphql', 'gql', 'txt', 'env', 'ini', 'cfg', 'conf', 'lock', 'gradle',
  'properties', 'dockerfile', 'makefile',
]);

const LOG_LEVEL_OR_TIMESTAMP =
  /^(?:\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\[?(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC)\]?\b)/i;

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\\/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const HOST_PORT_ONLY = /^(?:[a-z0-9-]+\.)+(?:com|net|org|io|app|dev|ai|co|xyz|gov|edu|local|internal|lan):\d+\b/i;

/**
 * Strictly parse `path:line:text` search matches. Explicitly rejects colon-bearing
 * logs, timestamps, URLs/host:port, and Windows drive paths so non-search logs
 * stay honest mono output.
 */
export function parseStrictSearchMatches(raw: string): SheetMatchGroup[] | undefined {
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0 && l.trim() !== '--' && l.trim() !== '[… omitted …]');
  if (lines.length < 2) return undefined;

  const groups = new Map<string, Array<{ line: number; text: string }>>();
  let matched = 0;

  for (const line of lines) {
    if (
      /^\s/.test(line) ||
      LOG_LEVEL_OR_TIMESTAMP.test(line) ||
      WINDOWS_DRIVE_PATH.test(line) ||
      URL_SCHEME.test(line) ||
      HOST_PORT_ONLY.test(line)
    ) {
      return undefined;
    }
    const m = line.match(/^([A-Za-z0-9_@./~+-]+):([1-9]\d{0,6}):(.*)$/);
    if (!m?.[1] || !m[2]) return undefined;
    const rawPath = m[1];
    const lineNum = Number(m[2]);
    const text = m[3] ?? '';

    if (rawPath.includes('://') || rawPath.includes('\\') || /^\d+$/.test(rawPath)) {
      return undefined;
    }
    const hasSlash = rawPath.includes('/');
    if (!hasSlash) {
      const ext = rawPath.split('.').at(-1)?.toLowerCase() ?? '';
      if (!KNOWN_CODE_EXTENSIONS.has(ext)) return undefined;
    } else if (/^\/?(?:https?|wss?)/i.test(rawPath)) {
      return undefined;
    }
    const cleanPath = stripRecognizedDisplayPrefix(rawPath);
    const list = groups.get(cleanPath) ?? [];
    list.push({ line: lineNum, text: text.trimStart() });
    groups.set(cleanPath, list);
    matched += 1;
  }

  if (matched < 2) return undefined;
  return [...groups.entries()].map(([path, matches]) => ({ path, matches }));
}

export function formatBytesCompact(bytes: number | undefined): string | undefined {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

import type { TurnActivityAction } from './activity-timeline';

/**
 * What a tool call *is*, for the one-line tool ledger (tool-ledger.ts).
 *
 * This module is the one place that decides what a call *is*: the unwrapped
 * command or human-readable MCP operation and target, disambiguated file paths,
 * read-only shell classification, and cleaned output.
 */

/** The object column truncates in the MIDDLE: the flags at the end carry the meaning. */
export const TOOL_CALL_OBJECT_MAX = 56;
/** The ledger line's label cap (owner-approved tool-ledger design, 2026-08-24). */
const TOOL_CALL_LABEL_MAX = 40;
/** A duration is only worth a column when the call was slow enough to notice. */
export const TOOL_CALL_DURATION_FLOOR_MS = 1000;

/** ACP tool kinds (and the folded-summary verbs) -> the one-word verb column. */
const KIND_VERBS: Readonly<Record<string, string>> = {
  read: 'read',
  open: 'read',
  search: 'found',
  searched: 'found',
  grep: 'found',
  fetch: 'fetched',
  fetched: 'fetched',
  list: 'listed',
  listed: 'listed',
  inspected: 'read',
  edit: 'wrote',
  write: 'wrote',
  create: 'wrote',
  patch: 'wrote',
  move: 'moved',
  delete: 'deleted',
  execute: 'ran',
  ran: 'ran',
};

/** Generic human-readable verbs displayed in the row's leading meta column. */
const GENERIC_LEDGER_VERBS = new Set([
  ...Object.values(KIND_VERBS),
  'git',
  'checked',
  'created',
  'updated',
  'paused',
  'resumed',
  'replied',
  'reported',
  'sent',
  'opened',
  'closed',
  'claimed',
  'approved',
  'saved',
  'used',
  'posted',
  'connected',
  'prepared',
  'requested',
  'stopped',
  'dispatched',
]);

/** A folded rollup row from an older transcript: `reading 8` is 8 read calls. */
const PARTICIPLE_VERBS: Readonly<Record<string, string>> = {
  reading: 'read',
  searching: 'found',
  listing: 'listed',
  fetching: 'fetched',
  inspecting: 'read',
  querying: 'found',
  running: 'ran',
};

/** Verb words the harness leads its own titles with, stripped off the object. */
const TITLE_VERB =
  /^(?:read|ran|run|wrote|write|edited?|searched(?:\s+for)?|listed|fetched|inspected|reasoned\s+about|opened|updated|reviewed)\s+/i;

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

const KNOWN_MCP_SERVERS = [
  'beeline-readonly-mcp',
  'beeline_readonly_mcp',
  'beeline-agent',
  'beeline_agent',
  'codegraph',
  'squire',
] as const;

const READ_ONLY_SHELL_COMMANDS = new Set([
  'rg',
  'grep',
  'egrep',
  'fgrep',
  'ag',
  'ack',
  'cat',
  'head',
  'tail',
  'nl',
  'wc',
  'cut',
  'tr',
  'uniq',
  'rev',
  'stat',
  'file',
  'readlink',
  'realpath',
  'dirname',
  'basename',
  'pwd',
  'which',
  'type',
  'id',
  'whoami',
  'uname',
  'date',
  'env',
  'printenv',
  'echo',
  'printf',
  'true',
  'false',
  'test',
  '[',
  'ls',
  'dir',
  'tree',
  'du',
  'df',
  'jq',
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'describe',
  'ls-files',
  'ls-tree',
  'cat-file',
  'blame',
  'shortlog',
  'grep',
  'merge-base',
  'rev-list',
  'symbolic-ref',
  'name-rev',
  'check-ignore',
  'for-each-ref',
]);

const GENERIC_SHELL_TITLES = /^(?:bash|sh|zsh|shell|terminal|execute|command|exec_command|run_command|tool)$/i;

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Keep the head AND the tail. `npm run test -- --coverage --reporter=json`
 * truncated at the end is just `npm run test --…`, which is every test command
 * in the repo; the flags are the half that says which one this was.
 */
export function middleTruncate(value: string, limit = TOOL_CALL_OBJECT_MAX): string {
  const clean = oneLine(value);
  if (clean.length <= limit) return clean;
  const keep = Math.max(2, limit - 1);
  const head = Math.ceil(keep / 2);
  return `${clean.slice(0, head).trimEnd()}…${clean.slice(clean.length - (keep - head)).trimStart()}`;
}

/**
 * Keep enough parent context when a basename is generic (`waiting-and-wakes/SKILL.md`,
 * `server/index.ts`, `server/src/index.ts`) while keeping distinctive files compact (`Ledger.tsx`).
 */
export function displayFilePath(path: string): string {
  const cleaned = path.replace(/^file:\/\//i, '').replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  const base = parts.at(-1);
  if (!base) return path;
  if (parts.length >= 2 && GENERIC_BASENAMES.has(base.toLowerCase())) {
    const parent = parts[parts.length - 2]!;
    if (parts.length >= 3 && /^(?:src|lib|dist|app)$/i.test(parent)) {
      return `${parts[parts.length - 3]}/${parent}/${base}`;
    }
    return `${parent}/${base}`;
  }
  return base;
}

/** Replace embedded absolute paths while preserving disambiguating parent segments and relative repo paths. */
export function redactDisplayPaths(value: string): string {
  return value.replace(
    /(^|[\s"'`(=:])((?:file:\/\/)?\/(?:[\w.@~+%=,:-]+\/)+[\w.@~+%=,:-]+)/g,
    (_match, lead: string, path: string) => `${lead}${displayFilePath(path)}`,
  );
}

function unquoteShellArg(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  }
  return trimmed;
}

/** `env A=b bash -lc 'cd /repo && rg foo apps/'` -> `rg foo apps/`. */
export function peelShellCommand(command: string): string {
  let current = oneLine(command);
  for (let pass = 0; pass < 5; pass += 1) {
    const before = current;
    current = current.replace(
      /^(?:(?:\/[\w.-]+)*\/)?env\s+(?:(?:-u\s+\S+\s+)|(?:--\s+)|(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+))+/i,
      '',
    );
    current = current.replace(
      /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)+/,
      '',
    );
    const shellWrap = current.match(
      /^(?:(?:\/[\w.-]+)*\/)?(?:bash|sh|zsh)\s+(?:(?:--login\s+)?-[a-zA-Z]*c[a-zA-Z]*|--command)\s+(.+)$/i,
    );
    if (shellWrap?.[1]) {
      current = oneLine(unquoteShellArg(shellWrap[1]));
    }
    current = current.replace(/^cd\s+(?:'[^']*'|"[^"]*"|[^\s;&|]+)\s*(?:&&|;)\s*/, '');
    if (current === before) break;
  }
  return current.trim();
}

function splitShellSegments(command: string): string[] | null {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    const next = command[i + 1];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') {
        escaped = true;
        current += ch;
        continue;
      }
      if (ch === '$' && next === '(') return null;
      if (ch === '`') return null;
      if (ch === '"') quote = null;
      current += ch;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if ((ch === '$' && next === '(') || ch === '`') return null;
    if ((ch === '<' || ch === '>') && next === '(') return null;
    if (ch === '>') {
      // Allow only benign stderr redirections: 2>/dev/null and 2>&1.
      const rest = command.slice(i);
      const endsWithFd2 = /(?:^|\s)2$/.test(current);
      if (endsWithFd2 && /^>\/dev\/null(?=\s|$|[|;&])/.test(rest)) {
        current = current.slice(0, -1);
        i += '>/dev/null'.length - 1;
        continue;
      }
      if (endsWithFd2 && /^>&1(?=\s|$|[|;&])/.test(rest)) {
        current = current.slice(0, -1);
        i += '>&1'.length - 1;
        continue;
      }
      return null;
    }
    if (ch === '&') {
      if (next === '&') {
        segments.push(current.trim());
        current = '';
        i += 1;
        continue;
      }
      return null;
    }
    if (ch === '|') {
      segments.push(current.trim());
      current = '';
      if (next === '|') i += 1;
      continue;
    }
    if (ch === ';') {
      segments.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote !== null) return null;
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') escaped = true;
      else if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function isReadOnlySegment(segment: string): 'read' | 'cd' | false {
  let tokens = tokenizeSegment(segment);
  if (!tokens.length) return false;
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) {
    tokens = tokens.slice(1);
  }
  if (tokens[0] && (tokens[0] === 'env' || tokens[0].endsWith('/env'))) {
    tokens = tokens.slice(1);
    while (tokens.length && (tokens[0] === '--' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!))) {
      tokens = tokens.slice(1);
    }
  }
  if (!tokens.length) return false;
  const bin = (tokens[0]!.split('/').at(-1) ?? tokens[0]!).toLowerCase();
  const args = tokens.slice(1);

  if (bin === 'cd') return 'cd';
  if (READ_ONLY_SHELL_COMMANDS.has(bin)) return 'read';
  if (bin === 'sort') {
    return args.some((arg) => arg === '-o' || arg.startsWith('-o') || arg.startsWith('--output'))
      ? false
      : 'read';
  }
  if (bin === 'command') {
    return args.includes('-v') || args.includes('-V') ? 'read' : false;
  }
  if (bin === 'sed') {
    const hasInPlace = args.some(
      (arg) => arg === '-i' || /^-[a-zA-Z]*i/.test(arg) || arg.startsWith('--in-place'),
    );
    const hasQuiet = args.some(
      (arg) => arg === '-n' || /^-[a-zA-Z]*n/.test(arg) || arg === '--quiet' || arg === '--silent',
    );
    return !hasInPlace && hasQuiet ? 'read' : false;
  }
  if (bin === 'awk') {
    const joined = args.join(' ');
    return /\bsystem\s*\(|>/.test(joined) ? false : 'read';
  }
  if (bin === 'find') {
    return args.some((arg) =>
      /^(?:-delete|-exec|-execdir|-ok|-okdir|-fprint0?|-fprintf|-fls)$/.test(arg),
    )
      ? false
      : 'read';
  }
  if (bin === 'git') {
    let i = 0;
    while (i < args.length) {
      const arg = args[i]!;
      if (arg === '-C' || arg === '-c' || arg === '--git-dir' || arg === '--work-tree') {
        i += 2;
        continue;
      }
      if (arg.startsWith('-')) {
        i += 1;
        continue;
      }
      break;
    }
    const sub = args[i]?.toLowerCase();
    const rest = args.slice(i + 1);
    if (!sub) return false;
    if (READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return 'read';
    if (sub === 'branch') {
      const mutating = rest.some(
        (arg) =>
          /^(?:-[dDmMcC]|--delete|--move|--copy|--set-upstream|--unset-upstream|-u)$/.test(arg) ||
          (!arg.startsWith('-') && !rest.some((flag) => flag === '--list' || flag === '-l')),
      );
      return mutating ? false : 'read';
    }
    if (sub === 'tag') {
      return rest.length === 0 || rest.includes('-l') || rest.includes('--list') ? 'read' : false;
    }
    return false;
  }
  return false;
}

/**
 * True only when wrapper peeling leaves exclusively read-only shell segments
 * with no output redirection, command substitution, or write flags.
 */
export function isReadOnlyShellCommand(rawCommand: string): boolean {
  const peeled = peelShellCommand(rawCommand);
  if (!peeled) return false;
  const segments = splitShellSegments(peeled);
  if (!segments?.length) return false;
  let sawRead = false;
  for (const segment of segments) {
    const kind = isReadOnlySegment(segment);
    if (!kind) return false;
    if (kind === 'read') sawRead = true;
  }
  return sawRead;
}

function parsed(value: string | undefined): unknown {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function field(value: unknown, keys: readonly string[]): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function parseMcpString(value: string | undefined): { server: string; tool: string } | undefined {
  if (!value) return undefined;
  const trimmed = oneLine(value);
  const dunder = trimmed.match(/\bmcp__([\w.-]+)__([\w.-]+)/);
  if (dunder?.[1] && dunder[2]) return { server: dunder[1], tool: dunder[2] };
  const dotted = trimmed.match(/\bmcp\.([\w-]+)\.([\w.-]+)/);
  if (dotted?.[1] && dotted[2]) return { server: dotted[1], tool: dotted[2] };
  const singleMatch = trimmed.match(/\bmcp_([\w.-]+)/);
  if (singleMatch?.[1]) {
    const rest = singleMatch[1];
    for (const server of KNOWN_MCP_SERVERS) {
      if (rest.startsWith(`${server}_`) && rest.length > server.length + 1) {
        return {
          server: server.replaceAll('_', '-'),
          tool: rest.slice(server.length + 1),
        };
      }
    }
    const generic = rest.match(/^([a-z0-9-]+)_([a-z0-9_]+)$/i);
    if (generic?.[1] && generic[2]) return { server: generic[1], tool: generic[2] };
  }
  for (const server of KNOWN_MCP_SERVERS) {
    const prefix = `${server}__`;
    if (trimmed.toLowerCase().startsWith(prefix)) {
      const tool = trimmed.slice(prefix.length).split(/\s+/)[0];
      if (tool) return { server: server.replaceAll('_', '-'), tool };
    }
  }
  return undefined;
}

/** Normalize MCP server/tool across claude-agent-acp, codex-acp, Antigravity, and Grok dialects. */
export function parseMcpTool(
  title?: string,
  command?: string,
  input?: string,
): { server: string; tool: string } | undefined {
  const fromTitle = parseMcpString(title);
  if (fromTitle) return fromTitle;
  const fromCommand = parseMcpString(command);
  if (fromCommand) return fromCommand;
  const envelope = parsed(input);
  if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
    const rec = envelope as Record<string, unknown>;
    if (typeof rec.server === 'string' && typeof rec.tool === 'string' && rec.server && rec.tool) {
      return { server: rec.server, tool: rec.tool };
    }
    const dispatched =
      (typeof rec.tool_name === 'string' ? rec.tool_name : undefined) ??
      (typeof rec.toolName === 'string' ? rec.toolName : undefined);
    if (dispatched) {
      const qualified = parseMcpString(dispatched) ?? dispatched.match(/^([\w.-]+)__([\w.-]+)$/);
      if (qualified && 'server' in qualified) return qualified;
      if (Array.isArray(qualified) && qualified[1] && qualified[2]) {
        return { server: qualified[1], tool: qualified[2] };
      }
    }
  }
  return undefined;
}

export type McpCallDescription = {
  verb: string;
  object: string;
  observational?: boolean;
  namedTool?: boolean;
};

function mcpArgs(input?: string): Record<string, unknown> | undefined {
  const data = parsed(input);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const rec = data as Record<string, unknown>;
  const inner = rec.arguments ?? rec.tool_input ?? rec.toolInput;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return rec;
}

function normalizedServer(server: string): string {
  return server.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function summaryFallback(args: Record<string, unknown> | undefined): McpCallDescription | undefined {
  const summary = field(args, ['toolSummary']);
  if (!summary) return undefined;
  const clean = oneLine(summary);
  const lead = clean.match(
    /^(list(?:ed)?|read|search(?:ed)?|find|found|check(?:ed)?|updat(?:e|ed)|creat(?:e|ed)|delet(?:e|ed)|open(?:ed)?|clos(?:e|ed)|send|sent|post(?:ed)?|sav(?:e|ed)|connect(?:ed)?|paus(?:e|ed)|resum(?:e|ed)|claim(?:ed)?|approv(?:e|ed)|stop(?:ped)?)\s+(.+)$/i,
  );
  if (lead?.[1] && lead[2]) {
    const rawVerb = lead[1].toLowerCase();
    const verbMap: Record<string, string> = {
      list: 'listed',
      listed: 'listed',
      read: 'read',
      search: 'found',
      searched: 'found',
      find: 'found',
      found: 'found',
      check: 'checked',
      checked: 'checked',
      update: 'updated',
      updated: 'updated',
      create: 'created',
      created: 'created',
      delete: 'deleted',
      deleted: 'deleted',
      open: 'opened',
      opened: 'opened',
      close: 'closed',
      closed: 'closed',
      send: 'sent',
      sent: 'sent',
      post: 'posted',
      posted: 'posted',
      save: 'saved',
      saved: 'saved',
      connect: 'connected',
      connected: 'connected',
      pause: 'paused',
      paused: 'paused',
      resume: 'resumed',
      resumed: 'resumed',
      claim: 'claimed',
      claimed: 'claimed',
      approve: 'approved',
      approved: 'approved',
      stop: 'stopped',
      stopped: 'stopped',
    };
    return { verb: verbMap[rawVerb] ?? 'ran', object: lead[2] };
  }
  return { verb: 'ran', object: clean };
}

/** Human-readable description of a Beeline or external MCP tool call. */
export function describeMcpCall(
  mcp: { server: string; tool: string },
  input?: string,
  command?: string,
): McpCallDescription {
  const server = normalizedServer(mcp.server);
  const tool = mcp.tool.toLowerCase();
  const args = mcpArgs(input);
  const action = field(args, ['action'])?.toLowerCase();
  const facet = field(args, ['facet'])?.toLowerCase();
  const title = field(args, ['title', 'name']);
  const query = field(args, ['query', 'pattern']);
  const path = field(args, ['path', 'file_path', 'filePath', 'filename']);
  const slug = field(args, ['slug', 'name']);
  const target = field(args, ['target', 'address', 'service', 'recipient']);

  if (server === 'beeline-agent') {
    if (tool === 'wake') {
      if (action === 'list') return { verb: 'listed', object: 'schedules', observational: true };
      if (action === 'events') return { verb: 'listed', object: 'wake events', observational: true };
      if (action === 'create') {
        return { verb: 'created', object: title ? `schedule · ${title}` : 'schedule' };
      }
      if (action === 'update') {
        return { verb: 'updated', object: title ? `schedule · ${title}` : 'schedule' };
      }
      if (action === 'delete') {
        return { verb: 'deleted', object: title ? `schedule · ${title}` : 'schedule' };
      }
      if (action === 'pause') {
        return { verb: 'paused', object: title ? `schedule · ${title}` : 'schedule' };
      }
      if (action === 'resume') {
        return { verb: 'resumed', object: title ? `schedule · ${title}` : 'schedule' };
      }
      if (action === 'replace_events') {
        return { verb: 'updated', object: 'event subscriptions' };
      }
      const fallback = summaryFallback(args);
      if (fallback) return { ...fallback, observational: fallback.verb === 'listed' || fallback.verb === 'checked' };
      return { verb: 'checked', object: 'schedules', observational: true };
    }
    if (tool === 'read') {
      const map: Record<string, McpCallDescription> = {
        messages: { verb: 'read', object: 'chat messages', observational: true },
        message: { verb: 'read', object: 'message', observational: true },
        addresses: { verb: 'listed', object: 'chats', observational: true },
        threads: { verb: 'listed', object: 'threads', observational: true },
        members: { verb: 'listed', object: 'members', observational: true },
        brief: { verb: 'read', object: 'thread brief', observational: true },
        status: { verb: 'checked', object: 'thread status', observational: true },
        checks: { verb: 'checked', object: 'PR checks', observational: true },
        pr: { verb: 'read', object: 'pull request', observational: true },
        attachment: { verb: 'read', object: 'attachment', observational: true },
        usage: { verb: 'checked', object: 'usage', observational: true },
        procedure: {
          verb: 'read',
          object: slug ? `procedure · ${slug}` : 'procedure',
          observational: true,
        },
        session: {
          verb: 'read',
          object: slug === 'prepare' ? 'session setup' : 'session',
          observational: true,
        },
      };
      if (facet && map[facet]) return map[facet]!;
      return summaryFallback(args) ?? { verb: 'read', object: target || 'Beeline', observational: true };
    }
    if (tool === 'search') {
      const scope = field(args, ['scope'])?.toLowerCase();
      const base = scope === 'memory' ? 'memory' : scope === 'history' ? 'history' : 'Beeline';
      return {
        verb: 'found',
        object: query ? `${base} · ${query}` : base,
        observational: true,
      };
    }
    if (tool === 'message') {
      const type = field(args, ['type'])?.toLowerCase();
      if (type === 'reply') return { verb: 'replied', object: target || 'message' };
      if (type === 'blocked') return { verb: 'reported', object: 'blocker' };
      return { verb: 'sent', object: target || 'message' };
    }
    if (tool === 'open_thread') {
      return { verb: 'opened', object: title ? `thread · ${title}` : 'thread' };
    }
    if (tool === 'revise_thread') {
      return { verb: 'updated', object: title ? `thread · ${title}` : 'thread' };
    }
    if (tool === 'close_thread') return { verb: 'closed', object: 'thread' };
    if (tool === 'claim_thread') return { verb: 'claimed', object: 'thread' };
    if (tool === 'approve_merge') return { verb: 'approved', object: 'merge' };
    if (tool === 'set_thread_hold') return { verb: 'updated', object: 'merge hold' };
    if (tool === 'create_work_item') {
      return { verb: 'created', object: title ? `task · ${title}` : 'task' };
    }
    if (tool === 'update_work') {
      return { verb: 'updated', object: title ? `task · ${title}` : 'task' };
    }
    if (tool === 'close_ask') return { verb: 'closed', object: 'ask' };
    if (tool === 'remember') {
      const kind = field(args, ['kind'])?.toLowerCase();
      const item = kind === 'procedure' ? (slug ? `procedure · ${slug}` : 'procedure') : 'memory';
      if (action === 'used') return { verb: 'used', object: item, observational: true };
      if (action === 'update') return { verb: 'updated', object: item };
      if (action === 'delete') return { verb: 'deleted', object: item };
      return { verb: 'saved', object: item };
    }
    if (tool === 'post_artifact') {
      return { verb: 'posted', object: title || (path ? displayFilePath(path) : 'artifact') };
    }
    if (tool === 'connect') {
      const mode = field(args, ['mode'])?.toLowerCase();
      const service = field(args, ['service', 'query']);
      if (mode === 'ensure') return { verb: 'connected', object: service || 'service' };
      return { verb: 'checked', object: service || 'connections', observational: true };
    }
    if (tool === 'app_tool') {
      const app = field(args, ['app']);
      const subTool = field(args, ['tool']);
      if (!subTool) {
        return { verb: 'listed', object: app ? `${app} tools` : 'app tools', observational: true };
      }
      return { verb: 'ran', object: [app, subTool].filter(Boolean).join(' · ') };
    }
    if (tool === 'workspace') return { verb: 'prepared', object: 'workspace' };
    if (tool === 'request_grant') {
      const mode = field(args, ['mode'])?.toLowerCase();
      if (mode === 'list') return { verb: 'listed', object: 'grants', observational: true };
      return { verb: 'requested', object: field(args, ['action', 'target']) || 'grant' };
    }
    if (tool === 'run_granted_command') return { verb: 'ran', object: target || 'granted command' };
    if (tool === 'report_feedback') return { verb: 'reported', object: 'feedback' };
    if (tool === 'stop') return { verb: 'stopped', object: target || 'agent' };
    if (tool === 'dispatch_release') return { verb: 'dispatched', object: 'release' };
    if (tool === 'scratch_io') {
      return {
        verb: action === 'image' ? 'fetched' : 'wrote',
        object: path ? displayFilePath(path) : 'scratch file',
      };
    }
    return summaryFallback(args) ?? { verb: 'ran', object: mcp.tool.replace(/_/g, ' ') };
  }

  if (server === 'beeline-readonly-mcp') {
    if (tool === 'repository_io') {
      if (action === 'read' || action === 'skill') {
        return { verb: 'read', object: path ? displayFilePath(path) : 'file', observational: true };
      }
      if (action === 'files') {
        return { verb: 'listed', object: path ? displayFilePath(path) : 'files', observational: true };
      }
      if (action === 'search') {
        return { verb: 'found', object: query || 'code', observational: true };
      }
      if (action && ['log', 'show', 'diff', 'status'].includes(action)) {
        return { verb: 'git', object: action, observational: true };
      }
    }
    if (tool === 'read_file' || tool === 'read_agent_file') {
      return { verb: 'read', object: path ? displayFilePath(path) : 'file', observational: true };
    }
    if (tool === 'list_files') {
      return { verb: 'listed', object: path ? displayFilePath(path) : 'files', observational: true };
    }
    if (tool === 'search_text') {
      return { verb: 'found', object: query || 'code', observational: true };
    }
    if (tool.startsWith('git_')) {
      return { verb: 'git', object: tool.slice(4), observational: true };
    }
    return { verb: 'read', object: path ? displayFilePath(path) : mcp.tool.replace(/_/g, ' '), observational: true };
  }

  if (server === 'codegraph') {
    return { verb: 'found', object: query || 'code graph', observational: true };
  }

  const fallback = summaryFallback(args);
  if (fallback) return fallback;

  const commandArg = command
    ? peelShellCommand(command)
        .replace(/^(?:mcp__[\w.-]+__[\w.-]+|mcp\.[\w-]+\.[\w.-]+|mcp_[\w.-]+)\s*/i, '')
        .trim()
    : '';
  const argTarget =
    commandArg ||
    (path ? displayFilePath(path) : undefined) ||
    query ||
    title ||
    target ||
    (input && !input.trim().startsWith('{') ? oneLine(input) : '') ||
    mcp.server;
  return { verb: mcp.tool, object: argTarget, namedTool: true };
}

function searchPattern(step: TurnActivityAction): string | undefined {
  const fromInput = field(parsed(step.input), ['pattern', 'query', 'regex', 'q', 'search']);
  if (fromInput) return fromInput;
  if (step.input && !step.input.trim().startsWith('{')) return step.input;
  return undefined;
}

/** `12 matches` in the tool's own result — never a count the client invented. */
function hitCount(output: readonly string[]): string | undefined {
  for (const line of output) {
    const hits = line.match(/\b(\d+)\s+(?:matches?|results?|hits?)\b/i);
    if (hits) return `${hits[1]} hits`;
  }
  return undefined;
}

const TEXT_KEYS = [
  'formatted_output',
  'stdout',
  'stderr',
  'output',
  'text',
  'content',
  'message',
  'result',
] as const;

function textLeaves(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(textLeaves);
  if (value && typeof value === 'object') {
    return TEXT_KEYS.flatMap((key) =>
      key in (value as Record<string, unknown>)
        ? textLeaves((value as Record<string, unknown>)[key])
        : [],
    );
  }
  return [];
}

/** Older rows could be cut in the middle of a JSON string. Recover only the
 * known output field, stopping at its closing quote or the end of the row. */
function legacyTruncatedText(raw: string): string | undefined {
  const match =
    /"(?:formatted_output|stdout|stderr|output|text|content|message|result)"\s*:\s*"/.exec(raw);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  let encoded = '';
  for (let index = start; index < raw.length; index++) {
    const char = raw[index]!;
    if (char === '"') break;
    if (char === '\\' && index + 1 < raw.length) {
      encoded += char + raw[++index];
    } else {
      encoded += char;
    }
  }
  // Decode a complete escape at a time. A dangling escape or partial unicode
  // escape remains literal instead of making the entire legacy row disappear.
  return encoded.replace(/\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (escape) => {
    try {
      return JSON.parse(`"${escape}"`) as string;
    } catch {
      return escape;
    }
  });
}

/**
 * The call's real output, or nothing.
 *
 * A terminal-backed execute returns `[{"type":"terminal","terminalId":"exec-…"}]`
 * — a machine identifier the reader can do nothing with. Showing nothing is the
 * honest rendering of "we were handed a handle, not a result".
 */
export function toolCallOutput(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const envelope = parsed(raw);
  const text =
    envelope === undefined ? (legacyTruncatedText(raw) ?? raw) : textLeaves(envelope).join('\n');
  if (!text.trim()) return [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trimEnd());
  return lines;
}

/** `1.4s`, `2m 05s` — tabular, and only ever shown above the floor. */
export function formatToolCallDuration(ms: number | undefined): string | undefined {
  if (!ms || ms < TOOL_CALL_DURATION_FLOOR_MS) return undefined;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

function verbAndObject(step: TurnActivityAction, output: readonly string[]) {
  const kind = step.toolKind?.toLowerCase();
  const mcp = parseMcpTool(step.title, step.command, step.input);
  const file =
    step.files?.[0]?.path ??
    field(parsed(step.input), ['path', 'file_path', 'filePath', 'filename']);

  if (mcp) {
    const described = describeMcpCall(mcp, step.input, step.command);
    return { verb: described.verb, object: described.object, namedTool: described.namedTool };
  }

  if (step.command) {
    const command = peelShellCommand(step.command);
    const git = command.match(/^git\s+(.+)$/i);
    if (git) return { verb: 'git', object: redactDisplayPaths(git[1] ?? command) };
    return { verb: 'ran', object: redactDisplayPaths(command) };
  }

  if (kind === 'search' || kind === 'searched' || kind === 'grep') {
    const pattern = searchPattern(step);
    const hits = hitCount(output);
    const object = [pattern, hits].filter(Boolean).join(' · ');
    return { verb: 'found', object: object || titleObject(step) };
  }

  if (kind === 'execute' && step.title && !GENERIC_SHELL_TITLES.test(oneLine(step.title))) {
    const peeled = peelShellCommand(step.title);
    const git = peeled.match(/^git\s+(.+)$/i);
    if (git) return { verb: 'git', object: redactDisplayPaths(git[1] ?? peeled) };
    return { verb: 'ran', object: redactDisplayPaths(peeled) };
  }

  if (kind && KIND_VERBS[kind] && file) {
    return { verb: KIND_VERBS[kind], object: displayFilePath(file) };
  }
  if (file) {
    return { verb: KIND_VERBS[kind ?? ''] ?? 'read', object: displayFilePath(file) };
  }

  const rollup = oneLine(step.title).match(/^(\w+ing)\s+(\d+)$/i);
  if (rollup) {
    const participle = rollup[1]?.toLowerCase() ?? '';
    return {
      verb: PARTICIPLE_VERBS[participle] ?? KIND_VERBS[kind ?? ''] ?? 'ran',
      object: `${rollup[2]} calls`,
    };
  }
  return { verb: KIND_VERBS[kind ?? ''] ?? 'ran', object: titleObject(step) };
}

/** The harness title, stripped of the verb the column already carries. */
function titleObject(step: TurnActivityAction): string {
  const title = redactDisplayPaths(
    oneLine(step.title)
      .replace(/^#+\s*/, '')
      .replace(/^\*\*|\*\*$/g, ''),
  );
  return title.replace(TITLE_VERB, '') || title;
}

/** The action word shown beside a tool's machine text. */
export function toolCallVerb(step: TurnActivityAction): string {
  return verbAndObject(step, toolCallOutput(step.output)).verb;
}

/**
 * The ledger line's label (owner-approved tool-ledger design, 2026-08-24): the
 * call's object — the command, the file, the search pattern with its hit
 * count — cut to the label cap. The row displays the generic action separately,
 * so its label omits that word. Tool-specific names remain part of the label.
 */
export function toolCallLabel(step: TurnActivityAction): string {
  const output = toolCallOutput(step.output);
  const { verb, object, namedTool } = verbAndObject(step, output);
  const generic = !namedTool && GENERIC_LEDGER_VERBS.has(verb);
  const label = generic ? object : `${verb} ${object}`;
  return middleTruncate(oneLine(label) || 'tool call', TOOL_CALL_LABEL_MAX);
}

import {
  formatMessageTarget,
  humanizeAppName,
  isRawHex64,
  isRawUuid,
  parseAgentAddress,
  resolveMemberLabel,
  resolvePlaceLabel,
  sanitizeIdsInText,
  summarizeScheduleListOutput,
  type ToolIdentityLookup,
} from './tool-identity-lookup';
import {
  displayFileLocation,
  displayFilePath,
  redactDisplayPaths,
  stripRecognizedDisplayPrefix,
} from './tool-display-paths';

export { displayFileLocation, displayFilePath, redactDisplayPaths, stripRecognizedDisplayPrefix };

/**
 * Shell command unwrapping, read-only classification, disambiguated file paths,
 * and cross-harness MCP call formatting for the mobile tool ledger.
 */

const KNOWN_MCP_SERVERS = [
  'beeline-readonly-mcp',
  'beeline_readonly_mcp',
  'beeline-agent',
  'beeline_agent',
  'codegraph',
  'squire',
] as const;

const READ_ONLY_SHELL_COMMANDS = new Set([
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

const GIT_WRITE_OR_EXEC_FLAG = /^(?:-o|--output(?:=|$)|--ext-diff$|--exec-path(?:=|$))/;

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
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

/**
 * `env A=b bash -lc 'cd /repo && rg foo apps/'` -> `rg foo apps/`.
 * Preserves internal newlines so multiline shell commands never merge into one line.
 */
export function peelShellCommand(command: string): string {
  let current = normalizeNewlines(command);
  for (let pass = 0; pass < 5; pass += 1) {
    const before = current;
    current = current.replace(
      /^(?:(?:\/[\w.-]+)*\/)?env[ \t]+(?:(?:-u[ \t]+\S+[ \t]+)|(?:--[ \t]+)|(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)[ \t]+))+/i,
      '',
    );
    current = current.replace(
      /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)[ \t]+)+/,
      '',
    );
    const shellWrap = current.match(
      /^(?:(?:\/[\w.-]+)*\/)?(?:bash|sh|zsh)[ \t]+(?:(?:--login[ \t]+)?-[a-zA-Z]*c[a-zA-Z]*|--command)[ \t]+([\s\S]+)$/i,
    );
    if (shellWrap?.[1]) {
      current = normalizeNewlines(unquoteShellArg(shellWrap[1]));
    }
    current = current.replace(
      /^cd[ \t]+(?:'[^']*'|"[^"]*"|[^\s;&|]+)[ \t]*(?:&&|;|\n)[ \t]*/,
      '',
    );
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
      if (ch !== '\n') current += ch;
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
        if (next === '\n') {
          i += 1;
          continue;
        }
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
      if (next === '\n') {
        i += 1;
        continue;
      }
      escaped = true;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '#' && (!current.length || /\s$/.test(current))) {
      while (i < command.length && command[i] !== '\n') i += 1;
      if (current.trim()) {
        segments.push(current.trim());
        current = '';
      }
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
    if (ch === ';' || ch === '\n') {
      if (current.trim()) segments.push(current.trim());
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
  if (bin === 'rg') {
    return args.some((arg) => arg === '--pre' || arg.startsWith('--pre=')) ? false : 'read';
  }
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
      if (arg === '-c' || arg.startsWith('--config-env') || arg.startsWith('--exec-path')) {
        return false;
      }
      if (arg === '-C' || arg === '--git-dir' || arg === '--work-tree') {
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
    if (rest.some((arg) => GIT_WRITE_OR_EXEC_FLAG.test(arg))) return false;
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
 * with no output redirection, command substitution, newline-separated writes,
 * or write flags.
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

function parsedJson(value: string | undefined): unknown {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function readField(value: unknown, keys: readonly string[]): string | undefined {
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
  const envelope = parsedJson(input);
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
  /** Structured post-condition receipt from a completed beeline-agent tool result. */
  receipt?: string;
  /** Keep generous label width for resolved targets / handoffs. */
  expandedLabel?: boolean;
};

const STRUCTURED_RECEIPT_VERBS: Readonly<Record<string, string>> = {
  created: 'created',
  updated: 'updated',
  deleted: 'deleted',
  paused: 'paused',
  resumed: 'resumed',
  cleared: 'cleared',
  opened: 'opened',
  revised: 'revised',
  installed: 'installed',
  renamed: 'renamed',
  closed: 'closed',
  claimed: 'claimed',
  set: 'set',
  released: 'released',
  sent: 'sent',
  replied: 'replied',
  reported: 'reported',
  asked: 'asked',
  listed: 'listed',
  approved: 'approved',
  stopped: 'stopped',
};

function unwrapMcpOutputObject(output: string | undefined): Record<string, unknown> | undefined {
  let current: unknown = parsedJson(output);
  for (let depth = 0; depth < 4; depth += 1) {
    if (Array.isArray(current)) {
      const textItem = current.find(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          !Array.isArray(entry) &&
          (typeof (entry as Record<string, unknown>).text === 'string' ||
            ((entry as Record<string, unknown>).content &&
              typeof (entry as Record<string, unknown>).content === 'object')),
      ) as Record<string, unknown> | undefined;
      if (!textItem) return undefined;
      if (typeof textItem.text === 'string') {
        current = parsedJson(textItem.text);
        continue;
      }
      current = textItem.content;
      continue;
    }
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      const rec = current as Record<string, unknown>;
      if (
        typeof rec.text === 'string' &&
        !('receipt' in rec) &&
        !('schedules' in rec) &&
        !('scheduleId' in rec)
      ) {
        const inner = parsedJson(rec.text);
        if (inner !== undefined) {
          current = inner;
          continue;
        }
      }
      return rec;
    }
    return undefined;
  }
  return undefined;
}

function describeScheduleListOutput(
  outputObj: Record<string, unknown>,
): McpCallDescription | undefined {
  const summary = summarizeScheduleListOutput(outputObj);
  if (!summary) return undefined;
  return {
    verb: 'listed',
    object: summary.object,
    observational: true,
    ...(summary.receipt ? { receipt: summary.receipt } : {}),
  };
}

function describeStructuredReceipt(
  outputObj: Record<string, unknown>,
  fallback: McpCallDescription,
  lookup?: ToolIdentityLookup,
): McpCallDescription | undefined {
  const rawReceipt = readField(outputObj, ['receipt']);
  if (!rawReceipt) return undefined;
  const firstLine = sanitizeIdsInText(oneLine(rawReceipt.split('\n')[0] ?? rawReceipt), lookup);
  if (!firstLine) return undefined;
  const space = firstLine.indexOf(' ');
  if (space > 0) {
    const leadWord = firstLine.slice(0, space).toLowerCase();
    const mappedVerb = STRUCTURED_RECEIPT_VERBS[leadWord];
    const rest = firstLine.slice(space + 1).trim();
    if (mappedVerb && rest) {
      return {
        ...fallback,
        verb: mappedVerb,
        object: rest,
        receipt: firstLine,
        expandedLabel: true,
      };
    }
  }
  return {
    ...fallback,
    object: firstLine,
    receipt: firstLine,
    expandedLabel: true,
  };
}

/** Extract structured receipt text from a completed beeline-agent MCP JSON output. */
export function extractMcpReceipt(
  output: string | undefined,
  lookup?: ToolIdentityLookup,
): string | undefined {
  const outputObj = unwrapMcpOutputObject(output);
  if (!outputObj) return undefined;
  const raw = readField(outputObj, ['receipt']);
  return raw ? sanitizeIdsInText(oneLine(raw.split('\n')[0] ?? raw), lookup) : undefined;
}

function mcpArgs(input?: string): Record<string, unknown> | undefined {
  const data = parsedJson(input);
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

function describeToolSummary(args: Record<string, unknown> | undefined): McpCallDescription | undefined {
  const summary = readField(args, ['toolSummary']);
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
      search: 'searched',
      searched: 'searched',
      find: 'searched',
      found: 'searched',
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
  output?: string,
  lookup?: ToolIdentityLookup,
): McpCallDescription {
  const server = normalizedServer(mcp.server);
  const tool = mcp.tool.toLowerCase();
  const args = mcpArgs(input);
  const action = readField(args, ['action'])?.toLowerCase();
  const facet = readField(args, ['facet'])?.toLowerCase();
  const title = readField(args, ['title', 'name']);
  const query = readField(args, ['query', 'pattern']);
  const path = readField(args, ['path', 'file_path', 'filePath', 'filename']);
  const slug = readField(args, ['slug', 'name']);
  const rawTarget = readField(args, ['target', 'address', 'service', 'recipient', 'agent']);
  const rawRoom = readField(args, ['roomId', 'room']);
  const safePlace = resolvePlaceLabel(rawTarget, lookup) ?? resolvePlaceLabel(rawRoom, lookup);
  const safeTarget = rawTarget
    ? isRawHex64(rawTarget)
      ? (resolveMemberLabel(rawTarget, lookup) ?? 'agent')
      : isRawUuid(rawTarget)
        ? (resolvePlaceLabel(rawTarget, lookup) ?? 'thread')
        : sanitizeIdsInText(rawTarget, lookup)
    : undefined;

  if (server === 'beeline-agent') {
    const outputObj = unwrapMcpOutputObject(output);
    const withOutput = (fallback: McpCallDescription): McpCallDescription => {
      if (!outputObj) return fallback;
      const fromReceipt = describeStructuredReceipt(outputObj, fallback, lookup);
      if (fromReceipt) return fromReceipt;
      if (tool === 'wake' && action === 'list') {
        const fromList = describeScheduleListOutput(outputObj);
        if (fromList) return fromList;
      }
      return fallback;
    };
    if (tool === 'wake') {
      if (action === 'list') return withOutput({ verb: 'listed', object: 'schedules', observational: true });
      if (action === 'events') return { verb: 'listed', object: 'wake events', observational: true };
      if (action === 'create') {
        return withOutput({ verb: 'created', object: title ? `schedule · ${title}` : 'schedule' });
      }
      if (action === 'update') {
        return withOutput({ verb: 'updated', object: title ? `schedule · ${title}` : 'schedule' });
      }
      if (action === 'delete') {
        return withOutput({ verb: 'deleted', object: title ? `schedule · ${title}` : 'schedule' });
      }
      if (action === 'pause') {
        return withOutput({ verb: 'paused', object: title ? `schedule · ${title}` : 'schedule' });
      }
      if (action === 'resume') {
        return withOutput({ verb: 'resumed', object: title ? `schedule · ${title}` : 'schedule' });
      }
      if (action === 'replace_events') {
        return withOutput({ verb: 'updated', object: 'event subscriptions' });
      }
      const summary = describeToolSummary(args);
      if (summary) return withOutput({ ...summary, observational: summary.verb === 'listed' || summary.verb === 'checked' });
      return withOutput({ verb: 'checked', object: 'schedules', observational: true });
    }
    if (tool === 'read') {
      const map: Record<string, McpCallDescription> = {
        messages: { verb: 'read', object: safePlace ? `messages in ${safePlace}` : 'chat messages', observational: true },
        message: { verb: 'read', object: 'message', observational: true },
        addresses: { verb: 'listed', object: 'chats', observational: true },
        threads: { verb: 'listed', object: 'threads', observational: true },
        members: { verb: 'listed', object: 'members', observational: true },
        brief: { verb: 'read', object: safePlace ? `${safePlace} brief` : 'thread brief', observational: true },
        status: { verb: 'checked', object: safePlace ? `${safePlace} status` : 'thread status', observational: true },
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
      return describeToolSummary(args) ?? { verb: 'read', object: safeTarget || 'Beeline', observational: true };
    }
    if (tool === 'search') {
      const scope = readField(args, ['scope'])?.toLowerCase();
      const base = scope === 'memory' ? 'memory' : scope === 'history' ? 'history' : 'Beeline';
      return {
        verb: 'searched',
        object: query ? `${base} · ${query}` : base,
        observational: true,
      };
    }
    if (tool === 'message') {
      const type = readField(args, ['type'])?.toLowerCase();
      if (type === 'blocked') return withOutput({ verb: 'reported', object: 'blocker' });
      const msgTarget = formatMessageTarget(rawTarget, rawRoom, lookup);
      if (type === 'reply') {
        const replyObj = msgTarget.agent
          ? msgTarget.place
            ? `to ${msgTarget.agent} in ${msgTarget.place}`
            : `to ${msgTarget.agent}`
          : msgTarget.place
            ? `in ${msgTarget.place}`
            : 'message';
        return withOutput({ verb: 'replied', object: replyObj, expandedLabel: true });
      }
      return withOutput({ verb: 'sent', object: msgTarget.object, expandedLabel: true });
    }
    if (tool === 'reply') {
      const msgTarget = formatMessageTarget(rawTarget, rawRoom, lookup);
      const replyObj = msgTarget.agent
        ? msgTarget.place
          ? `to ${msgTarget.agent} in ${msgTarget.place}`
          : `to ${msgTarget.agent}`
        : msgTarget.place
          ? `in ${msgTarget.place}`
          : 'message';
      return withOutput({ verb: 'replied', object: replyObj, expandedLabel: true });
    }
    if (tool === 'open_thread') {
      return withOutput({ verb: 'opened', object: title ? `thread · ${title}` : 'thread' });
    }
    if (tool === 'revise_thread') {
      return withOutput({ verb: 'updated', object: title ? `thread · ${title}` : safePlace || 'thread' });
    }
    if (tool === 'close_thread') return withOutput({ verb: 'closed', object: safePlace ? `thread · ${safePlace}` : 'thread' });
    if (tool === 'claim_thread') return withOutput({ verb: 'claimed', object: safePlace || 'thread' });
    if (tool === 'approve_merge') return withOutput({ verb: 'approved', object: safePlace ? `merge for ${safePlace}` : 'merge' });
    if (tool === 'set_thread_hold') return withOutput({ verb: 'updated', object: safePlace ? `merge hold on ${safePlace}` : 'merge hold' });
    if (tool === 'create_work_item') {
      return withOutput({ verb: 'created', object: title ? `task · ${title}` : 'task' });
    }
    if (tool === 'update_work') {
      return withOutput({ verb: 'updated', object: title ? `task · ${title}` : 'task' });
    }
    if (tool === 'close_ask') return withOutput({ verb: 'closed', object: 'ask' });
    if (tool === 'remember') {
      const kind = readField(args, ['kind'])?.toLowerCase();
      const item = kind === 'procedure' ? (slug ? `procedure · ${slug}` : 'procedure') : 'memory';
      if (action === 'used') return { verb: 'used', object: item, observational: true };
      if (action === 'update') return withOutput({ verb: 'updated', object: item });
      if (action === 'delete') return withOutput({ verb: 'deleted', object: item });
      return withOutput({ verb: 'saved', object: item });
    }
    if (tool === 'post_artifact') {
      return withOutput({ verb: 'posted', object: title || (path ? displayFilePath(path) : 'artifact') });
    }
    if (tool === 'connect') {
      const mode = readField(args, ['mode'])?.toLowerCase();
      const service = readField(args, ['service', 'query']);
      if (mode === 'ensure') return withOutput({ verb: 'connected', object: service || 'service' });
      return { verb: 'checked', object: service || 'connections', observational: true };
    }
    if (tool === 'app_tool') {
      const app = humanizeAppName(readField(args, ['app']));
      const subTool = readField(args, ['tool']);
      if (!subTool) {
        return {
          verb: query ? 'searched' : 'listed',
          object: app ? `${app} tools` : 'app tools',
          observational: true,
          expandedLabel: true,
        };
      }
      return withOutput({
        verb: 'ran',
        object: [app, subTool.replace(/_/g, ' ')].filter(Boolean).join(' · '),
        expandedLabel: true,
      });
    }
    if (tool === 'workspace') return { verb: 'prepared', object: 'workspace' };
    if (tool === 'request_grant') {
      const mode = readField(args, ['mode'])?.toLowerCase();
      if (mode === 'list') return { verb: 'listed', object: 'grants', observational: true };
      return withOutput({ verb: 'requested', object: readField(args, ['action', 'target']) || 'grant' });
    }
    if (tool === 'run_granted_command') return { verb: 'ran', object: safeTarget || 'granted command' };
    if (tool === 'report_feedback') return withOutput({ verb: 'reported', object: 'feedback' });
    if (tool === 'stop') {
      const parsed = parseAgentAddress(rawTarget, lookup);
      const who = parsed.agent ?? (safeTarget && !safeTarget.startsWith('#') ? safeTarget : 'agent');
      return withOutput({ verb: 'stopped', object: parsed.place ? `${who} in ${parsed.place}` : who });
    }
    if (tool === 'dispatch_release') return withOutput({ verb: 'dispatched', object: 'release' });
    if (tool === 'scratch_io') {
      return {
        verb: action === 'image' ? 'fetched' : 'wrote',
        object: path ? displayFilePath(path) : 'scratch file',
      };
    }
    return withOutput(describeToolSummary(args) ?? { verb: 'ran', object: mcp.tool.replace(/_/g, ' ') });
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
        return { verb: 'searched', object: query || 'code', observational: true };
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
      return { verb: 'searched', object: query || 'code', observational: true };
    }
    if (tool.startsWith('git_')) {
      return { verb: 'git', object: tool.slice(4), observational: true };
    }
    return { verb: 'read', object: path ? displayFilePath(path) : mcp.tool.replace(/_/g, ' '), observational: true };
  }

  if (server === 'codegraph') {
    return { verb: 'searched', object: query || 'code graph', observational: true };
  }

  const summary = describeToolSummary(args);
  if (summary) return summary;

  const commandArg = command
    ? oneLine(peelShellCommand(command))
        .replace(/^(?:mcp__[\w.-]+__[\w.-]+|mcp\.[\w-]+\.[\w.-]+|mcp_[\w.-]+)\s*/i, '')
        .trim()
    : '';
  const argTarget =
    commandArg ||
    (path ? displayFilePath(path) : undefined) ||
    query ||
    title ||
    safeTarget ||
    (input && !input.trim().startsWith('{') ? oneLine(input) : '') ||
    mcp.server;
  return { verb: mcp.tool, object: argTarget, namedTool: true };
}

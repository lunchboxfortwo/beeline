import { systemMessage } from './system-message-catalog.js';
/**
 * Agent Grants (design note: "Agent Grants", 3 Sep 2026): the one shared
 * vocabulary for the grant loop. The server stores grants, the phone decides
 * them, and the daemon acts on them; every side imports these names so a kind,
 * a status, a decision line, or a command rule means exactly one thing.
 */

export const AGENT_GRANT_KINDS = [
  'path',
  'host',
  'secret',
  'device',
  'budget',
  'command',
  'mcp',
  'repository',
  'shared_asset',
] as const;
export type AgentGrantKind = (typeof AGENT_GRANT_KINDS)[number];

/** Budget and repository are retained for historical records, but cannot create new prompts. */
export const REQUESTABLE_AGENT_GRANT_KINDS = AGENT_GRANT_KINDS.filter(
  (kind) => kind !== 'budget' && kind !== 'repository',
);
export function isRequestableAgentGrantKind(
  value: unknown,
): value is (typeof REQUESTABLE_AGENT_GRANT_KINDS)[number] {
  return (
    typeof value === 'string' &&
    (REQUESTABLE_AGENT_GRANT_KINDS as readonly string[]).includes(value)
  );
}

export const AGENT_GRANT_STATUSES = ['pending', 'approved', 'once', 'denied', 'revoked'] as const;
export type AgentGrantStatus = (typeof AGENT_GRANT_STATUSES)[number];

/** The owner's three taps on the card. */
export type AgentGrantDecision = 'always' | 'once' | 'deny';

export const AGENT_GRANT_TARGET_MAX_LENGTH = 512;
export const AGENT_GRANT_REASON_MAX_LENGTH = 1_000;

/** Display copy for legacy cards that predate the stored product name. */
export function connectionInstallName(grant: { kind: AgentGrantKind; target: string; appName?: string }): string | undefined {
  if (grant.kind !== 'mcp' || !grant.target.startsWith('connection-install:')) return undefined;
  const key = grant.target.slice('connection-install:'.length);
  return grant.appName ?? (key === 'github' ? systemMessage("agent-grants.github")
    : key ? key.charAt(0).toUpperCase() + key.slice(1) : systemMessage("agent-grants.this-app"));
}

export function isAgentGrantKind(value: unknown): value is AgentGrantKind {
  return typeof value === 'string' && (AGENT_GRANT_KINDS as readonly string[]).includes(value);
}

export function isAgentGrantStatus(value: unknown): value is AgentGrantStatus {
  return typeof value === 'string' && (AGENT_GRANT_STATUSES as readonly string[]).includes(value);
}

/** The verb the card and the profile print in front of a target, per kind. */
export const AGENT_GRANT_VERBS: Readonly<Record<AgentGrantKind, string>> = {
  path: 'read',
  host: 'reach',
  secret: 'use',
  device: 'use',
  budget: 'spend',
  command: 'run',
  mcp: 'use',
  repository: 'edit',
  shared_asset: 'isolate',
};

/** Only these whole cache trees may be made private for one agent. */
export const SHARED_ASSET_CATEGORIES = [
  'package-cache',
  'codex-download-cache',
  'codex-plugin-cache',
] as const;
export type SharedAssetCategory = (typeof SHARED_ASSET_CATEGORIES)[number];
export function isSharedAssetCategory(value: unknown): value is SharedAssetCategory {
  return typeof value === 'string' &&
    (SHARED_ASSET_CATEGORIES as readonly string[]).includes(value);
}

/**
 * A command grant is one exact line the agent may say. Shell metacharacters are
 * refused at request time so a rule can never smuggle a second command, a
 * redirect, or an expansion past the prefix match. Secrets ride as a
 * `--with NAME` suffix, one name per `--with`, and are stripped from the argv.
 */
const SHELL_METACHARACTERS = /[;&|<>$`\\'"(){}\n\r\t*?[\]~#!]/;

/** One secret name a `--with` suffix or `store_secret` may carry. */
export const COMMAND_SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

export type CommandGrantRule = {
  readonly stdin?: string;
  /** The approved argv prefix, shell-word split on single spaces. */
  readonly argv: readonly string[];
  /** Secret names the rule names with `--with NAME`. */
  readonly secrets: readonly string[];
};

/**
 * Parse and validate a `command` grant target. Throws a plain sentence on any
 * refusal (empty, metacharacters, malformed `--with`), so both the daemon tool
 * and the server reject the same targets with the same words.
 */
export function parseCommandGrantTarget(target: string): CommandGrantRule {
  if (typeof target !== 'string' || !target.trim()) {
    throw new Error('command target is required');
  }
  // A JSON argv preserves inline code as one literal argument. It is never
  // evaluated by a shell; the legacy single-space grammar remains unchanged.
  if (target.startsWith('[') || target.startsWith('{')) {
    const parsed = JSON.parse(target);
    const argv: unknown = Array.isArray(parsed) ? parsed : parsed.argv;
    if (!Array.isArray(argv) || !argv.length || argv.length > 256 ||
        argv.some(word => typeof word !== 'string' || !word || word.length > 4096 || /[\0\r]/.test(word))) {
      throw new Error('command target must be a bounded JSON argv array');
    }
    const stdin = Array.isArray(parsed) ? undefined : parsed.stdin;
    if (stdin !== undefined && (typeof stdin !== 'string' || stdin.length > 4096 || /\0/.test(stdin)))
      throw new Error('command stdin must be bounded text');
    return { argv, secrets: [], ...(stdin !== undefined ? { stdin } : {}) };
  }
  if (target !== target.trim() || /\s{2,}/.test(target)) {
    throw new Error('command target must be one line with single spaces');
  }
  if (SHELL_METACHARACTERS.test(target)) {
    throw new Error('command target must not contain shell metacharacters');
  }
  const words = target.split(' ');
  const argv: string[] = [];
  const secrets: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === '--with') {
      const name = words[index + 1];
      if (!name || !COMMAND_SECRET_NAME.test(name)) {
        throw new Error('--with must name one UPPER_CASE secret');
      }
      if (!secrets.includes(name)) secrets.push(name);
      index += 1;
      continue;
    }
    if (secrets.length) throw new Error('--with suffixes must come after the command words');
    argv.push(word);
  }
  if (!argv.length) throw new Error('command target must name a command');
  return { argv, secrets };
}

/** The approved argv must be a prefix of the requested argv, word for word. */
export function commandGrantMatches(rule: CommandGrantRule, requested: readonly string[]): boolean {
  if (requested.length < rule.argv.length) return false;
  return rule.argv.every((word, index) => requested[index] === word);
}

/**
 * The system line the server posts when the owner answers a card. It mentions
 * the agent so the daemon inbox delivers it, and the daemon recognises it
 * structurally through `parseGrantDecisionLine` (plain system lines never wake
 * a turn). Shape: `<name> approved command fly deploy -a preview`.
 */
export type GrantDecisionLine = {
  readonly deciderName: string;
  readonly decision: AgentGrantDecision;
  readonly kind: AgentGrantKind;
  readonly target: string;
};

const DECISION_VERBS: Readonly<Record<AgentGrantDecision, string>> = {
  always: 'approved',
  once: 'approved once',
  deny: 'declined',
};

export function formatGrantDecisionLine(line: GrantDecisionLine): string {
  return `${line.deciderName} ${DECISION_VERBS[line.decision]} ${line.kind} ${line.target}`;
}

const DECISION_LINE = new RegExp(
  `^(.+?) (approved once|approved|declined) (${AGENT_GRANT_KINDS.join('|')}) (.+)$`,
  's',
);

export function parseGrantDecisionLine(body: string): GrantDecisionLine | undefined {
  const match = DECISION_LINE.exec(body);
  if (!match) return undefined;
  const decision: AgentGrantDecision =
    match[2] === 'approved once' ? 'once' : match[2] === 'approved' ? 'always' : 'deny';
  return {
    deciderName: match[1]!,
    decision,
    kind: match[3] as AgentGrantKind,
    target: match[4]!,
  };
}

/**
 * The two hard stops (C94).
 *
 * Trust is granted once, by scope: yolo is that gate, and with it on a granted
 * command just runs — no card, no wait. Per-command approval is more friction
 * than the tools this competes with, and the captain already answered the
 * question when he turned yolo on.
 *
 * Exactly two shapes survive that gate, in a Room and in a corner alike,
 * because reading the transcript afterwards cannot undo them:
 *
 * - `credential`: a credential or environment file, read or written. Matched on
 *   argv words — it catches the shapes below by name, and it does NOT catch a
 *   file reached through an alias, a symlink, a variable the daemon never sees,
 *   or a program that opens one of its own accord.
 * - `unseen-script`: an interpreter or shell over a file whose contents nobody
 *   has read. `python3 fix.py` tells the person deciding nothing about what will
 *   run, so the card carries the script itself and the approval binds to those
 *   bytes ({@link CommandGrantScript}). An interpreter line with no such file
 *   (`python3 -V`) is not a hard stop: there is nothing unseen about it.
 *
 * A wrapper (`env`, `xargs`, `sudo`, …) is deliberately NOT a stop of its own —
 * that was friction with no incident behind it — but the script lookup sees
 * straight through one, so `env python3 fix.py` still binds to `fix.py`.
 */
export const AGENT_GRANT_ESCALATIONS = ['unseen-script', 'credential'] as const;
export type AgentGrantEscalation = (typeof AGENT_GRANT_ESCALATIONS)[number];

export const AGENT_GRANT_ESCALATION_REASONS: Readonly<Record<AgentGrantEscalation, string>> = {
  'unseen-script': 'it runs a script whose contents nobody has read',
  credential: 'it names a credential or environment file',
};

/** One sentence naming why a human has to answer, for a card and for a refusal. */
export function formatGrantEscalationReason(
  escalations: readonly AgentGrantEscalation[],
): string | undefined {
  if (!escalations.length) return undefined;
  return escalations.map((entry) => AGENT_GRANT_ESCALATION_REASONS[entry]).join(' and ');
}

/** Shells and language runtimes: they execute a file the command line does not describe. */
const INTERPRETER_COMMANDS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'ash',
  'csh',
  'tcsh',
  'fish',
  'busybox',
  'python',
  'python2',
  'python3',
  'py',
  'pypy',
  'pypy3',
  'node',
  'nodejs',
  'deno',
  'bun',
  'ts-node',
  'tsx',
  'ruby',
  'irb',
  'perl',
  'php',
  'lua',
  'luajit',
  'r',
  'rscript',
  'osascript',
  'pwsh',
  'powershell',
  'cmd',
]);

/** Wrappers whose real command is an argument; the script lookup steps over them. */
export const COMMAND_WRAPPERS = new Set([
  'env',
  'xargs',
  'nohup',
  'setsid',
  'time',
  'timeout',
  'watch',
  'script',
  'sudo',
  'doas',
  'nice',
  'ionice',
  'stdbuf',
]);

/** Basenames whose whole point is holding a secret. */
const CREDENTIAL_BASENAMES = new Set([
  '.env',
  '.envrc',
  '.flaskenv',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.pgpass',
  '.npmrc',
  '.pypirc',
  '.secrets.env',
  '.htpasswd',
  '.dockercfg',
  'credentials',
  'credentials.json',
  'secrets.json',
  'providers.json',
]);

/**
 * Directory names that ARE a key store; a path through one is a credential path.
 *
 * `beeline` is deliberately absent: the same name covers the operator's key
 * store AND every agent's state tree, so it is matched by its parent instead
 * ({@link isBeelineKeyStore}).
 */
const CREDENTIAL_DIRECTORIES = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.gcloud',
  '.docker',
  'keyrings',
  'gh',
  'trusty-squire',
]);

/**
 * The Beeline operator key store is `$XDG_CONFIG_HOME/beeline` — by default
 * `~/.config/beeline` — holding `providers.json`, `secrets.json` and operator
 * key files. Its known store files are matched by basename anywhere; this
 * catches an operator key file whose name no basename rule knows, when it sits
 * under the default config root. The Beeline STATE tree
 * (`~/.local/state/beeline/agents/<agent>/...`,
 * `.../beeline/corners/<corner>`) is every agent's work area, scratch and
 * corner checkout, so the bare name `beeline` is not a key store there.
 */
function isBeelineKeyStore(segments: readonly string[]): boolean {
  return segments.some((segment, index) => {
    if (segment.toLowerCase() !== 'beeline' || index === 0) return false;
    return segments[index - 1]!.toLowerCase() === '.config';
  });
}

/**
 * The files directly inside an agent's runtime folder — `beeline/agents/<id>/`
 * — hold the agent's own identity secret keys (`runtime.json`, written by
 * `storeIdentity` in `apps/body/src/runtime.ts`). Everything deeper is the
 * agent's work area (rooms, scratch, workspace, corner checkouts), so only a
 * path that ends exactly one level below the agent folder is a credential
 * path.
 */
function isAgentRuntimeFile(segments: readonly string[]): boolean {
  return segments.some(
    (segment, index) =>
      segment.toLowerCase() === 'beeline' &&
      segments[index + 1]?.toLowerCase() === 'agents' &&
      index + 3 === segments.length - 1,
  );
}

const CREDENTIAL_EXTENSIONS = /\.(pem|p12|pfx|key|jks|keystore|kdbx|asc|gpg|ppk|crt|pkcs12)$/i;
const CREDENTIAL_WORD =
  /(^|[-_.])(secret|secrets|credential|credentials|password|passwd|token|apikey|api_key|keystore|privatekey)([-_.]|$)/i;
const ENV_FILE = /(^|[.\-_])env(\.|$)|^\.env/i;

function commandBasename(word: string): string {
  const tail = word.split(/[/\\]/).pop() ?? word;
  return tail.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

/** Strip a `--flag=` prefix so `--env-file=.env` is read as the path it carries. */
function pathArgument(word: string): string {
  const equals = word.indexOf('=');
  return word.startsWith('-') && equals > 0 ? word.slice(equals + 1) : word;
}

function namesCredential(word: string): boolean {
  const value = pathArgument(word);
  if (!value) return false;
  const segments = value.split(/[/\\]/).filter(Boolean);
  const base = (segments[segments.length - 1] ?? '').toLowerCase();
  if (!base) return false;
  if (CREDENTIAL_BASENAMES.has(base)) return true;
  if (base.startsWith('.env')) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(base)) return true;
  if (CREDENTIAL_EXTENSIONS.test(base)) return true;
  if (CREDENTIAL_WORD.test(base)) return true;
  if (base.endsWith('.env') || ENV_FILE.test(base)) return true;
  // A path THROUGH a key store, e.g. ~/.ssh/config or ~/.config/gh/hosts.yml.
  if (segments.slice(0, -1).some((segment) => CREDENTIAL_DIRECTORIES.has(segment.toLowerCase()))) {
    return true;
  }
  // A path through the Beeline operator config directory, but not its state tree.
  if (isBeelineKeyStore(segments)) return true;
  // A file directly inside an agent's runtime folder holds its identity keys.
  return isAgentRuntimeFile(segments);
}

/**
 * Does this argv name a credential or environment file? argv[0] is the command,
 * never a file it opens: `env FOO=1 npm test` wraps a command, it names nothing.
 */
export function namesCredentialFile(argv: readonly string[]): boolean {
  return argv.slice(1).some(namesCredential);
}

/**
 * The hard stops this argv falls into, given what the deciding human has
 * already seen. `seenScript` is the script bytes an existing approval is bound
 * to; pass it at run time so an approved script is no longer "unseen".
 */
export function commandGrantEscalations(
  argv: readonly string[],
  options: { hasScript?: boolean } = {},
): AgentGrantEscalation[] {
  const found = new Set<AgentGrantEscalation>();
  if (options.hasScript) found.add('unseen-script');
  if (namesCredentialFile(argv) || namesEnvSecret(argv)) found.add('credential');
  return AGENT_GRANT_ESCALATIONS.filter((entry) => found.has(entry));
}

/**
 * Read-only commands that skip the approval card. A full diff, a patch, or
 * `git show` of a blob can print a file, so only status, log, and summary
 * forms are listed. `gh pr diff` asks. Anything that names a credential file
 * or an env secret still asks. Inline eval and every other writable script
 * still ask.
 */
export const PREAPPROVED_READ_ONLY_COMMANDS = [
  'gh pr view',
  'gh pr checks',
  'gh pr list',
  'git status',
  'git log',
  'git diff --stat',
  'git show --stat',
] as const;

/** A raw git object id, including a short hash. `git show --stat` still prints a blob. */
function gitObjectId(word: string): boolean {
  return /^[0-9a-f]{1,64}$/i.test(word);
}

/** Flags that turn a summary into a full patch. */
function patchFlag(word: string): boolean {
  return /^(?:-p|-u|--patch|--raw|-c|--cc|-m|-W|--function-context|--word-diff(?:-regex(?:=.*)?)?|--color-words|--patch-with-raw|--patch-with-stat)$/.test(word)
    || /^-U\d*$/.test(word)
    || /^--unified(?:=.*)?$/.test(word);
}

function namesEnvSecret(argv: readonly string[]): boolean {
  return argv.slice(1).some((word) =>
    /^(?:--with|--env)(?:=|$)/.test(word) ||
    /^(?:printenv|env)$/i.test(word) ||
    /^[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)=/i.test(word));
}

function readOnlyTail(words: readonly string[], allow: (word: string, next: () => string | undefined) => boolean): boolean {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    const next = () => words[++index];
    if (!allow(word, next)) return false;
  }
  return true;
}

/** A bare `gh` or `git` with one of the named read-only subcommands and a tight tail. */
export function isPreapprovedReadOnlyCommand(argv: readonly string[]): boolean {
  if (argv[0] !== 'gh' && argv[0] !== 'git') return false;
  if (namesCredentialFile(argv) || namesEnvSecret(argv)) return false;
  if (argv[0] === 'gh') {
    if (argv[1] !== 'pr' || !['view', 'checks', 'list'].includes(argv[2] ?? '')) return false;
    return readOnlyTail(argv.slice(3), (word, next) => {
      if (word === '--comments') return true;
      if (word === '--json') return /^[A-Za-z0-9,]{1,200}$/.test(next() ?? '');
      if (word === '--state') return /^(?:open|closed|merged|all)$/.test(next() ?? '');
      if (word === '--limit') return /^[0-9]{1,4}$/.test(next() ?? '');
      return !word.startsWith('-') && /^[A-Za-z0-9._/#-]{1,200}$/.test(word);
    });
  }
  if (argv[1] === 'diff') {
    const summary = ['--stat', '--name-only', '--shortstat'];
    return argv.length > 2 && argv.slice(2).every((word) => summary.includes(word));
  }
  if (argv[1] === 'show') {
    if (!argv.includes('--stat')) return false;
    return readOnlyTail(argv.slice(2), (word) =>
      word === '--stat' || (revisionWord(word) && !gitObjectId(word)));
  }
  if (!['status', 'log'].includes(argv[1] ?? '')) return false;
  return readOnlyTail(argv.slice(2), (word, next) => {
    if (argv[1] === 'status') return word === '--short' || word === '--branch';
    if (['--oneline', '--shortstat', '-s'].includes(word)) return true;
    if (word === '--max-count' || word === '-n') return /^[0-9]{1,6}$/.test(next() ?? '');
    if (/^-[0-9]{1,6}$/.test(word)) return true;
    return revisionWord(word);
  });
}

/** A git revision, not a path. A dot or slash can name a file, so it asks. */
function revisionWord(word: string): boolean {
  return !word.startsWith('-') && !word.includes('.') && !word.includes('/')
    && /^[A-Za-z0-9_@^{}~-]{1,200}$/.test(word);
}

/**
 * The hard stops the approved RULE itself falls into. `script` is the binding
 * the ask carried: a rule that ships its script is an unseen-script rule, and
 * stays one until a person answers the card that shows it.
 */
export function commandRuleEscalations(
  rule: CommandGrantRule,
  script?: CommandGrantScript,
): AgentGrantEscalation[] {
  // A read-only argv is not an exemption from the script card. An immutable
  // installed executable never arrives with script bytes. A writable launcher
  // still carries those bytes and stays unseen until a person reads them.
  return commandGrantEscalations(rule.argv, {
    hasScript: Boolean(script),
  });
}

/**
 * Extra words a shorter approval never named that print a file or a full patch.
 * An exact approval of those words is the human's decision. A prefix is not.
 * `git show --stat` of a blob is handled at execution, because the hash alone
 * does not say whether the object is a commit.
 */
export function repositoryContentBeyondRule(
  ruleArgv: readonly string[],
  argv: readonly string[],
): boolean {
  const summary = ['--stat', '--name-only', '--shortstat'];
  const printsPatch = (command: readonly string[]) =>
    (command[0] === 'gh' && command[1] === 'pr' && command[2] === 'diff') ||
    (command[0] === 'git' && command[1] === 'show' &&
      (!command.includes('--stat') || command.slice(2).some(patchFlag))) ||
    (command[0] === 'git' && command[1] === 'log' && command.slice(2).some(patchFlag)) ||
    (command[0] === 'git' && command[1] === 'diff' && (command.length === 2 ||
      command.slice(2).some((word) => !summary.includes(word))));
  if (!printsPatch(argv)) return false;
  return ruleArgv.length !== argv.length || ruleArgv.some((word, index) => word !== argv[index]);
}

/**
 * `git show --stat` can still print a blob, a tree, or `HEAD:path`. A symbolic
 * revision such as `HEAD` is a summary. Object ids are checked against the
 * repository at execution, because a commit hash is safe and a blob hash is not.
 */
export function gitShowStatNamesFile(argv: readonly string[]): boolean {
  if (argv[0] !== 'git' || argv[1] !== 'show' || !argv.includes('--stat')) return false;
  return argv.slice(2).some((word) => word !== '--stat' && (
    gitObjectId(word) || word.includes(':') || word.includes('.') || word.includes('/')
  ));
}

/**
 * What a requested argv escalates into that the approved rule never did.
 *
 * The rule is an argv PREFIX, so a run can always add words the human who
 * answered the card never read. A credential file named by those extra words is
 * a fresh ask, not something the standing approval covers.
 */
export function commandGrantEscalationsBeyondRule(
  rule: CommandGrantRule,
  argv: readonly string[],
): AgentGrantEscalation[] {
  const freshFile = namesCredentialFile(argv) && !namesCredentialFile(rule.argv);
  const freshSecret = namesEnvSecret(argv) && !namesEnvSecret(rule.argv);
  return freshFile || freshSecret ? ['credential'] : [];
}

/**
 * An interpreter grant is bound to the SCRIPT, not just to the command line.
 *
 * `python3 fix.py` tells a reader nothing about what will run, and the premise
 * of the whole grant loop is that a person can read a command and judge it. So
 * the daemon reads the script when it raises the ask, the card shows those
 * bytes in the machine role, and the runner refuses at execution unless the
 * file still hashes to what the human saw. An agent that rewrites its script
 * after the card is answered gets a refusal, not a run.
 *
 * The cap is a card a person can actually read on a phone: past
 * {@link GRANT_SCRIPT_MAX_BYTES} / {@link GRANT_SCRIPT_MAX_LINES} the ask is
 * REFUSED rather than truncated — a body that long is a change, and a change
 * belongs in a corner where it is a branch and a pull request.
 */
export const GRANT_SCRIPT_MAX_BYTES = 4_096;
export const GRANT_SCRIPT_MAX_LINES = 120;

export type CommandGrantScript = {
  /** The script argument exactly as it appears in the command line. */
  readonly path: string;
  /** SHA-256 of the bytes the card showed; the runner re-checks it. */
  readonly sha256: string;
  readonly bytes: number;
  /** The whole file. Never truncated — an oversized script is refused instead. */
  readonly contents: string;
};

export function isCommandGrantScript(value: unknown): value is CommandGrantScript {
  if (!value || typeof value !== 'object') return false;
  const script = value as Record<string, unknown>;
  return (
    typeof script.path === 'string' &&
    typeof script.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(script.sha256) &&
    typeof script.bytes === 'number' &&
    typeof script.contents === 'string'
  );
}

/** The refusal an oversized script gets, in both the tool and the server. */
export function grantScriptTooLongMessage(path: string, bytes: number, lines: number): string {
  return (
    `${path} is ${bytes} bytes over ${lines} lines: too long to put on an approval card ` +
    `(the cap is ${GRANT_SCRIPT_MAX_BYTES} bytes and ${GRANT_SCRIPT_MAX_LINES} lines). ` +
    'A human must be able to read what they approve, and this will not be truncated. ' +
    'Open a corner with open_corner and make the change there, where it is a branch and a ' +
    'pull request someone can read.'
  );
}

/**
 * The file an interpreter command will run, or an explicit executable path.
 * With includePathCommands, bare executable names are candidates for PATH lookup.
 * Readers distinguish native executables from scripts, including ENOEXEC shell text.
 * Undefined when the command has neither candidate, or when the line carries
 * no such argument (`python3 -V`) — that still asks a human, it just has no
 * body to show.
 */
export function interpreterScriptArgument(
  argv: readonly string[],
  includePathCommands = false,
): { index: number; path: string; direct?: true; inline?: string; stdin?: true } | undefined {
  // Step over `env FOO=1 …`, `sudo …`, `timeout 30 …`: the interpreter is what
  // matters, and a wrapper must not be a way around the binding.
  const skippable = (word: string) =>
    word.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || /^\d+$/.test(word);
  let head = 0;
  while (head < argv.length - 1 && COMMAND_WRAPPERS.has(commandBasename(argv[head]!))) {
    const wrapper = commandBasename(argv[head]!);
    head += 1;
    if (wrapper === 'env') {
      // These options consume a separate operand, which is never the executable.
      while (head < argv.length - 1) {
        const word = argv[head]!;
        if (word === '--') { head += 1; break; }
        if (word === '-S' || word === '--split-string' || word.startsWith('--split-string=') || word.startsWith('-S')) {
          const split = word === '-S' || word === '--split-string' ? argv[head + 1]
            : word.startsWith('--split-string=') ? word.slice('--split-string='.length) : word.slice(2);
          if (split === undefined || /[^a-zA-Z0-9_./:=,+% @-]/.test(split))
            throw new Error('Cannot safely resolve env wrapper options: unsupported split string.');
          const remaining = argv.slice(head + (word === '-S' || word === '--split-string' ? 2 : 1));
          return interpreterScriptArgument([...split.trim().split(/ +/).filter(Boolean), ...remaining], includePathCommands);
        }
        if (['-u', '--unset', '-C', '--chdir', '-a', '--argv0'].includes(word)) {
          head += 2;
        } else if (word.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
          head += 1;
        } else break;
      }
      while (head < argv.length - 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[head]!)) head += 1;
    } else {
      while (head < argv.length - 1 && skippable(argv[head]!)) head += 1;
    }
  }
  const executableName = commandBasename(argv[head] ?? '');
  if (!INTERPRETER_COMMANDS.has(executableName) && !/^(?:python|pypy|ruby|perl|php|lua|node)(?:\d+(?:\.\d+)*)$/.test(executableName)) {
    // Explicit executable paths may be scripts too. Callers inspect the bytes
    // to distinguish native executables from scripts and ENOEXEC shell text.
    const path = argv[head];
    return path && (includePathCommands || path.includes('/')) ? { index: head, path, direct: true } : undefined;
  }
  // Code-loading options can execute before or after the visible eval body.
  // Refuse them anywhere, including after the first body or script operand.
  if (/^node(?:\d+(?:\.\d+)*)?$/.test(executableName) &&
      argv.slice(head + 1).some(word => /^(?:-r.*|--(?:require|import|loader|experimental-loader|experimental-import|experimental-policy|policy-integrity|env-file|env-file-if-exists)(?:=.*)?)$/.test(word))) {
    throw new Error('Interpreter code-loading options need an explicit script file showing all code.');
  }
  let readsStdin = false;
  const inlineArgument = (index: number, inline: string) => {
    // Some runtimes concatenate repeated evals; others execute the last one.
    // A prefix approval over the first body must never license a later body.
    if (argv.slice(index + 1).some(word => /^(?:-[cep](?:.*)?|--(?:eval|print)(?:=.*)?|-Command|-command)$/.test(word)))
      throw new Error('Multiple interpreter eval options need an explicit script file showing all code.');
    return { index, path: '<inline>', inline };
  };
  for (let index = head + 1; index < argv.length; index += 1) {
    const word = argv[index]!;
    if (word === '--') {
      const path = argv[index + 1];
      return path && !readsStdin ? { index: index + 1, path } : { index, path: '<stdin>', stdin: true };
    }
    if (word === '-') return { index, path: '<stdin>', stdin: true };
    if (word === '-s') { readsStdin = true; continue; }
    if (['-c', '-e', '-p', '--eval', '--print', '-Command', '-command'].includes(word) ||
        (word === '-r' && /^php(?:\d+(?:\.\d+)*)?$/.test(executableName)) ||
        (/^-[a-zA-Z]*c$/.test(word) && /^(?:ba|da|z|k|a)?sh$/.test(commandBasename(argv[head]!)))) {
      const inline = argv[index + 1];
      return inline === undefined ? { index, path: '<stdin>', stdin: true }
        : inlineArgument(index + 1, inline);
    }
    const attached = word.match(/^(?:--(?:eval|print)=|-[ce])(.+)$/);
    if (attached) return inlineArgument(index, attached[1]!);
    // Runtime options with operands must not mistake the operand for a script.
    if (['-r', '--require', '--import', '--loader', '--experimental-loader', '-W', '-X'].includes(word)) { index += 1; continue; }
    if (word === '-m') throw new Error('Interpreter module execution needs an explicit script file for approval.');
    if (word.startsWith('-')) continue;
    if (readsStdin) return { index, path: '<stdin>', stdin: true };
    return { index, path: word };
  }
  if (argv.slice(head + 1).some(word => ['-V', '--version', '-h', '--help'].includes(word))) return undefined;
  return { index: head, path: '<stdin>', stdin: true };
}

/** Existing Android emulator access on the host adb server requires human consent. */
export const HOST_EMULATOR_TARGET = '127.0.0.1:5037';

/** Shared by grant requests and owner-machine session startup. */
export function agentGrantAutoApproves(input: {
  kind: AgentGrantKind; target: string; escalations?: readonly AgentGrantEscalation[];
  requireOwnerApproval?: boolean; ownApp?: boolean; yolo?: boolean; requesterIsOwner?: boolean;
}): boolean {
  return !input.requireOwnerApproval && input.kind !== 'shared_asset' &&
    !(input.kind === 'host' && input.target === HOST_EMULATOR_TARGET) &&
    !input.escalations?.length &&
    (input.kind === 'mcp' && (input.target.startsWith('app:') || input.target.startsWith('connection-install:'))
      ? input.ownApp === true
      : input.kind === 'mcp' && input.target === 'wallet'
        ? input.yolo === true && input.requesterIsOwner === true : true);
}

/** Path requests retain their explicit write capability through activation. */
export function pathGrantAllowsWrite(capabilities?: string): boolean {
  return /\b(write|writable|modify|edit)\b/i.test(capabilities ?? '');
}

/** The mcp grant target that mounts Trusty Squire. */
export const SQUIRE_MCP_TARGET = 'squire';

/** Paint-ready grant details shared by the DM card and the server's tray projection. */
export function grantPresentation(grant: {
  kind: AgentGrantKind; target: string; appName?: string; reason?: string;
  purpose?: string; touches?: string; capabilities?: string;
}) {
  let runs: string | undefined;
  let uses: string | undefined;
  if (grant.kind === 'command') {
    try {
      const rule = parseCommandGrantTarget(grant.target);
      const approved = grant.target.trimStart();
      runs = approved.startsWith('[') || approved.startsWith('{') ? grant.target : rule.argv.join(' ');
      uses = rule.secrets.join(', ') || undefined;
    } catch { /* Legacy command targets may predate the command grammar. */ }
  }
  return {
    purpose: grant.purpose ?? grant.reason,
    facts: [
      ...(runs ? [{ label: 'Runs', value: runs }] : []),
      ...(uses && !(grant.purpose && grant.touches && grant.capabilities) ? [{ label: 'Uses', value: uses }] : []),
      ...(grant.touches ? [{ label: 'Touches', value: grant.touches }] : grant.kind !== 'command' ? [{ label: 'Touches', value: grant.appName ?? grant.target }] : []),
      ...(grant.capabilities ? [{ label: 'Can', value: grant.capabilities }] : !grant.purpose && grant.kind !== 'command' ? [{ label: 'Can', value: `Use ${grant.appName ?? grant.target}` }] : []),
    ].slice(0, 3),
  };
}

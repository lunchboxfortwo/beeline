/**
 * Per-room-instance harness state directories.
 *
 * Beeline isolates every Room and corner at its own layer — separate `Body`,
 * durable inbox, relay socket, presence record, ACP session and worktree — but
 * the ACP *child processes* all shared one `$HOME`, so an external harness
 * (`claude`, `codex`, `pi`, …) that keeps per-project state under its own home
 * directory could still remember another Room. That is below Beeline's
 * per-channel isolation and is the one plausible mechanism for real cross-room
 * context bleed.
 *
 * Room harnesses receive a Beeline-owned `$HOME` as well as their harness
 * state roots, without inheriting `$HOME/.agents`, plugins, configuration, or
 * personal memory. Provider logins live only in the machine's CLIProxyAPI
 * (`cliproxy.ts`); a session receives its local endpoint and inference key
 * (`cliproxy.ts`). Cursor keeps its native login link. Pi and
 * OpenCode receive private copies of their static API-key entries only.
 * Pi's credential-bearing custom
 * provider catalog is copied as a private ordinary file into only its config
 * directory and regenerated on activation; operator UI/default settings stay
 * isolated.
 *
 * Skill startup and optional preparation follow `docs/agent-body.md`.
 * Ordinary operator MCP server
 * declarations are COPIED into the harness home so every Room/corner session
 * has the tools the host offers — without them a harness boots with a login but
 * nothing to advertise over ACP. Codex-acp
 * MERGES session MCP servers into `$CODEX_HOME/config.toml`, so a symlink
 * there would let a session write into the operator's real config. Only MCP
 * declarations pass through: model/sandbox/approval settings stay out because
 * they fight the daemon's own agent-mode flags. Codex's native web search is
 * enabled explicitly (`[features] standalone_web_search`); Claude Code gets a
 * generated `settings.json` allowing its native `WebSearch` tool. Pi's
 * harness MCP inventory is `$PI_CODING_AGENT_DIR/mcp.json` (operator
 * `~/.pi/agent/mcp.json`); local servers are copied and granted host routes
 * are rewritten there like Claude's `.claude.json`. The Pi installer chooses
 * that native inventory only when the executable proves it can load it;
 * otherwise `pi-mcp-bridge.ts` republishes the filtered stdio inventory.
 * Isolated homes exclude operator `settings.json`; Pi receives generated
 * stream-liveness settings. This does NOT touch the #376
 * credential armor: masked stores (`~/.ssh`, `~/.netrc`, `~/.config/gh`,
 * `~/.config/trusty-squire`, `~/.git-credentials`) are never linked. Imported
 * MCP declarations are classified `local` (copied as-is) or `host` (rewritten
 * into a route only after an owner grant; otherwise kept out). Squire is
 * code-owned as host.
 *
 * Pi uses `PI_CODING_AGENT_DIR` and the isolated `$HOME`, preventing its
 * otherwise-implicit reads from the operator's `~/.pi` and `~/.agents` trees.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readlink, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import {
  AGENT_BEHAVIORS,
  agentBehavior,
  API_KEY_STORES,
  SHARED_CREDENTIALS,
  type AgentKind,
} from './agent-command.js';
import { cliProxyHarnessEnv, type CliProxyEndpoint } from './cliproxy.js';
import {
  assertRealContainedDirectory,
  isMissingPathError,
  roomAgentHomeEnv,
  roomSessionTmpDir,
  writeIsolatedHarnessFile,
} from './agent-home-plan-managed-skills.js';
import {
  localGooseConfig,
  provisionAgentSkills,
  provisionAgentSkillsAndMcp,
  provisionPiCustomModelConfig,
  readJsonObject,
} from './agent-home-provision-agent-skills-and-mcp.js';
import {
  BEELINE_ONBOARDING_SKILL_NAME,
  BEELINE_REVIEW_SKILL_NAME,
  BEELINE_SPEC_SKILL_NAME,
  BEELINE_TRIAGE_SKILL_NAME,
  runningBeelineReleaseId,
  SITUATIONAL_SKILL_NAMES,
} from './beeline-skill.js';
import { DRAW_AVATAR_SKILL_NAME } from './draw-avatar-skill.js';
import { type OpenRouterRoutingHomeInput } from './openrouter-routing.js';
export { SHARED_CREDENTIALS } from './agent-command.js';
export {
  HARNESS_STATE_ENV_VARS,
  harnessStateDirsFromEnv,
  roomAgentHomeEnv,
  roomSessionTmpDir,
  writeIsolatedHarnessFile,
} from './agent-home-plan-managed-skills.js';
export { hostImportedMcpDeclarations } from './agent-home-provision-agent-skills-and-mcp.js';
export { AGENT_PRIVATE_STATE_ENV } from './agent-private-state-env.js';

/**
 * Goose keeps no auth.json: its provider, its model and its keys all live in
 * the config directory `GOOSE_PATH_ROOT` relocates wholesale (verified against
 * goose 1.41 — `GOOSE_PATH_ROOT=<root>` reads `<root>/config/config.yaml` and
 * writes `<root>/data`, `<root>/state`). `connect` skips the provider and key
 * questions for a Goose that already holds a provider of its own, so the
 * isolated home has to carry that configuration; without it the daemon would
 * answer with a Goose configured by nobody.
 *
 * COPIED, never symlinked, and regenerated on every activation like the MCP
 * files: Goose persists a session's selected model back into its own config,
 * and a Room must not rewrite the operator's default through a shared link.
 */
export const GOOSE_SHARED_CONFIG_FILES = ['config.yaml', 'secrets.yaml'] as const;

/**
 * Operator skills directories shared (linked per entry) into an isolated
 * harness home's Beeline-managed skills directory, keyed by the state
 * directory the harness was pointed at. A missing source dir is skipped, not
 * fatal — not every host has every harness installed.
 */
export const BEELINE_DEFAULT_SKILL_NAMES = [
  BEELINE_REVIEW_SKILL_NAME,
  BEELINE_SPEC_SKILL_NAME,
  BEELINE_ONBOARDING_SKILL_NAME,
  BEELINE_TRIAGE_SKILL_NAME,
  DRAW_AVATAR_SKILL_NAME,
  ...SITUATIONAL_SKILL_NAMES,
] as const;

/**
 * Operator skill directories shared by default into an isolated harness
 * home's Beeline-managed skills directory. Every entry that passes the same
 * validation as an explicit share is provisioned; a runtime record may still
 * narrow this per agent by listing explicit `sharedSkills` names. A missing
 * source dir is skipped, not fatal - not every host has every harness.
 */
export const OPERATOR_SKILL_SOURCE_DIRS = [
  '.agents/skills',
  '.claude/skills',
  '.codex/skills',
  '.pi/agent/skills',
] as const;

/**
 * The harness homes that can carry a Beeline-managed skills directory.
 *
 * A session runs ONE harness, so only that harness's tree is provisioned
 * (C104): materializing all four cost three recursive copies nobody read on
 * every activation. `agentSkillDir` is the single mapping from the selected
 * harness to its tree, and the read-only MCP surface resolves the skill root
 * through the same function so a session can never be pointed at a tree that
 * was not provisioned.
 */
export const AGENT_SKILL_DIRS = ['claude', 'codex', 'grok', 'pi', 'cursor', 'opencode'] as const;

export type AgentSkillDir = (typeof AGENT_SKILL_DIRS)[number];

/** The skills tree the selected harness reads. Anything else lands on codex's. */
export function agentSkillDir(kind: AgentKind | undefined): AgentSkillDir {
  return (AGENT_SKILL_DIRS as readonly string[]).includes(kind ?? '')
    ? (kind as AgentSkillDir)
    : 'codex';
}

export const SHARED_SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isSharedSkillName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SHARED_SKILL_NAME_PATTERN.test(value) &&
    !(BEELINE_DEFAULT_SKILL_NAMES as readonly string[]).includes(value)
  );
}

export class AgentHomeSecurityError extends Error {}

export const agentHomeProvisionQueues = new Map<string, Promise<void>>();

/**
 * Harness MCP declarations copied from the operator's real home into the
 * isolated home, per that harness's own layout:
 *
 *   - `codex` / `grok`: only the `[mcp_servers.*]` tables of the harness's
 *     `config.toml` are carried over, as a REAL file (never a symlink — see
 *     the module comment).
 *   - `claude`: Claude Code's user-scope MCP lives under the top-level
 *     `mcpServers` key of `~/.claude.json`; the same object is written as a
 *     minimal `.claude.json` inside the isolated `CLAUDE_CONFIG_DIR`.
 *   - `pi`: the same JSON `mcpServers` object lives in `~/.pi/agent/mcp.json`
 *     and is written as `mcp.json` inside the isolated `PI_CODING_AGENT_DIR`.
 *
 * Everything else in those files (models, sandbox modes, approval policy) and
 * every ungranted host-classified server (`mcp-route-class.ts`) stay behind.
 * An owner-granted host route is rewritten into the isolated home so the
 * next session fingerprint includes it.
 * The generated Codex config also disables its internal multi-agent tools:
 * Beeline must own all parallel work through its visible Room/corner
 * primitive.
 */
export const HARNESS_MCP_CONFIGS = [
  {
    dir: 'codex' as const,
    toml: '.codex/config.toml',
    roomDefaults: AGENT_BEHAVIORS.codex.roomTomlDefaults,
  },
  {
    dir: 'grok' as const,
    toml: '.grok/config.toml',
    roomDefaults: AGENT_BEHAVIORS.grok.roomTomlDefaults,
  },
];

/**
 * Pi custom providers live outside auth.json and may carry inline API keys.
 * Copy only this exact file into PI_CODING_AGENT_DIR. `settings.json` is
 * deliberately excluded: Body applies the paired or human-selected model via
 * ACP, while Pi's theme, package, extension, and default behavior are ambient
 * operator preferences rather than credentials required by that selection.
 */
export const PI_CUSTOM_MODEL_CONFIG = {
  source: '.pi/agent/models.json',
  target: 'models.json',
} as const;

/** Pi's harness MCP inventory. Isolated homes write local copies + granted host routes here. */
export const PI_MCP_CONFIG = {
  source: '.pi/agent/mcp.json',
  target: 'mcp.json',
} as const;

/**
 * Codex's supported per-home switch for its internal delegation surface.
 * This removes spawn, follow-up, wait, and message controls without changing
 * ordinary turn tools or the explicitly copied MCP server configuration.
 */
export const CODEX_ROOM_AGENT_LOCKDOWN_TOML = '[agents]\nenabled = false\n';

/**
 * Codex's native web search. `standalone_web_search` is the current feature
 * flag (`codex features list`); the older `tools.web_search` spelling is
 * deprecated. Network access is governed by the bwrap sandbox, not this flag.
 */
export const CODEX_ROOM_WEB_SEARCH_TOML = '[features]\nstandalone_web_search = true\n';

/**
 * Subdirectories created under a room-instance's agent home. Every one of
 * these except `tmp` is a harness state/credential root (see
 * `roomAgentHomeEnv`). Private reclamation is governed by lifecycle, whole
 * object use, and the preservation paths in `helper-storage.ts`.
 */
export const HOME_SUBDIRS = [
  'user',
  'user/.config',
  'user/.local/share',
  'claude',
  'codex',
  'goose',
  'grok',
  'pi',
  'cursor',
  'opencode',
  'state',
  'cache',
  'tmp',
] as const;

export interface RoomAgentHomeInput {
  /** Per-room agent home root, e.g. `<roomRoot>/agent-home`. */
  root: string;
  onDiagnostic?: (message: string) => void;
  /** Server-provided identity of the agent and this Room. */
  squireScope?: {
    readonly agentId: string;
    readonly roomId: string;
    readonly relay?: { readonly url: string; readonly token: string; readonly contextFile: string };
  };
  /** Operator's real home directory; defaults to the daemon's. */
  operatorHome?: string;
  failClosed?: boolean;
  /**
   * Release id stamped into the managed Beeline skills. Defaults to
   * the RUNNING release (`runningBeelineReleaseId`); tests inject explicit
   * ids to prove regeneration on version change.
   */
  skillReleaseId?: string;
  /** Narrow, runtime-owned names explicitly shared with this one agent. */
  sharedSkills?: string[];
  /**
   * The harness this activation will spawn. Only ITS skills tree is
   * provisioned; omitting it provisions codex's, the same tree
   * `readOnlyMcpServer` falls back to for an unrecognised harness.
   */
  agentKind?: AgentKind;
  /**
   * This activation runs as the parent Room's configured reviewer. Only a
   * reviewer's home carries the `beeline-review` skill: an implementer that
   * reads the review procedure mistakes its reviewer-never-merge rule for
   * its own.
   */
  isReviewer?: boolean;
  /**
   * The OpenRouter model this activation will run, when there is one. Its
   * live-derived provider set (`openrouter-routing.ts`, cached under
   * `cacheDir` for 24h) is pinned on that one model's pi `models.json` entry.
   */
  openRouterRouting?: OpenRouterRoutingHomeInput;
  /**
   * Owner-granted host MCP server names. Each matching host declaration is
   * rewritten into this isolated home; revoking the grant omits it on the
   * next prepare so the session fingerprint changes.
   */
  grantedHostRoutes?: readonly string[];
  /** Beeline-owned dynamic host routes (Registry MCP), already scoped by the server. */
  extraHostRoutes?: Record<string, Record<string, unknown>>;
  resourceAuthFile?: string;
  /** The machine's CLIProxyAPI; absent while it is down, so sessions start without a login. */
  cliProxy?: CliProxyEndpoint;
  /** The session's own env; a provider key there keeps that provider off the proxy. */
  agentEnv?: Record<string, string>;
}

/**
 * Writable operator login destinations for an isolated session: only
 * Cursor's native login directories, since a rename fails on a single-file
 * mountpoint. Every other harness login lives in the machine's CLIProxyAPI.
 */
export function harnessLoginWritablePaths(
  kind: AgentKind | undefined,
  operatorHome: string,
): string[] {
  const writable: string[] = [];
  for (const directory of agentBehavior(kind).nativeLoginDirs ?? []) {
    const path = resolve(operatorHome, directory);
    try {
      const stats = lstatSync(path);
      if (stats.isDirectory() || stats.isSymbolicLink()) writable.push(realpathSync(path));
    } catch {
      /* No store until the helper completes the first /login. */
    }
  }
  return [...new Set(writable)].sort();
}

/** Login files a session home held before its harness moved to CLIProxyAPI. */
const PROXIED_LOGIN_FILES = [
  'claude/.credentials.json',
  'codex/auth.json',
  'grok/auth.json',
] as const;

/**
 * Restore the native Cursor login links, refresh the private API-key
 * copies and remove any proxied login a session home still holds. A file a
 * harness left in place of a link is replaced; the operator's login stays the one source.
 */
export async function repairRoomAgentCredentialLinks(input: {
  root: string;
  operatorHome?: string;
}): Promise<void> {
  const root = resolve(input.root);
  const operatorHome = input.operatorHome ?? homedir();
  for (const credential of SHARED_CREDENTIALS) {
    const source = resolve(operatorHome, credential.source);
    const target = resolve(root, credential.dir, credential.target);
    if (
      existsSync(source) &&
      resolve(dirname(target), await readlink(target).catch(() => '')) !== source
    ) {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await rm(target, { force: true });
      await symlink(source, target);
    }
  }
  for (const store of API_KEY_STORES) {
    const target = resolve(root, store.dir, store.target);
    const keys = Object.entries(readJsonObject(resolve(operatorHome, store.source)) ?? {}).filter(
      ([, entry]) => (entry as { type?: unknown } | null)?.type === store.type,
    );
    await rm(target, { force: true });
    if (keys.length) {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeIsolatedHarnessFile(
        target,
        `${JSON.stringify(Object.fromEntries(keys), null, 2)}\n`,
      );
    }
  }
}

/**
 * Proxied logins never live in a session: remove links and quarantine copies
 * an earlier home kept. Optional setup, off the answer path; the sandbox masks their targets.
 */
async function retireNativeLogins(root: string): Promise<void> {
  for (const file of PROXIED_LOGIN_FILES) await rm(resolve(root, file), { force: true });
  for (const file of [
    ...PROXIED_LOGIN_FILES,
    ...API_KEY_STORES.map((store) => `${store.dir}/${store.target}`),
  ]) {
    const target = resolve(root, file);
    for (const name of await readdir(dirname(target)).catch((error) => {
      if (!isMissingPathError(error)) throw error;
      return [];
    })) {
      if (name.startsWith(`${basename(target)}.beeline-quarantine-`))
        await rm(resolve(dirname(target), name), { force: true });
    }
  }
}

/**
 * Create the room-instance's harness state directories and prepare its proxy
 * routes, native Cursor links and private API-key copies. Skill lifecycle:
 * `docs/agent-body.md`. Return the harness environment overlay. An unsafe or
 * unavailable private home never falls back to another credential or ambient
 * harness state.
 */
export async function prepareRoomAgentCredentials(
  input: RoomAgentHomeInput,
): Promise<Record<string, string>> {
  let env: Record<string, string>;
  try {
    env = await provisionRoomAgentCredentials(input);
  } catch (error) {
    // A broken configured folder never admits ambient credentials or prevents
    // delivery. A fresh private home starts empty and the session hears why.
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-agent-private-'));
    await Promise.all(
      HOME_SUBDIRS.map((dir) => mkdir(resolve(root, dir), { recursive: true, mode: 0o700 })),
    );
    input.onDiagnostic?.(
      `Private home setup failed (${error instanceof Error ? error.message : String(error)}). ` +
        `This session uses a fresh private home at ${root}; saved login and optional tools may be unavailable.`,
    );
    env = { ...roomAgentHomeEnv(root), TMPDIR: resolve(root, 'tmp') };
  }
  const root = dirname(env.HOME!);
  await provisionAgentSkills(
    root,
    input.skillReleaseId ?? runningBeelineReleaseId(),
    agentSkillDir(input.agentKind),
    input.isReviewer ?? false,
  ).catch((error) => console.warn(`[body] skills not provisioned under ${root}:`, error));
  return env;
}

async function provisionRoomAgentCredentials(
  input: RoomAgentHomeInput,
): Promise<Record<string, string>> {
  const root = resolve(input.root);
  const operatorHome = input.operatorHome ?? homedir();
  let tmpLinkReady = false;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`agent home root is not an ordinary directory: ${root}`);
  }
  for (const subdir of HOME_SUBDIRS) {
    const path = resolve(root, subdir);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await assertRealContainedDirectory(path, root);
  }
  // Yahoo's public chart endpoint rejects curl's default User-Agent with an
  // edge 429. Identify agent requests truthfully; explicit curl -A still wins.
  await writeIsolatedHarnessFile(resolve(root, 'user', '.curlrc'), 'user-agent = "Beeline/1.0"\n');
  // `TMPDIR` is the short symlink `roomAgentHomeEnv` reports, so a session's
  // Unix sockets stay inside `sun_path`; the bytes live in `root/tmp`. A
  // failure here must not cost the whole isolated home, so it degrades to
  // the long real path below.
  try {
    const tmpLink = roomSessionTmpDir(root);
    const tmpTarget = resolve(root, 'tmp');
    if ((await readlink(tmpLink).catch(() => undefined)) !== tmpTarget) {
      await rm(tmpLink, { recursive: true, force: true });
      await symlink(tmpTarget, tmpLink);
    }
    tmpLinkReady = true;
  } catch (error) {
    console.error(`[body] short TMPDIR link unavailable under ${root}:`, error);
  }

  // Clear old native MCP mounts before ACP starts, not during optional setup:
  // a persisted Squire facade can be dead while registry-mcp:squire works.
  for (const config of HARNESS_MCP_CONFIGS)
    await writeIsolatedHarnessFile(
      resolve(root, config.dir, 'config.toml'),
      config.roomDefaults ? `${CODEX_ROOM_AGENT_LOCKDOWN_TOML}\n${CODEX_ROOM_WEB_SEARCH_TOML}` : '',
    );
  await writeIsolatedHarnessFile(resolve(root, 'claude', '.claude.json'), '{"mcpServers":{}}');
  await writeIsolatedHarnessFile(resolve(root, 'pi', 'mcp.json'), '{"mcpServers":{}}');

  await repairRoomAgentCredentialLinks({ root, operatorHome });
  await mkdir(resolve(root, 'goose/config'), { recursive: true, mode: 0o700 });
  for (const name of GOOSE_SHARED_CONFIG_FILES) {
    const source = resolve(operatorHome, '.config/goose', name);
    const target = resolve(root, 'goose/config', name);
    await rm(target, { force: true });
    if (existsSync(source)) {
      const body = readFileSync(source, 'utf8');
      await writeIsolatedHarnessFile(
        target,
        name === 'config.yaml' ? localGooseConfig(body) : body,
      );
    }
  }
  if (agentBehavior(input.agentKind).hostedModelConfig === 'model-file')
    await provisionPiCustomModelConfig(
      root,
      operatorHome,
      true,
      undefined,
      input.cliProxy,
      input.agentEnv,
    );
  const env = tmpLinkReady
    ? roomAgentHomeEnv(root)
    : { ...roomAgentHomeEnv(root), TMPDIR: resolve(root, 'tmp') };
  return {
    ...env,
    ...(await cliProxyHarnessEnv({
      kind: input.agentKind,
      root,
      operatorHome,
      proxy: input.cliProxy,
      env: { ...input.agentEnv, ...env },
    })),
  };
}
/** Optional MCP setup and a skills refresh, after the private home the session starts with. */
export async function prepareRoomAgentHome(
  input: RoomAgentHomeInput,
): Promise<Record<string, string>> {
  const env = await prepareRoomAgentCredentials(input);
  if (!env.HOME) return env;
  const root = dirname(env.HOME);
  await retireNativeLogins(root);
  const operatorHome = input.operatorHome ?? homedir();
  const prior = agentHomeProvisionQueues.get(root) ?? Promise.resolve();
  const provision = prior
    .catch(() => undefined)
    .then(() =>
      provisionAgentSkillsAndMcp(
        root,
        operatorHome,
        input.skillReleaseId ?? runningBeelineReleaseId(),
        input.failClosed === true || Boolean(input.resourceAuthFile),
        input.sharedSkills ?? [],
        agentSkillDir(input.agentKind),
        input.openRouterRouting,
        input.isReviewer ?? false,
        input.grantedHostRoutes ?? [],
        input.extraHostRoutes ?? {},
        input.agentKind,
        input.resourceAuthFile,
        input.squireScope,
        input.cliProxy,
        input.agentEnv,
      ),
    );
  agentHomeProvisionQueues.set(root, provision);
  try {
    await provision;
  } finally {
    if (agentHomeProvisionQueues.get(root) === provision) agentHomeProvisionQueues.delete(root);
  }

  return env;
}

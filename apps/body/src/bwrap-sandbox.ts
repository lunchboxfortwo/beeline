/**
 * OS sandbox for agent commands on the executing owner's machine.
 * Startup uses the same auto-approval decision as request_grant. Owner HOME
 * binds read-write before credential and sibling masks; per-Room harness state
 * is restored afterwards. Repository and dependency overlays retain their own
 * read-only mounts. Docker sockets remain masked without an explicit grant.
 *
 * Sessions receiving the user bus preserve the host PID namespace: sd_bus
 * cannot authenticate peers hidden behind --unshare-pid. Other sessions retain
 * PID isolation. Bus access already permits starting host processes as this
 * user. This is a hygiene boundary, not confinement against that authority.
 *
 * Missing or unusable bubblewrap remains a loudly reported fail-open path.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { executableOnPath } from './agent-command.js';
import type { SessionMode } from './config.js';
import { CURSOR_HARNESS_COMMAND } from './cursor-acp-bridge.js';
import { agentGrantAutoApproves, namesCredentialFile, type SharedAssetCategory } from '@beeline/api-contract/agent-grants';
import { PACKAGE_CACHE_DIRS } from './workspace-assets.js';




/** Operator switch, persisted on the runtime record and mirrored onto BodyConfig. */
export type SandboxPolicy = 'bwrap' | 'off';


export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = 'bwrap';


/**
 * Harness state roots derived from `$HOME` rather than a dedicated state env.
 * `agent-home.ts` now supplies a per-Room HOME, and the caller passes that home
 * here so these paths stay inside the validated agent-home boundary.
 *
 * Keyed on the ACP command, the same way `harness-capabilities.ts` keys its
 * per-adapter facts, so a host running one harness never has empty state
 * directories for four others created in its home. Adding a harness preset means
 * checking whether it needs an entry: the symptom of a missing one is an `EROFS`
 * or "failed to initialize state" error out of `session/new`, not a permission
 * denial, because this is the harness's own bookkeeping rather than a tool call.
 */
export const HARNESS_HOME_STATE_DIRS: Array<{ match: RegExp; dirs: string[] }> = [
  {
    // pi writes ~/.pi/pi-acp/session-map.json on every session/new. pi-acp
    // hard-codes that path, so HOME itself is the relocation boundary.
    match: /(^|[/\\])pi(-acp)?(\.[a-z]+)?$/i,
    dirs: ['.pi'],
  },
  {
    // Only load-bearing for a Room still on the daemon's ambient harness state
    // (no per-room agent home): there CLAUDE_CONFIG_DIR/CODEX_HOME are absent
    // from the env, the overlay list is empty, and this is where state lives.
    match: /(^|[/\\])claude-(agent|code)-acp(\.[a-z]+)?$/i,
    dirs: ['.claude'],
  },
  {
    match: /(^|[/\\])codex-acp(\.[a-z]+)?$/i,
    dirs: ['.codex'],
  },
  {
    match: /(^|[/\\])goose(\.[a-z]+)?$/i,
    dirs: ['.config/goose', '.local/share/goose'],
  },
  {
    match: /(^|[/\\])grok(\.[a-z]+)?$/i,
    dirs: ['.grok'],
  },
  {
    match: CURSOR_HARNESS_COMMAND,
    dirs: ['.cursor'],
  },
  {
    match: /(^|[/\\])opencode(\.[a-z]+)?$/i,
    dirs: ['.local/share/opencode', '.config/opencode'],
  },
];


/**
 * The configured harness's own `$HOME` state roots, absolute.
 *
 * An unrecognised command gets none. If such a harness turns out to need one,
 * the symptom is a clear `EROFS` at `session/new` and the off-switch is one
 * `runtime.json` field away — which is better than pre-creating directories in
 * the operator's home for every harness Beeline has ever heard of.
 */
export function harnessHomeStateDirs(
  agentCommand: string | undefined,
  home: string = homedir(),
): string[] {
  if (!agentCommand) return [];
  for (const { match, dirs } of HARNESS_HOME_STATE_DIRS) {
    if (match.test(agentCommand)) return dirs.map((dir) => resolve(home, dir));
  }
  return [];
}


/**
 * Home-relative paths whose contents must be ABSENT from every sandboxed
 * session — readable credentials are usable credentials, and the whole-home
 * read-only bind does not hide anything. Directories are replaced by an empty
 * writable tmpfs (so tools that insist on writing e.g. `known_hosts` still
 * work against nothing), files by `/dev/null`.
 */
export const KNOWN_CREDENTIAL_MASK_PATHS = [
  '.config/gh',
  '.ssh',
  '.netrc',
  '.git-credentials',
  '.secrets.env',
  '.beeline/registry-mcp',
  '.gnupg', '.aws', '.azure', '.kube', '.gcloud', '.docker',
  '.config/gcloud', '.config/beeline', '.config/trusty-squire',
  '.local/share/keyrings',
] as const;


/** One masked path plus whether it was seen as a directory or a file. */
export interface MaskedPath {
  path: string;
  kind: 'dir' | 'file';
  create?: boolean;
}


/**
 * The credential-mask entries for one host: the built-in known list plus the
 * owner's configured extras, resolved against `$HOME`. Optional entries that
 * do not exist are skipped. Required absent entries get namespace-only
 * directory mountpoints so later-created host paths remain hidden. Existing
 * entry kinds come from a real stat so the argv builder can pick tmpfs vs
 * `/dev/null` without touching the filesystem itself.
 */
export function credentialMaskPaths(
  extraPaths: string[] | undefined,
  home: string = homedir(),
  stat: (path: string) => { isDirectory: boolean } | undefined = (path) => {
    try {
      const info = lstatSync(path);
      return { isDirectory: info.isDirectory() };
    } catch {
      return undefined;
    }
  },
  requiredPaths: string[] = [],
): MaskedPath[] {
  const required = new Set(requiredPaths.map((path) => resolve(path)));
  const candidates = [
    ...KNOWN_CREDENTIAL_MASK_PATHS.map((entry) => resolve(home, entry)),
    ...(extraPaths ?? []).map((entry) => resolve(entry)),
    // Include credential-named dotfiles without opening their contents.
    ...[home, resolve(home, '.config')].flatMap(root => {
      try { return readdirSync(root).filter(name => namesCredentialFile(['read', resolve(root, name)]) ||
        namesCredentialFile(['read', resolve(root, name, 'entry')]))
        .map(name => resolve(root, name)); } catch { return []; }
    }),
  ];
  const seen = new Set<string>();
  const masks: MaskedPath[] = [];
  for (const path of candidates) {
    if (seen.has(path)) continue;
    seen.add(path);
    const info = stat(path);
    if (!info) {
      if (required.has(path)) masks.push({ path, kind: 'dir', create: true });
      continue;
    }
    masks.push({ path, kind: info.isDirectory ? 'dir' : 'file' });
  }
  return masks.sort((a, b) => a.path.localeCompare(b.path));
}


/**
 * Every OTHER agent's runtime directory on this host, masked absent.
 *
 * Beeline agents share one Unix account, so the whole-home `--ro-bind / /`
 * above makes every sibling agent's `<supervisorRoot>/beeline/agents/<publicKey>`
 * tree readable from inside this session — `runtime.json` there carries that
 * agent's own signing `secretKeyHex` and its `daemonToken`, and its Rooms'
 * `agent-home` subtrees carry harness logins (`claude/.credentials.json`,
 * `codex/auth.json`, `pi/auth.json`, …). A same-user sandbox cannot rely on
 * file permission bits for this — 0600 stops nothing when the reading process
 * runs as the same account — so the sibling's whole directory is masked
 * empty, the same technique {@link credentialMaskPaths} uses for ambient
 * credential stores. Only THIS agent's own directory (derived from
 * `ownRuntimeDir`, never enumerated or altered) stays out of the mask list;
 * everything under it keeps reaching the session exactly as it does today
 * through the existing harness-state and home overlays.
 */
export function siblingAgentMaskPaths(
  ownRuntimeDir: string,
  listAgentDirs: (agentsRoot: string) => string[] = (agentsRoot) => {
    try {
      return readdirSync(agentsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  },
): MaskedPath[] {
  const own = resolve(ownRuntimeDir);
  const agentsRoot = dirname(own);
  const ownName = basename(own).toLowerCase();
  return listAgentDirs(agentsRoot)
    .filter((name) => name.toLowerCase() !== ownName)
    .map((name) => ({ path: resolve(agentsRoot, name), kind: 'dir' as const }))
    .sort((a, b) => a.path.localeCompare(b.path));
}


/** Result of the one-shot start-up feature detection. */
export interface BwrapAvailability {
  /** Absolute path to a `bwrap` that passed the self-test, when usable. */
  path?: string;
  /** One operator-facing line explaining the state. Always present. */
  advisory: string;
  /**
   * The ONE sentence a Room/DM session prompt may state about a missing
   * sandbox: a fixed reason plus the operator's one-line fix where one applies.
   * Set only by `ensureBwrapSandbox`, which knows which branch it took.
   *
   * Deliberately not `advisory`: a model is told to say this in a reply every
   * Workspace member can read, so it must carry no host posture, no resolved
   * path, no AppArmor remediation, and no installer output.
   */
  shellDetail?: string;
}


/** What one session may reach, before it is turned into bwrap argv. */
export interface SandboxMountPlan {
  /** Broad owner capabilities precede every credential and sibling mask. */
  ownerPaths?: Array<{ path: string; writable: boolean }>;
  userBus?: string;
  /** Reapply protected roots after owner grants; private harness mounts follow. */
  protectedReadOnly?: string[];
  /** Edit sessions start writable-by-default; Rooms keep the read-only root. */
  rootWritable?: boolean;
  /**
   * Paths re-bound read-only after the tmpfs that would otherwise hide them.
   *
   * `--tmpfs /tmp` replaces the whole of `/tmp` with an empty filesystem, so a
   * session whose checkout, worktree or harness state happens to live under
   * `/tmp` would find it simply *gone* — a harness silently losing its
   * credentials, or a Room unable to read the code it was asked about. Anything
   * the session must still reach there is restored here, read-only.
   */
  readOnly: string[];
  /** Paths bind-mounted read-write, deduplicated and sorted. */
  writable: string[];
  /** Copy-on-write layers mounted over shared dependency trees; see {@link DependencyLayer}. */
  overlays?: DependencyLayer[];
  /**
   * Credential stores replaced by emptiness (empty tmpfs for directories,
   * `/dev/null` for files). Emitted AFTER the whole-home ro-bind — which
   * would otherwise expose them read-only — and BEFORE the writable binds,
   * so a deliberate harness-state bind always wins over a mask.
   */
  masks: MaskedPath[];
  /** Ordered mounts which must exist and may never silently degrade. */
  requiredMounts?: Array<{ source: string; target: string; mode: 'bind' | 'ro-bind' }>;
  /** Approved host device nodes bound into the private `/dev`. */
  devices?: string[];
}


/**
 * A shared dependency tree seen through an overlay: reads come from `tree`
 * (hard links into the Workspace store), writes land in `upper`. `upper` and
 * `work` belong to one checkout, so a write never reaches another corner.
 */
export interface DependencyLayer { tree: string; upper: string; work: string }


export interface SandboxSessionSpec {
  /** Supplied only for an active agent command on its owner's machine. */
  operatorHome?: string;
  userRuntimeDir?: string;
  grantedPaths?: Array<{ path: string; writable: boolean }>;
  mode: SessionMode;
  /** The child's working directory; also the ACP session cwd. */
  cwd: string;
  /** Corner worktree, for an edit session. */
  worktreePath?: string;
  /**
   * This Room's harness state directories — the `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/
   * `XDG_STATE_HOME`/`XDG_CACHE_HOME` values of the `agent-home.ts` env overlay.
   */
  harnessStateDirs?: string[];
  /**
   * Harness state roots under `$HOME` that no env var relocates — normally
   * {@link harnessHomeStateDirs}. Separate from `harnessStateDirs` only so a
   * caller can supply a test home instead of the daemon's real one.
   */
  harnessHomeStateDirs?: string[];
  /** This Room's `TMPDIR`, when `agent-home.ts` relocated it. */
  tmpDir?: string;
  /** Git common directory backing a corner's linked worktree. */
  gitCommonDir?: string;
  /** A Room gets private Git administration while its source stays read-only. */
  roomGitDirectory?: string;
  /** Hygiene denylist overlaid read-only in an edit session. */
  protectedPaths?: string[];
  /** Shared dependency trees, each writable through this checkout's own layer. */
  dependencyLayers?: DependencyLayer[];
  /** Explicit capabilities restored writable after protected parent mounts. */
  additionalWritablePaths?: string[];
  /** Credential stores hidden from this session ({@link credentialMaskPaths}).
   * Both modes get them: a Room reading the operator's gh token is the same
   * out-of-band-push hole a corner would be. */
  maskPaths?: MaskedPath[];
  /** Approved `device` grants ({@link grantedSandboxDevices}). */
  devices?: string[];
  /** Coarse Workspace asset and private Room boundary, shared by every bwrap caller. */
  sharedLayout?: {
    assetRoot: string;
    agentRuntimeDir: string;
    privateHomeRoot: string;
    privateRoot?: string;
    codexHome?: string;
    packageHome?: string;
    privateAssetRoot?: string;
    isolatedCategories?: readonly SharedAssetCategory[];
  };
}


/**
 * The device nodes an approved `device` grant mounts on the agent's next
 * session. Only absolute paths under `/dev/` qualify; any other target is
 * ignored rather than bound.
 */
export function grantedSandboxDevices(result: unknown): string[] {
  if (!result || typeof result !== 'object' || !('grants' in result)) return [];
  const grants = (result as { grants?: unknown }).grants;
  if (!Array.isArray(grants)) return [];
  const devices = new Set<string>();
  for (const entry of grants) {
    if (!entry || typeof entry !== 'object') continue;
    const grant = entry as Record<string, unknown>;
    if (grant.kind !== 'device') continue;
    if (grant.status !== 'approved' && grant.status !== 'once') continue;
    if (typeof grant.target !== 'string') continue;
    const path = sandboxDevicePath(grant.target);
    if (path) devices.add(path);
  }
  return [...devices].sort();
}


/** The `/dev/` node a device grant target mounts, or undefined when it mounts nothing. */
export function sandboxDevicePath(target: string): string | undefined {
  const trimmed = target.trim();
  if (!isAbsolute(trimmed)) return undefined;
  const path = resolve(trimmed);
  return path.startsWith('/dev/') ? path : undefined;
}


/** `/tmp` is always a private tmpfs, so a path under it is the shadowed case. */
function isUnderTmp(path: string): boolean {
  const rel = relative('/tmp', path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}


function normalize(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  for (const path of paths) {
    if (!path) continue;
    seen.add(resolve(path));
  }
  return Array.from(seen).sort();
}


/**
 * The exact mount table for one session. Resolve optional capabilities here;
 * required private boundaries retain their fail-closed validation below.
 */
export function sandboxMountPlan(spec: SandboxSessionSpec): SandboxMountPlan {
  const ownerPaths: NonNullable<SandboxMountPlan['ownerPaths']> = [];
  for (const grant of spec.grantedPaths ?? []) {
    try {
      // Bind the actual destination, never a symlink mountpoint. A saved grant
      // may outlive its source, or point through a broken/unreachable link.
      const path = realpathSync(grant.path);
      // Read access already comes from the root mount. Only /tmp needs
      // restoring through its private tmpfs; old grants must not pin artifacts.
      if (grant.writable || isUnderTmp(path)) ownerPaths.push({ path, writable: grant.writable });
    } catch { /* An unavailable optional capability mounts nothing. */ }
  }
  if (spec.operatorHome && agentGrantAutoApproves({ kind: 'path', target: spec.operatorHome }))
    ownerPaths.unshift({ path: resolve(spec.operatorHome), writable: true });
  const userBus = spec.operatorHome && spec.userRuntimeDir &&
    lstatSync(spec.userRuntimeDir, { throwIfNoEntry: false })?.isDirectory() &&
    agentGrantAutoApproves({ kind: 'command', target: 'systemctl --user' })
    ? resolve(spec.userRuntimeDir) : undefined;
  // Harness bookkeeping, both modes — see the module comment for why a Room
  // cannot have this read-only. No part of any repository is in here.
  const harnessState = [
    ...(spec.harnessStateDirs ?? []),
    ...(spec.harnessHomeStateDirs ?? []),
    spec.tmpDir,
  ];
  const writable = normalize(
    spec.mode === 'edit'
      ? [
          spec.worktreePath,
          spec.gitCommonDir,
          ...(spec.additionalWritablePaths ?? []),
          ...harnessState,
        ]
      : // A Room keeps source files read-only. Its explicit capabilities are
        // limited to harness state, agent-private paths, and release-owned
        // generated state such as the repository's .codegraph index; callers
        // must name each path. /tmp remains private.
        [...(spec.additionalWritablePaths ?? []), ...harnessState],
  );
  // Everything this session must still see through the /tmp tmpfs, minus what a
  // writable bind already restores. `tmpDir` is never restored read-only: under
  // /tmp it is already served, writably, by the private tmpfs.
  const tmpRestores = normalize([
    spec.cwd,
    spec.worktreePath,
    spec.gitCommonDir,
    ...(spec.harnessStateDirs ?? []),
    ...(spec.harnessHomeStateDirs ?? []),
  ]).filter((path) => isUnderTmp(path) && path !== '/tmp' && !writable.includes(path));
  const readOnly = normalize([
    ...(spec.mode === 'edit' ? (spec.protectedPaths ?? []) : []),
    ...tmpRestores,
  ]).filter((path) => !writable.includes(path));
  const shared = spec.sharedLayout;
  const requiredMounts: NonNullable<SandboxMountPlan['requiredMounts']> = [];
  const boundaryMasks: MaskedPath[] = [];
  if (shared) {
    const assetRoot = resolve(shared.assetRoot);
    const agentsRoot = dirname(resolve(shared.agentRuntimeDir));
    const workspacesRoot = dirname(dirname(assetRoot));
    boundaryMasks.push(
      { path: workspacesRoot, kind: 'dir' },
      { path: agentsRoot, kind: 'dir' },
    );
    const add = (path: string, mode: 'bind' | 'ro-bind', target = path): void => {
      requiredMounts.push({ source: resolve(path), target: resolve(target), mode });
    };
    // Rebind the selected work directory before its nested private HOME.
    const cwd = resolve(spec.cwd);
    const relativeCwd = relative(agentsRoot, cwd);
    if (relativeCwd === '' || (relativeCwd !== '..' && !relativeCwd.startsWith(`..${sep}`) && !isAbsolute(relativeCwd)))
      add(cwd, spec.mode === 'edit' ? 'bind' : 'ro-bind');
    add(shared.privateHomeRoot, 'bind');
    if (shared.privateRoot) add(shared.privateRoot, 'bind');
    if (shared.privateAssetRoot && shared.isolatedCategories?.length)
      add(shared.privateAssetRoot, 'bind');
    add(resolve(shared.agentRuntimeDir, 'runtime.json'), 'ro-bind');
    // The selected repository-free Room is read-only, but its generated
    // CodeGraph index remains writable after rebinding that Room cwd.
    for (const path of spec.additionalWritablePaths ?? []) {
      const rel = relative(cwd, resolve(path));
      if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
        add(path, 'bind');
    }
    add(resolve(assetRoot, 'cache'), 'bind');
    const source = (category: SharedAssetCategory, suffix: string): string =>
      shared.privateAssetRoot && shared.isolatedCategories?.includes(category)
        ? resolve(shared.privateAssetRoot, suffix)
        : resolve(assetRoot, suffix);
    if (shared.privateAssetRoot) {
      for (const suffix of shared.isolatedCategories?.includes('package-cache') ? PACKAGE_CACHE_DIRS : [])
        add(resolve(shared.privateAssetRoot, 'cache', suffix), 'bind', resolve(assetRoot, 'cache', suffix));
      for (const [category, suffix] of [
        ['codex-download-cache', 'cache/codex/download'],
        ['codex-plugin-cache', 'cache/codex/plugins'],
      ] as const) {
        if (shared.isolatedCategories?.includes(category))
          add(resolve(shared.privateAssetRoot, suffix), 'bind', resolve(assetRoot, suffix));
      }
    }
    if (shared.codexHome) {
      add(source('codex-download-cache', 'cache/codex/download'), 'bind', resolve(shared.codexHome, 'cache'));
      add(source('codex-plugin-cache', 'cache/codex/plugins'), 'bind', resolve(shared.codexHome, 'plugins/cache'));
    }
    if (shared.packageHome) {
      add(source('package-cache', 'cache/cargo/registry'), 'bind', resolve(shared.packageHome, '.cargo/registry'));
    }
    add(resolve(assetRoot, 'tools'), 'ro-bind');
  }
  if (spec.mode === 'readonly' && spec.roomGitDirectory) {
    // Preserve the seed's object view before replacing .git with private refs.
    requiredMounts.push({ source: resolve(spec.cwd, '.git/objects'),
      target: resolve(spec.roomGitDirectory, 'beeline-seed-objects'), mode: 'ro-bind' });
    requiredMounts.push({ source: resolve(spec.roomGitDirectory), target: resolve(spec.cwd, '.git'), mode: 'bind' });
  }
  return {
    ownerPaths,
    protectedReadOnly: normalize(spec.protectedPaths ?? []),
    ...(userBus ? { userBus } : {}),
    ...(spec.mode === 'edit' ? { rootWritable: true } : {}),
    readOnly,
    writable,
    ...(spec.dependencyLayers?.length ? { overlays: spec.dependencyLayers } : {}),
    masks: [...(spec.maskPaths ?? []), ...boundaryMasks,
      ...[...new Set(['/run/docker.sock', '/var/run/docker.sock', ...(spec.userRuntimeDir ? [resolve(spec.userRuntimeDir, 'docker.sock')] : [])]
        .filter(path => lstatSync(path, { throwIfNoEntry: false }) &&
          !spec.grantedPaths?.some(grant => resolve(grant.path) === path)).map(path => realpathSync(path)))]
        .map(path => ({ path, kind: 'file' as const }))],
    ...(requiredMounts.length ? { requiredMounts } : {}),
    ...(spec.devices?.length ? { devices: normalize(spec.devices) } : {}),
  };
}


export interface WrappedCommand {
  command: string;
  args: string[];
}


/** Mounts each `tree upper work` triple, then drops every capability before the command. */
const OVERLAY_BOOTSTRAP = [
  'set -eu',
  'while [ "$1" != -- ]; do',
  '  mount -t overlay overlay -o "lowerdir=$1,upperdir=$2,workdir=$3,userxattr" "$1"',
  '  shift 3',
  'done',
  'shift',
  'exec setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs "$@"',
].join('\n');


/** Whether a native edit reaches a writable host mount in this exact plan. */
export function sandboxAllowsWrite(plan: SandboxMountPlan, path: string): boolean {
  const covers = (root: string) => path === resolve(root) || path.startsWith(resolve(root) === '/' ? '/' : `${resolve(root)}/`);
  let allowed = Boolean(plan.rootWritable);
  for (const root of plan.readOnly) if (covers(root)) allowed = false;
  for (const binding of plan.ownerPaths ?? []) if (covers(binding.path)) allowed = binding.writable;
  if (plan.userBus && covers(plan.userBus)) allowed = true;
  for (const root of plan.protectedReadOnly ?? []) if (covers(root)) allowed = false;
  for (const mask of plan.masks) if (covers(mask.path)) allowed = false;
  for (const root of plan.writable) if (covers(root)) allowed = true;
  for (const mount of plan.requiredMounts ?? []) if (covers(mount.target)) allowed = mount.mode === 'bind';
  for (const layer of plan.overlays ?? []) if (covers(layer.tree)) allowed = true;
  return allowed;
}


/**
 * Wrap `command`/`args` so they run under bwrap with `plan`'s mount table.
 *
 * Argument order is load-bearing and asserted by tests: bwrap applies mount
 * operations in the order given, so the root bind must come first and every
 * per-session mount must come after the `/tmp` tmpfs that would shadow it.
 */
export function buildBwrapArgv(input: {
  bwrapPath: string;
  plan: SandboxMountPlan;
  cwd: string;
  command: string;
  args?: string[];
}): WrappedCommand {
  const overlays = input.plan.overlays ?? [];
  const args = [
    // sd_bus rejects peers whose PID cannot be resolved in its namespace.
    ...(input.plan.userBus ? [] : ['--unshare-pid']),
    // An unprivileged overlay mount needs namespace root; the bootstrap drops
    // every capability before the command. IS_SANDBOX tells harnesses that
    // refuse to run as root that this root is a namespace one.
    ...(overlays.length
      ? ['--unshare-user', '--uid', '0', '--gid', '0', '--setenv', 'IS_SANDBOX', '1',
          ...['CAP_SYS_ADMIN', 'CAP_DAC_OVERRIDE', 'CAP_SETPCAP'].flatMap(cap => ['--cap-add', cap])]
      : []),
    input.plan.rootWritable ? '--bind' : '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
  ];
  // `--dev-bind-try`: a host without the node still spawns the session.
  for (const device of new Set(input.plan.devices ?? [])) {
    args.push('--dev-bind-try', device, device);
  }
  args.push('--proc', '/proc', '--tmpfs', '/tmp');
  for (const path of input.plan.readOnly) args.push('--ro-bind', path, path);
  for (const binding of input.plan.ownerPaths ?? [])
    args.push(binding.writable ? '--bind-try' : '--ro-bind-try', binding.path, binding.path);
  if (input.plan.userBus) {
    args.push('--bind', input.plan.userBus, input.plan.userBus,
      '--setenv', 'XDG_RUNTIME_DIR', input.plan.userBus,
      '--setenv', 'DBUS_SESSION_BUS_ADDRESS', `unix:path=${input.plan.userBus}/bus`);
  }
  for (const path of input.plan.protectedReadOnly ?? []) args.push('--ro-bind', path, path);
  // Credential masks: applied after the ro-bind they override and before the
  // writable binds a deliberate harness-state bind would win with. A masked
  // DIRECTORY becomes an empty writable tmpfs (tools may write into nothing);
  // a masked FILE becomes /dev/null (readable, empty).
  for (const mask of input.plan.masks) {
    if (mask.kind === 'dir') {
      if (mask.create) args.push('--dir', mask.path);
      args.push('--tmpfs', mask.path);
    } else args.push('--ro-bind', '/dev/null', mask.path);
  }
  // Legacy optional harness roots may be absent. Coarse private/asset boundary
  // mounts below are required and fail closed.
  for (const path of input.plan.writable) args.push('--bind-try', path, path);
  for (const mount of input.plan.requiredMounts ?? []) {
    const source = lstatSync(mount.source, { throwIfNoEntry: false });
    const target = lstatSync(mount.target, { throwIfNoEntry: false });
    if (!source || !target || source.isSymbolicLink() || target.isSymbolicLink())
      throw new Error(`required sandbox mount is missing or a symlink: ${mount.source} -> ${mount.target}`);
    args.push(`--${mount.mode}`, mount.source, mount.target);
  }
  args.push('--chdir', input.cwd);
  // The sandbox must not outlive the daemon that owns the session.
  args.push('--die-with-parent');
  if (overlays.length) {
    for (const layer of overlays) for (const dir of [layer.upper, layer.work]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    args.push('--', 'sh', '-c', OVERLAY_BOOTSTRAP, 'beeline-dependency-layers',
      ...overlays.flatMap(layer => [layer.tree, layer.upper, layer.work]), '--', input.command, ...(input.args ?? []));
  } else {
    args.push('--', input.command, ...(input.args ?? []));
  }
  return { command: input.bwrapPath, args };
}


/** Convenience: plan + argv in one call. Returns the bare command when disabled. */
export function wrapAgentCommand(input: {
  bwrapPath?: string;
  spec: SandboxSessionSpec;
  command: string;
  args?: string[];
}): WrappedCommand {
  if (!input.bwrapPath) return { command: input.command, args: [...(input.args ?? [])] };
  return buildBwrapArgv({
    bwrapPath: input.bwrapPath,
    plan: sandboxMountPlan(input.spec),
    cwd: input.spec.cwd,
    command: input.command,
    args: input.args,
  });
}


/**
 * The git common directory backing a corner worktree, or undefined when it
 * cannot be resolved — which the caller treats as a reason to skip wrapping that
 * session entirely, since a corner that can edit but never commit is worse than
 * an unwrapped one.
 */
/**
 * One-shot start-up detection: is there a `bwrap` on this host that can actually
 * build the namespace we intend to spawn into?
 *
 * The self-test is the real mount table (minus the session-specific mounts), not
 * `bwrap --version`: a `bwrap` that exists but cannot unshare is the exact
 * failure this is meant to catch, and it only shows up when it tries.
 */
export function detectBwrapSandbox(
  options: {
    policy?: SandboxPolicy;
    env?: NodeJS.ProcessEnv;
    /** Test seam: run the self-test command. */
    run?: (command: string, args: string[]) => { status: number | null; stderr?: string };
  } = {},
): BwrapAvailability {
  const env = options.env ?? process.env;
  const policy = options.policy ?? DEFAULT_SANDBOX_POLICY;
  if (policy === 'off') {
    return {
      advisory:
        'harness OS sandbox DISABLED by configuration (sandbox=off); ACP children run unconfined and the Room read-only rule rests on the permission handler alone',
    };
  }
  const bwrapPath = executableOnPath('bwrap', env);
  if (!bwrapPath) {
    return {
      advisory:
        'harness OS sandbox UNAVAILABLE: bwrap (bubblewrap) is not on PATH; ACP children run unconfined and the Room read-only rule rests on the permission handler alone. Install bubblewrap to enforce it at the OS level.',
    };
  }
  const run =
    options.run ??
    ((command: string, args: string[]) => {
      const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 });
      return { status: result.status, stderr: result.stderr ?? '' };
    });
  const probe = buildBwrapArgv({
    bwrapPath,
    plan: { readOnly: [], writable: [], masks: [] },
    cwd: '/',
    command: '/bin/true',
  });
  const result = run(probe.command, probe.args);
  if (result.status !== 0) {
    const detail =
      (result.stderr ?? '').trim().split('\n').filter(Boolean).pop() ?? `exit ${result.status}`;
    const appArmorRemediation =
      /No permissions to create (?:a )?new namespace|setting up uid map: Permission denied|userns_create/i.test(
        result.stderr ?? '',
      )
        ? " Ubuntu AppArmor may be blocking unprivileged user namespaces. If the agent's user service inherited an AppArmor profile, reinstall the Beeline user unit and restart the agent; the unit explicitly transitions to unconfined before /usr/bin/bwrap enters Ubuntu's bwrap profile."
        : '';
    return {
      advisory: `harness OS sandbox UNAVAILABLE: ${bwrapPath} self-test failed (${detail}); ACP children run unconfined and the Room read-only rule rests on the permission handler alone.${appArmorRemediation}`,
    };
  }
  return {
    path: bwrapPath,
    advisory: `harness OS sandbox ENABLED via ${bwrapPath}: every ACP child gets a read-only filesystem plus a private /tmp and PID namespace, writable only in its own harness state; ambient credential stores (~/.config/gh, ~/.ssh, ~/.netrc, ~/.git-credentials) are masked absent; a repository corner adds its worktree and git dir, then receives its linked repository's GitHub App credential. Hygiene boundary, not confinement — it shapes where sessions write files and does not restrict other access this account has (e.g. sockets, container runtimes, secrets not on the mask list)`,
  };
}


/** The one command an operator runs when Beeline could not install bubblewrap itself. */
export const BUBBLEWRAP_INSTALL_FIX = 'sudo apt-get install -y bubblewrap';


/**
 * …and the same instruction for a host with no apt-get, where naming a command
 * would be guessing at a package manager nobody confirmed is here.
 */
export const BUBBLEWRAP_INSTALL_FIX_UNKNOWN_MANAGER = "install this host's bubblewrap package";


export type SandboxInstallResult = {
  readonly code: number | null;
  readonly output: string;
};


export type SandboxInstallRunner = (
  command: string,
  args: readonly string[],
) => Promise<SandboxInstallResult>;

export const INSTALL_OUTPUT_LIMIT = 32 * 1024;
export { BUBBLEWRAP_INSTALL_BUDGET_MS } from './bwrap-sandbox-bubblewrap-install-budget-ms.js';
export { runSandboxInstallCommand } from './bwrap-sandbox-bubblewrap-install-budget-ms.js';
export { ensureBwrapSandbox } from './bwrap-sandbox-bubblewrap-install-budget-ms.js';

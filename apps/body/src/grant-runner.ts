import { runOwned } from './wait.js';
import { grantOutputLines, type GrantOutputLine } from './grant-runner-output.js';
import { withKernelLockWhenFree } from './kernel-lock.js';
import {
  installedGrantExecutable,
  isNativeGrantExecutable,
  resolveGrantCommand,
} from './grant-script.js';
/**
 * The command-kind grant runner (Agent Grants, slice 2).
 *
 * An approved `command` grant is a rule: the exact approved line is the one
 * argv the agent may say. `run_granted_command` reaches this runner from the
 * beeline-agent MCP server, which lives INSIDE the session sandbox; the runner
 * itself is the daemon, so it spawns the command as its own child, with cwd =
 * the agent's Room checkout or corner worktree, an environment of PATH and HOME
 * plus only the secrets the rule names, a ten-minute timeout, and capped output.
 *
 * ## The capability table decides where it runs (C94)
 *
 * `@beeline/api-contract/surface-capabilities` holds one row per capability and
 * the standing invariant that a corner may do everything a Room may. A grant
 * used to invert it: the runner spawned unwrapped with the operator's live
 * project as cwd, so a Room was the more powerful surface for host work while a
 * corner could only touch its worktree.
 *
 * Now the surface decides. A corner has `run-host-command`, so a corner grant
 * spawns as a plain child and may act on the live host — that is the point, and
 * under yolo it just runs. A Room does not, so a Room grant is spawned into the
 * SAME read-only mount table an ordinary Room session gets (`bwrap-sandbox.ts`,
 * `mode: 'readonly'`): the whole host readable, and writable only in the
 * session's own scratch and harness home overlay, exactly as today. The refusal
 * comes from the kernel, not from a guess about what the argv means.
 *
 * Fail-CLOSED, deliberately: with no usable bubblewrap on the host there is no
 * way to keep a Room's promise, so a Room grant is refused outright and the
 * agent is told to open a thread. That is the opposite of the harness spawn
 * path, which fails open so a host without bwrap can still hold a conversation.
 *
 * Two hard stops survive yolo on both surfaces: a credential or environment
 * file, and a script nobody has read. A run must say exactly the approved argv,
 * so it can never add words the card did not show. An interpreter grant is bound to the script bytes the approval card showed: the
 * file is re-hashed before every run, and a script that changed, or one that
 * appeared where the card had none, is refused.
 *
 * Every run writes one ledger tool row naming the grant and who asked. A `once`
 * grant is spent before its first run starts; a revoked rule is simply absent from the next `listAgentGrants` read,
 * so it stops matching immediately.
 *
 * Secrets are resolved from the operator key store (`provider-key-store.ts`,
 * `~/.config/beeline/providers.json`, addressed by the provider's env var name),
 * from the saved-secrets file beside it (`secrets.json`, `{ NAME: value }`, the
 * one `store_secret` writes), then from the daemon's own environment as a
 * last-resort fallback. Values are injected into the child's env and scrubbed
 * from its output; they never reach the transcript, the ledger, or the model.
 */
import {
  commandGrantMatches,
  grantScriptKey,
  interpreterScriptArgument,
  parseCommandGrantTarget,
  type CommandGrantRule,
  hostGrantSshArgv,
} from '@beeline/api-contract/agent-grants';
import {
  HOST_GRANT_ARGV_HINT,
  hostGrantRefusal,
  matchHostGrant,
  trustedHostSsh,
} from './grant-host.js';
import { requireSecretGrants, validateRequestedSecrets } from './grant-secret.js';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { killChildProcessGroup } from './acp-stderr-tail-max-chars.js';
import { surfaceAllows, type AgentSurface } from '@beeline/api-contract/surface-capabilities';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  grantedSandboxDevices,
  grantedSandboxPaths,
  wrapAgentCommand,
  type MaskedPath,
  type SandboxSessionSpec,
} from './bwrap-sandbox.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import {
  PROVIDER_KEY_ENV_VARS,
  providerKeyStorePath,
  readProviderKeyStore,
  type ProviderKeyProvider,
} from './provider-key-store.js';

export const GRANT_COMMAND_TIMEOUT_MS = 10 * 60_000;
export const GRANT_COMMAND_OUTPUT_CAP_BYTES = 64 * 1024;
const ARGV_MAX_WORDS = 256;
const ARGV_WORD_MAX_LENGTH = 4_096;

/**
 * D3 (owner, PR #89 fix 11): a granted command keeps its one elapsed-time
 * limit, the only timer a helper wait arms besides the agent stay-warm
 * countdown. When it passes, `kill` ends the command's process group and the
 * run reports `timedOut`; `dispose` clears it on every other ending.
 */
function grantCommandLimit(
  ms: number,
  kill: () => void,
): { fired: () => boolean; dispose: () => void } {
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    kill();
  }, ms);
  return { fired: () => fired, dispose: () => clearTimeout(timer) };
}

type LiveGrant = DaemonOperationMap['listAgentGrants']['output']['grants'][number];

export type GrantRunRequester = { pubkey: string; name?: string };

/**
 * The surface a granted command runs on, plus what its session made writable.
 * `surfaceAllows(surface, 'run-host-command')` decides whether the command is
 * spawned plainly or into the Room's read-only mount table.
 */
export interface GrantWritePolicy {
  surface: AgentSurface;
  /** The self-tested bwrap; absent on a Room means its promise cannot be kept. */
  bwrapPath?: string;
  /** The session's TMPDIR, writable on both surfaces and where a script may live. */
  scratch?: string;
  /** The `agent-home.ts` overlay this session writes into; stays writable in a Room. */
  harnessStateDirs?: string[];
  /** Credential stores hidden from the run, exactly as a Room session hides them. */
  maskPaths?: MaskedPath[];
  /** Exact Room tool/cache environment, never agent provider credentials. */
  toolEnv?: Record<string, string>;
}

/** What a serving Room registers so the runner knows where and for whom it runs. */
export interface GrantRunnerRoom {
  workspaceId: string;
  cwd: string;
  /** Read at each run, because a Room's scratch is only known once its session starts. */
  writePolicy: () => GrantWritePolicy;
  /** The turn in flight, if any: its request id and the identity whose message started it. */
  turn: () => { requestId: string; requester?: GrantRunRequester } | undefined;
}

export interface GrantRunResult {
  grantId: string;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  output: string;
  /** True when the read-only Room filesystem refused a write this command tried. */
  writeRefused?: boolean;
  /** True when bubblewrap failed before the granted command could start. */
  sandboxFailure?: boolean;
}

/** The kernel's own words when the read-only bind refuses a write. */
const WRITE_REFUSED = /Read-only file system|EROFS/;
const SANDBOX_STARTED_SCRIPT = ['printf "%s\\n" "$1" >&2', 'shift', 'exec "$@"'].join('\n');

export const ROOM_SANDBOX_UNAVAILABLE =
  'this chat cannot run granted commands: a chat promises a read-only filesystem and that ' +
  'promise is enforced by bubblewrap, which is not usable on this host. Open a thread with ' +
  'open_thread and run it there, where writes belong.';

export const ROOM_WRITE_REFUSED_NOTE =
  '[beeline] a remaining read-only mount refused this write; request the specific path capability before retrying.';

export type SecretResolver = (name: string) => Promise<string | undefined>;

/** The saved-secrets file beside the operator key store: `{ NAME: value }`. */
function operatorSecretsPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(dirname(providerKeyStorePath(env)), 'secrets.json');
}

/** The store's current `{ NAME: value }` map, never the file's history. */
async function readOperatorSecrets(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  const raw = await readFile(operatorSecretsPath(env), 'utf8').catch(() => undefined);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
      ),
    );
  } catch {
    return {};
  }
}

/** The holder's unguessable owner token, which also names its lock marker file. */
function operatorSecretsLockToken(): string {
  return `${process.pid}:${randomUUID()}`;
}

/** The lock directory's current owner marker, or undefined if there is no lock. */
async function operatorSecretsLockOwner(lockDir: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(lockDir);
  } catch {
    return undefined;
  }
  const marker = entries.find((entry) => !entry.endsWith('/'));
  return marker ?? undefined;
}

function operatorSecretsLockRefused(lockDir: string): Error {
  return new Error(
    `operator secret store is locked by another Beeline process at ${lockDir}; if no Beeline process is running, remove that directory`,
  );
}

/**
 * Remove a marker whose owner is demonstrably gone: its `<pid>:<token>` names a
 * pid that is no longer alive. A live, empty or unreadable marker is never
 * taken over, however old. The marker and directory go through ownership-safe
 * primitives: `rmdir` succeeds only on an empty directory, so a rival that
 * re-created it with its own marker keeps it.
 */
async function removeDeadOperatorSecretsLock(lockDir: string): Promise<boolean> {
  const owner = await operatorSecretsLockOwner(lockDir);
  const pid = Number(owner?.split(':')[0]);
  if (!owner || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
  }
  await rm(joinDirSafe(lockDir, owner), { force: true });
  try {
    await rmdir(lockDir);
  } catch {
    return false; // a rival re-created the directory with its own marker
  }
  return true;
}

/**
 * Release the lock this holder owns. We unlink our own uniquely named marker
 * (a no-op if the directory was taken over), then `rmdir` the directory —
 * which succeeds only while it is still EMPTY, i.e. still ours. If a rival
 * re-created it with its own marker, `rmdir` returns ENOTEMPTY and removes
 * nothing. No interleaving of another process can make this release delete
 * somebody else's lock.
 */
async function releaseOperatorSecretsLock(lockDir: string, owner: string): Promise<void> {
  await rm(joinDirSafe(lockDir, owner), { force: true }).catch(() => {});
  await rmdir(lockDir).catch(() => {});
}

/** `join(dir, name)` for a lock marker, with no path traversal. */
function joinDirSafe(dir: string, name: string): string {
  return /^[A-Za-z0-9:._-]+$/.test(name) ? `${dir}/${name}` : dir;
}

/** Take the `secrets.json.lock` marker older releases exclude each other with. */
async function takeOperatorSecretsMarker(lockDir: string, owner: string): Promise<void> {
  try {
    await mkdir(lockDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!(await removeDeadOperatorSecretsLock(lockDir))) throw operatorSecretsLockRefused(lockDir);
    try {
      await mkdir(lockDir, { mode: 0o700 });
    } catch (again) {
      if ((again as NodeJS.ErrnoException).code === 'EEXIST')
        throw operatorSecretsLockRefused(lockDir);
      throw again;
    }
  }
  try {
    await writeFile(`${lockDir}/${owner}`, `${process.pid}\n`, { mode: 0o600 });
  } catch (error) {
    // A rival removed the directory before our marker landed: it is not ours.
    await rmdir(lockDir).catch(() => {});
    throw error;
  }
}

/**
 * Hold the operator-store lock for one read-modify-write. A kernel lock keyed
 * by the store path is followed while another Beeline process holds it.
 * While an older release may still run, the holder also takes its
 * `secrets.json.lock` DIRECTORY with an unguessably named owner marker
 * inside; every removal goes through `rmdir`, which succeeds only on an empty
 * directory. A marker held by a live older process, or one with no readable
 * owner, refuses at once naming its path; one whose owner pid is dead is
 * removed. Releases both locks when the supplied work settles.
 */
export async function withOperatorSecretStoreLock<T>(
  path: string,
  work: () => Promise<T>,
): Promise<T> {
  const lockDir = `${path}.lock`;
  return withKernelLockWhenFree(
    `beeline-operator-secrets:${resolve(path)}`,
    async () => {
      const owner = operatorSecretsLockToken();
      await takeOperatorSecretsMarker(lockDir, owner);
      try {
        return await work();
      } finally {
        await releaseOperatorSecretsLock(lockDir, owner);
      }
    },
    { step: 'operator secret store' },
  );
}

/**
 * Store one operator secret by name so a command grant's `--with NAME` resolves
 * at run time. Written to secrets.json beside the operator key store, mode
 * 0600, value never echoed. Storing the same name replaces its value.
 *
 * The write is a read-modify-write of one shared file, so it is serialized
 * under an exclusive lockfile that coordinates across processes; without it
 * two stores in flight both write from the same snapshot and the last one
 * drops the other's secret. The file is written to a sibling temp and renamed
 * into place so a concurrent reader never sees a torn file.
 */
export async function storeOperatorSecret(
  name: string,
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = operatorSecretsPath(env);
  // The lock file lives beside the store, so the directory must exist first;
  // recursive mkdir is idempotent and safe when several processes race to it.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await withOperatorSecretStoreLock(path, async () => {
    const store = { ...(await readOperatorSecrets(env)), [name]: value };
    // A unique temporary: an older release writing `secrets.json.tmp` cannot collide with it.
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
    await chmod(path, 0o600);
  });
}

/**
 * Resolve one named secret from the operator key store, then the daemon
 * environment, never echoing it.
 */
export function operatorSecretResolver(env: NodeJS.ProcessEnv = process.env): SecretResolver {
  const providerByEnvVar = new Map(
    (Object.entries(PROVIDER_KEY_ENV_VARS) as [ProviderKeyProvider, string][]).map(
      ([provider, envVar]) => [envVar, provider],
    ),
  );
  return async (name) => {
    const provider = providerByEnvVar.get(name);
    if (provider) {
      const saved = (await readProviderKeyStore(env))[provider];
      if (saved) return saved;
    }
    const store = await readOperatorSecrets(env);
    const saved = store[name];
    if (saved) return saved;
    // Last-resort fallback: a secret the daemon itself runs with (an env file
    // systemd sourced, a CI-style injected var) is a real secret the operator
    // already chose to expose to this process, so a `--with NAME` grant may use
    // it without a separate copy in the store.
    const fromEnv = env[name]?.trim();
    if (fromEnv) return fromEnv;
    return undefined;
  };
}

export function validateGrantArgv(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error('argv must be a non-empty array');
  if (value.length > ARGV_MAX_WORDS) throw new Error(`argv exceeds ${ARGV_MAX_WORDS} words`);
  return value.map((word) => {
    if (typeof word !== 'string' || !word) throw new Error('argv words must be non-empty strings');
    if (word.length > ARGV_WORD_MAX_LENGTH || /[\0\r]/.test(word)) {
      throw new Error('argv words must be single-line and bounded');
    }
    return word;
  });
}

/** Pick the rule that matches: the approved argv equals the request, word for word. */
export function matchCommandGrant(
  grants: readonly LiveGrant[],
  workspaceId: string,
  argv: readonly string[],
): { grant: LiveGrant; rule: CommandGrantRule } | undefined {
  for (const grant of grants) {
    if (grant.kind !== 'command' || grant.workspaceId !== workspaceId) continue;
    let rule: CommandGrantRule;
    try {
      rule = parseCommandGrantTarget(grant.target);
    } catch {
      continue;
    }
    if (commandGrantMatches(rule, argv)) return { grant, rule };
  }
  return undefined;
}

function capOutput(value: string, cap: number): string {
  if (Buffer.byteLength(value) <= cap) return value;
  const half = Math.floor(cap / 2);
  const bytes = Buffer.from(value);
  return `${bytes.subarray(0, half).toString('utf8')}\n…[${bytes.length - cap} bytes omitted]…\n${bytes
    .subarray(bytes.length - half)
    .toString('utf8')}`;
}

/** Name a rule and mismatch positions without echoing argument or secret values. */
function closestCommandGrant(
  grants: readonly Pick<
    LiveGrant,
    'kind' | 'target' | 'grantId' | 'workspaceId' | 'expiresAt' | 'status'
  >[],
  workspaceId: string,
  argv: readonly string[],
): string {
  let nearest: { id: string; score: number; fields: string[] } | undefined;
  for (const grant of grants) {
    if (grant.kind !== 'command') {
      if (
        grant.workspaceId === workspaceId &&
        (grant.status === 'approved' || grant.status === 'once') &&
        !nearest
      )
        nearest = { id: grant.grantId, score: -1, fields: [`kind ${grant.kind}`] };
      continue;
    }
    let rule: CommandGrantRule;
    try {
      rule = parseCommandGrantTarget(grant.target);
    } catch {
      continue;
    }
    const fields: string[] = [];
    let score = 0;
    rule.argv.forEach((word, index) => {
      if (word === argv[index]) score += 1;
      else fields.push(`word (${index + 1})`);
    });
    if (rule.argv.length !== argv.length) fields.push('word count');
    if (grant.workspaceId !== workspaceId) fields.push('workspace');
    if (grant.expiresAt && grant.expiresAt <= Date.now() / 1000) fields.push('expiry');
    if (grant.status !== 'approved' && grant.status !== 'once')
      fields.push(`status (${grant.status})`);
    if (!nearest || score > nearest.score) nearest = { id: grant.grantId, score, fields };
  }
  return nearest
    ? ` Closest grant ${nearest.id}: ${nearest.fields.join(', ') || 'not live'} does not match.`
    : ' No live command grants are available on this host; check expiry or revocation with request_grant mode=list.';
}

function scrubSecrets(value: string, secrets: ReadonlyMap<string, string>): string {
  let scrubbed = value;
  for (const [name, secret] of secrets) {
    if (secret.length >= 4) scrubbed = scrubbed.split(secret).join(`[${name}]`);
  }
  return scrubbed;
}

export interface GrantCommandRunnerOptions {
  api: Pick<DaemonApiClient, 'execute'>;
  agentId: string;
  resolveSecret?: SecretResolver;
  /** Source of PATH and HOME for the child; everything else is dropped. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  outputCapBytes?: number;
  /** Resolves the trusted installed program a host grant spawns; tests replace it. */
  trustedExecutable?: typeof installedGrantExecutable;
}

export class GrantCommandRunner {
  private readonly rooms = new Map<string, GrantRunnerRoom>();
  private readonly children = new Map<ChildProcess, string>();
  private readonly cancelledChildren = new WeakSet<ChildProcess>();
  private readonly resolveSecret: SecretResolver;

  constructor(private readonly options: GrantCommandRunnerOptions) {
    this.resolveSecret =
      options.resolveSecret ?? operatorSecretResolver(options.env ?? process.env);
  }

  register(roomId: string, room: GrantRunnerRoom): void {
    this.rooms.set(roomId, room);
  }

  unregister(roomId: string): void {
    this.rooms.delete(roomId);
  }

  cancel(roomId: string): void {
    for (const [child, placeId] of this.children) {
      if (placeId !== roomId) continue;
      this.cancelledChildren.add(child);
      killChildProcessGroup(child, 'SIGKILL');
    }
  }

  async run(
    input: { roomId: unknown; argv: unknown; stdin?: unknown; secrets?: unknown },
    onOutput?: (line: GrantOutputLine) => void,
  ): Promise<GrantRunResult> {
    if (typeof input.roomId !== 'string' || !input.roomId) throw new Error('roomId is required');
    const room = this.rooms.get(input.roomId);
    if (!room) throw new Error('this daemon is not serving that chat');
    const argv = validateGrantArgv(input.argv);
    if (
      input.stdin !== undefined &&
      (typeof input.stdin !== 'string' ||
        Buffer.byteLength(input.stdin) > 4096 ||
        input.stdin.includes('\0'))
    )
      throw new Error('stdin must be bounded text');
    const stdin = input.stdin as string | undefined;
    const requestedSecrets = validateRequestedSecrets(input.secrets);
    const turn = room.turn();
    if (!turn?.requestId) throw new Error('command requires an active turn');
    const live = await this.options.api.execute('listTurnAgentGrants', {
      roomId: input.roomId,
      requestId: turn.requestId,
    });
    const policy = room.writePolicy();
    const checkEnv = { ...(this.options.env ?? process.env), ...policy.toolEnv };
    let match: ReturnType<typeof matchCommandGrant>;
    let bindingFailure: Error | undefined;
    // A newer legacy or broad grant must not shadow an approval whose bytes match.
    for (const candidate of live.grants) {
      const possible = matchCommandGrant([candidate], room.workspaceId, argv);
      if (!possible) continue;
      try {
        await this.checkScriptBinding(candidate, room.cwd, checkEnv, argv, stdin);
      } catch (error) {
        bindingFailure ??= error as Error;
        continue;
      }
      // The probe runs only an installed git: a writable one on PATH could create files before the refusal.
      if (
        await gitShowPrintsFileContents(
          room.cwd,
          checkEnv,
          argv,
          installedGrantExecutable(argv[0], room.cwd, checkEnv),
        )
      ) {
        bindingFailure ??= new Error(
          `Closest grant ${candidate.grantId}: this command can print file contents or a full patch; it needs its own approval.`,
        );
        continue;
      }
      match = possible;
      break;
    }
    // An exact command grant wins; otherwise `ssh user@host <command>` may run
    // under an approved host grant for exactly that login.
    const hostMatch =
      match || bindingFailure ? undefined : matchHostGrant(live.grants, room.workspaceId, argv);
    if (!match && !hostMatch) {
      if (bindingFailure) throw bindingFailure;
      const hostRefusal =
        argv[0] === 'ssh' ? hostGrantRefusal(live.grants, room.workspaceId, argv) : undefined;
      if (hostRefusal) throw new Error(hostRefusal);
      const history = await this.options.api.execute('listAgentGrantRequests', {
        agentId: this.options.agentId,
        roomId: input.roomId,
      });
      const nearest = closestCommandGrant(history.grants ?? live.grants, room.workspaceId, argv);
      throw new Error(
        `no approved command grant matches.${nearest} Check the named mismatch before asking again with request_grant kind=command for this argv.` +
          (argv[0] === 'ssh'
            ? ` No live host grant is approved for this session either; to run commands on one login, ask with request_grant kind=host target=user@host. ${HOST_GRANT_ARGV_HINT}`
            : ''),
      );
    }
    const grant = match?.grant ?? hostMatch!.grant;
    // Use the same surface policy for the entire run.
    if (match) await this.checkScriptBinding(grant, room.cwd, checkEnv, argv, stdin);
    const execArgv = hostMatch ? hostGrantSshArgv(hostMatch.login, argv.slice(2)) : argv;
    if (hostMatch && requestedSecrets.length)
      throw new Error(
        'secrets are not passed to a host grant run; ssh does not carry this environment to the remote host.',
      );
    // Each requested secret needs its own live secret grant; the command itself
    // still has to match a command grant exactly.
    const secretGrants = requireSecretGrants(live.grants, room.workspaceId, requestedSecrets);
    const secrets = new Map<string, string>();
    for (const name of [...(match?.rule.secrets ?? []), ...requestedSecrets]) {
      const value = await this.resolveSecret(name);
      if (!value) throw new Error(`secret ${name} is not in the operator key store`);
      secrets.set(name, value);
    }
    const source = this.options.env ?? process.env;
    const sshPath = hostMatch
      ? trustedHostSsh(
          this.options.trustedExecutable ?? installedGrantExecutable,
          room.cwd,
          source.PATH,
        )
      : undefined;
    // A once grant is spent before the command starts, so a second call in the
    // same instant cannot ride the same approval.
    for (const spent of [grant, ...secretGrants]) {
      if (spent.status === 'once')
        await this.options.api.execute('consumeAgentGrant', { grantId: spent.grantId });
    }
    // ssh needs the owner's real HOME for its keys and known hosts, so a host
    // run gets only PATH and HOME, never the session's tool environment.
    const env: Record<string, string> = hostMatch
      ? {
          ...(source.PATH ? { PATH: source.PATH } : {}),
          ...(source.HOME ? { HOME: source.HOME } : {}),
        }
      : {
          ...(source.PATH ? { PATH: source.PATH } : {}),
          ...(source.HOME ? { HOME: source.HOME } : {}),
          XDG_RUNTIME_DIR: source.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`,
          DBUS_SESSION_BUS_ADDRESS:
            source.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=/run/user/${process.getuid?.() ?? 0}/bus`,
          ...(policy.toolEnv ?? {}),
          ...Object.fromEntries(secrets),
        };
    const cap = this.options.outputCapBytes ?? GRANT_COMMAND_OUTPUT_CAP_BYTES;
    // The capability table decides: a corner may act on the host, so it spawns
    // plainly; a Room may not, so it spawns into the very mount table an
    // ordinary Room session gets — whole host readable, writable only in its own
    // scratch and home overlay.
    // A host grant acts on the remote login it names; a Room sandbox hides the
    // keys ssh needs, so that run spawns plainly with the fixed options.
    const runsOnHost = hostMatch !== undefined || surfaceAllows(policy.surface, 'run-host-command');
    const sandboxMarker = runsOnHost
      ? undefined
      : `[beeline-sandbox-started:${randomBytes(16).toString('hex')}]`;
    const spawn = runsOnHost
      ? { command: sshPath ?? execArgv[0]!, args: execArgv.slice(1) }
      : roomSandboxCommand(
          policy,
          room.cwd,
          argv,
          sandboxMarker!,
          env.XDG_RUNTIME_DIR!,
          grantedSandboxPaths(live),
          grantedSandboxDevices(live),
        );
    // Re-check after secret resolution and Once consumption, immediately before exec.
    if (match) await this.checkScriptBinding(grant, room.cwd, env, argv, stdin);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let failure: Error | undefined;
    let child: ChildProcess | undefined;
    let limit: ReturnType<typeof grantCommandLimit> | undefined;
    const progress = grantOutputLines(secrets, onOutput, sandboxMarker);
    const capture = (
      stream: NodeJS.ReadableStream,
      chunks: Buffer[],
      name: 'stdout' | 'stderr',
    ) => {
      let bytes = 0;
      stream.on('data', (chunk: Buffer) => {
        progress.chunk(name, chunk);
        const remaining = Math.max(0, cap * 4 - bytes);
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        bytes += chunk.length;
        if (bytes > cap * 4) {
          failure ??= new Error(`${name} maxBuffer length exceeded`);
          if (child) killChildProcessGroup(child, 'SIGKILL');
        }
      });
    };
    // The child's exit ends the run: runOwned kills its group, so no pipe
    // holder outlives it, and close collects the output.
    const run = await runOwned({
      step: `granted command ${spawn.command}`,
      file: spawn.command,
      args: spawn.args,
      cwd: room.cwd,
      env,
      input: stdin ?? '',
      captureOutput: false,
      onSpawn: (spawned) => {
        child = spawned;
        this.children.set(spawned, input.roomId as string);
        spawned.on('error', (error) => {
          failure = error;
        });
        if (spawned.stdout) capture(spawned.stdout, stdout, 'stdout');
        if (spawned.stderr) capture(spawned.stderr, stderr, 'stderr');
        limit = grantCommandLimit(this.options.timeoutMs ?? GRANT_COMMAND_TIMEOUT_MS, () =>
          killChildProcessGroup(spawned, 'SIGKILL'),
        );
      },
    }).catch(() => undefined); // its spawn error is `failure`, and the exit status is the child's
    limit?.dispose();
    progress.close();
    if (child) this.children.delete(child);
    const exitCode = run ? run.code : (child?.exitCode ?? null);
    const signal = run ? run.signal : (child?.signalCode ?? null);
    const combined = [
      Buffer.concat(stdout).toString('utf8'),
      Buffer.concat(stderr).toString('utf8'),
    ]
      .filter(Boolean)
      .join(stdout.length && stderr.length ? '\n' : '');
    const outcome: { exitCode: number | null; signal?: string; timedOut: boolean; output: string } =
      {
        exitCode,
        ...(signal ? { signal } : {}),
        timedOut:
          signal === 'SIGKILL' &&
          limit?.fired() === true &&
          !(child && this.cancelledChildren.has(child)) &&
          !failure,
        output: failure ? `${combined}${combined ? '\n' : ''}${failure.message}` : combined,
      };
    // The record says what happened: a refused write is the Room boundary doing
    // its job, and the agent is told where the work belongs instead.
    const sandboxStarted = sandboxMarker ? outcome.output.includes(sandboxMarker) : true;
    if (sandboxMarker && sandboxStarted) {
      outcome.output = outcome.output.replace(`${sandboxMarker}\n`, '').replace(sandboxMarker, '');
    }
    const deniedPath =
      outcome.output.match(/['‘“`]([^'’”`\n]+)['’”`][^\n]*(?:Read-only file system|EROFS)/)?.[1] ??
      outcome.output.match(
        /(?:Read-only file system|EROFS)[^\n]*[, :]\s*['‘“`]([^'’”`\n]+)['’”`]/,
      )?.[1];
    let deniedTarget = deniedPath ? resolve(room.cwd, deniedPath) : undefined;
    if (deniedTarget) {
      // New files cannot be bind-mounted. Grant the existing parent needed to
      // create them, so the suggested call is sufficient on its own.
      while (!(await stat(deniedTarget).catch(() => undefined))) {
        const parent = dirname(deniedTarget);
        if (parent === deniedTarget) break;
        deniedTarget = parent;
      }
    }
    const writeRefused = !runsOnHost && WRITE_REFUSED.test(outcome.output);
    // The marker is emitted only after bubblewrap has built the namespace and
    // started its child. Command output is evidence about the command, never
    // evidence that bubblewrap itself failed to start.
    const sandboxFailure = !runsOnHost && !sandboxStarted;
    const output = capOutput(
      scrubSecrets(
        writeRefused
          ? `${outcome.output.trimEnd()}\n${ROOM_WRITE_REFUSED_NOTE} Call request_grant(${JSON.stringify({ mode: 'request', action: 'Write the blocked host path', kind: 'path', target: deniedTarget ?? room.cwd, capabilities: 'write', reason: deniedTarget ? 'Write the denied path' : 'Write the command working directory', purpose: 'Complete the blocked host operation' })}).`
          : outcome.output,
        secrets,
      ),
      cap,
    );
    const requester = {
      pubkey: grant.requestedBy,
      ...(grant.requestedByName ? { name: grant.requestedByName } : {}),
    };
    const status = sandboxFailure
      ? 'sandbox failed'
      : outcome.timedOut
        ? 'timed out'
        : outcome.exitCode === null
          ? 'error'
          : `exit ${outcome.exitCode}`;
    await this.options.api.execute('postAgentActivity', {
      agentId: this.options.agentId,
      roomId: input.roomId,
      requestId: turn?.requestId ?? `grant:${grant.grantId}`,
      activity: [
        {
          kind: 'tool',
          title: `ran ${execArgv.join(' ')} under grant ${grant.grantId} · asked by ${
            requester.name ?? requester.pubkey.slice(0, 12)
          }`,
          operation: 'execute',
          status,
          command: execArgv.join(' '),
          ...(output ? { output } : {}),
          requestedBy: requester,
        },
      ],
    });
    return {
      grantId: grant.grantId,
      exitCode: outcome.exitCode,
      ...(outcome.signal ? { signal: outcome.signal } : {}),
      timedOut: outcome.timedOut,
      output,
      ...(writeRefused ? { writeRefused: true } : {}),
      ...(sandboxFailure ? { sandboxFailure: true } : {}),
    };
  }

  /**
   * An interpreter grant may only run the bytes the approval card showed.
   *
   * The file is re-read and re-hashed here, immediately before the run: a
   * script the agent rewrote after the human answered no longer matches, and a
   * script that appeared where the card had none was never approved at all. A
   * line with no such file (`python3 -V`) has nothing to bind and passes.
   */
  private async checkScriptBinding(
    grant: LiveGrant,
    cwd: string,
    env: NodeJS.ProcessEnv,
    argv: readonly string[],
    stdin?: string,
  ): Promise<void> {
    const context = resolveGrantCommand(argv, cwd, env);
    const argument = interpreterScriptArgument(context.argv);
    if (!argument) return;
    const note = ` Closest grant ${grant.grantId}:`;
    if (stdin !== undefined && !argument.stdin)
      throw new Error(
        `${note} stdin is only supported when the interpreter reads its approved code from stdin.`,
      );
    if (argument.stdin && stdin === undefined)
      throw new Error(
        `${note} stdin bytes are unavailable; save them as a script file or approve exact stdin code.`,
      );
    const bytes = argument.stdin
      ? Buffer.from(stdin!)
      : argument.inline !== undefined
        ? Buffer.from(argument.inline)
        : await readFile(resolve(context.cwd, argument.path)).catch(() => undefined);
    if (!bytes) {
      throw new Error(
        `${note} script cannot be read at execution cwd ${context.cwd}; check cwd and script path. Ask with request_grant kind=command again.`,
      );
    }
    if (!grant.script && argument.direct && isNativeGrantExecutable(bytes)) return;
    if (!grant.script || grant.script.path !== argument.path) {
      throw new Error(
        `${note} script path or binding does not match; ${argument.path} is a script no human has read under this grant. ` +
          'Ask with request_grant kind=command so the card carries what the command runs.',
      );
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (grantScriptKey({ path: argument.path, sha256 }) !== grantScriptKey(grant.script)) {
      throw new Error(
        `${note} script hash does not match for ${argument.path} at execution cwd ${context.cwd}; it changed after approval or cwd resolves a different file. ` +
          'Ask with request_grant kind=command again so a human reads what runs now.',
      );
    }
  }
}

/**
 * `git show --stat` of a blob, tree, or `rev:path` prints the file. A commit
 * object stays a summary. `executable` is the installed git, if any. The probe
 * runs that file only, never a PATH lookup of `git`,
 * and its output is never returned to the agent.
 */
async function gitShowPrintsFileContents(
  cwd: string,
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
  executable: string | undefined,
): Promise<boolean> {
  if (argv[0] !== 'git' || argv[1] !== 'show' || !argv.includes('--stat')) return false;
  const objects = argv.slice(2).filter((word) => word !== '--stat' && !word.startsWith('-'));
  if (objects.length === 0) return false;
  if (!executable || !isAbsolute(executable)) return true;
  for (const word of objects) {
    const probe = await runOwned({
      step: 'git object type',
      file: executable,
      args: ['cat-file', '-t', '--', word],
      machineRead: true,
      cwd,
      env,
    }).catch(() => ({ stdout: '' }));
    if ((probe.stdout ?? '').trim() !== 'commit') return true;
  }
  return false;
}

/** The bwrap-wrapped argv for a Room run, or a refusal when the host cannot wrap. */
function roomSandboxCommand(
  policy: GrantWritePolicy,
  cwd: string,
  argv: readonly string[],
  sandboxMarker: string,
  runtimeDir: string,
  grantedPaths: NonNullable<SandboxSessionSpec['grantedPaths']>,
  devices: SandboxSessionSpec['devices'],
): { command: string; args: string[] } {
  if (!policy.bwrapPath) throw new Error(ROOM_SANDBOX_UNAVAILABLE);
  return wrapAgentCommand({
    bwrapPath: policy.bwrapPath,
    spec: {
      mode: 'readonly',
      userRuntimeDir: runtimeDir,
      grantedPaths,
      devices,
      cwd,
      // The Room keeps every writable surface its session already had: the
      // scratch and the agent-home overlay. Only the repository copy and the
      // live host become read-only.
      ...(policy.harnessStateDirs ? { harnessStateDirs: policy.harnessStateDirs } : {}),
      ...(policy.scratch ? { tmpDir: policy.scratch } : {}),
      ...(policy.maskPaths ? { maskPaths: policy.maskPaths } : {}),
    },
    command: '/bin/sh',
    args: ['-c', SANDBOX_STARTED_SCRIPT, 'beeline-grant-sandbox', sandboxMarker, ...argv],
  });
}

export { GrantRunnerServer, type GrantRunnerEndpoint } from './grant-runner-server.js';

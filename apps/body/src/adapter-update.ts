import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { redactDiagnostic } from '@beeline/api-contract/error-reporting';
import {
  adapterInstallArgs,
  formatAdapterInstallCommand,
  installedAgentProgramEnvironment,
  runAdapterInstall,
  type AdapterInstallCommand,
} from './agent-command.js';
import {
  initializeAdapterCandidate,
  withAdapterCandidateLock,
  withAdapterInstallLock,
  withIdleAdapterCandidate,
} from './adapter-install-lock.js';
import { checkAdapterSession } from './adapter-session-check.js';
import {
  adapterStatePath,
  adapterStoreRoot,
  MANAGED_ADAPTERS,
  readAdapterState,
  type AdapterState,
  type ManagedAdapterKind,
} from './adapter-store.js';
import { captureHelperError, flushHelperErrors } from './sentry.js';
import { runOwned } from './wait.js';

export const ADAPTER_RELEASE_AGE_MS = 24 * 60 * 60_000;
export interface AdapterRegistry {
  'dist-tags': { latest: string };
  time: Record<string, string>;
}
export interface AdapterUpdateOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** `ignore` drops npm and adapter output; decision lines still go to `log`. */
  stdio?: 'inherit' | 'ignore';
  readRegistry?: (packageName: string) => Promise<AdapterRegistry>;
  install?: (command: AdapterInstallCommand) => Promise<void>;
  checkSession?: typeof checkAdapterSession;
  alert?: (error: Error) => Promise<void>;
  now?: () => number;
  /** Decision and progress lines; stderr by default. */
  log?: (line: string) => void;
  /** The caller left: npm's or the candidate adapter's process group is killed, nothing is promoted. */
  signal?: AbortSignal;
}

/** Follow npm's latest release channel, with one day for newly published releases. */
export function agedAdapterVersion(registry: AdapterRegistry, now: number): string | undefined {
  const latest = registry['dist-tags'].latest;
  const latestTime = Date.parse(registry.time[latest] ?? '');
  if (now - latestTime >= ADAPTER_RELEASE_AGE_MS) return latest;
  // npm time includes created/modified and prerelease channels. Only previous
  // releases in the latest channel are fallback candidates while latest ages.
  const rank = (version: string) => version.split('.').map(Number);
  const compare = (a: string, b: string) => {
    const av = rank(a),
      bv = rank(b);
    return av[0]! - bv[0]! || av[1]! - bv[1]! || av[2]! - bv[2]!;
  };
  return Object.keys(registry.time)
    .filter(
      (version) =>
        /^\d+\.\d+\.\d+$/.test(version) &&
        compare(version, latest) <= 0 &&
        now - Date.parse(registry.time[version]!) >= ADAPTER_RELEASE_AGE_MS,
    )
    .sort((a, b) => compare(b, a))[0];
}

async function publishedAdapters(
  packageName: string,
  env: NodeJS.ProcessEnv,
  output: (line: string) => void,
  signal?: AbortSignal,
): Promise<AdapterRegistry> {
  const result = await runOwned({
    step: `npm view ${packageName}`,
    file: 'npm',
    args: ['view', packageName, 'dist-tags', 'time', '--json'],
    env,
    ...(signal ? { signal } : {}),
    onLine: output,
  });
  if (result.code !== 0)
    throw new Error(`npm view ${packageName} exited with status ${result.code ?? result.signal}`);
  return JSON.parse(result.stdout) as AdapterRegistry;
}

async function writeState(
  kind: ManagedAdapterKind,
  env: NodeJS.ProcessEnv,
  state: AdapterState,
  signal?: AbortSignal,
): Promise<void> {
  const path = adapterStatePath(kind, env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const staged = `${path}.${process.pid}.tmp`;
  await writeFile(staged, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  if (signal?.aborted) { await rm(staged, { force: true }); throw new Error(`${kind} adapter refresh cancelled`); }
  await rename(staged, path);
}

/** The store prefix that holds an active command, when it is a managed candidate. */
function prefixOf(directory: string, command: string | undefined): string | undefined {
  if (!command) return undefined;
  const first = relative(directory, command).split(sep)[0];
  if (!first || first === '..' || isAbsolute(first) || !first.startsWith('candidate-'))
    return undefined;
  return join(directory, first);
}

/**
 * Runs under the adapter lock right after promotion. Sessions resolve the
 * active command at each cold start and keep that prefix while they run, so
 * the new and the previous active prefixes stay. Any other prefix is
 * superseded or abandoned, unless a live installer still holds it.
 * Superseded prefixes are renamed here and removed after the lock is released.
 */
async function supersededPrefixes(directory: string, keep: Set<string>): Promise<string[]> {
  const superseded: string[] = [];
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    const prefix = join(directory, name);
    if (name.startsWith('superseded-')) superseded.push(prefix);
    if (!name.startsWith('candidate-') || keep.has(prefix)) continue;
    const doomed = join(directory, `superseded-${name}`);
    if (await withIdleAdapterCandidate(prefix, () => rename(prefix, doomed)))
      superseded.push(doomed);
  }
  return superseded;
}

function lineWriter(write: (line: string) => void): (chunk: string) => void {
  let pending = '';
  return (chunk) => {
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      write(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function updateAgentAdapter(
  kind: ManagedAdapterKind,
  options: AdapterUpdateOptions,
): Promise<boolean> {
  const env = options.env ?? process.env;
  const adapter = MANAGED_ADAPTERS[kind];
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const output = options.stdio === 'ignore' ? () => undefined : log;
  const { signal } = options;
  const current = await withAdapterInstallLock(() => readAdapterState(kind, env), env);
  const keeping = current.active?.version ?? 'the installed copy';
  let version: string | undefined;
  try {
    version = agedAdapterVersion(
      await (options.readRegistry ?? ((name) => publishedAdapters(name, env, output, signal)))(
        adapter.packageName,
      ),
      (options.now ?? Date.now)(),
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    // Registry outages never remove or reinstall a working adapter.
    log(
      `[beeline] ${kind} adapter: npm registry unavailable; keeping ${keeping} (${message(error)})`,
    );
    return false;
  }
  if (!version) {
    log(
      `[beeline] ${kind} adapter: no ${adapter.packageName} release is a day old yet; keeping ${keeping}`,
    );
    return false;
  }
  if (current.active?.version === version) {
    log(`[beeline] ${kind} adapter current at ${version}`);
    return false;
  }
  if (current.rejected?.[version]) {
    log(
      `[beeline] ${kind} adapter stays at ${keeping}; ${adapter.packageName}@${version} failed its session check earlier`,
    );
    return false;
  }
  const directory = join(adapterStoreRoot(env), kind);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Unique prefixes are immutable after adoption. Even a killed installer
  // cannot leave a partial install at a working version's command path. The
  // candidate lock is taken before the prefix exists, so pruning never
  // removes a live install; a dead installer's prefix is pruned later.
  const candidate = join(directory, `candidate-${randomBytes(6).toString('hex')}`);
  const label = `${adapter.binary}@${version}`;
  let superseded: string[] = [];
  const promoted = await withAdapterCandidateLock(candidate, async () => {
    await mkdir(candidate, { mode: 0o700 });
    initializeAdapterCandidate(candidate);
    let adopted = false;
    try {
      const install: AdapterInstallCommand = {
        command: 'npm',
        args: [
          'install',
          '--prefix',
          candidate,
          '--no-save',
          '--no-audit',
          '--no-fund',
          `${adapter.packageName}@${version}`,
        ],
      };
      log(
        `[beeline] installing ${kind} adapter ${version} (keeping ${keeping} until it passes): ${formatAdapterInstallCommand({ ...install, args: adapterInstallArgs(install) })}`,
      );
      await (
        options.install ??
        ((command) =>
          runAdapterInstall(command, {
            ...options,
            env,
            onLine: output,
            ...(signal ? { signal } : {}),
          }))
      )(install);
      const command = join(candidate, 'node_modules/.bin', adapter.binary);
      const agentEnv = Object.fromEntries(
        Object.entries({ ...env, ...installedAgentProgramEnvironment(kind, env) }).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
      let negotiated: Awaited<ReturnType<typeof checkAdapterSession>>;
      try {
        negotiated = await (options.checkSession ?? checkAdapterSession)({
          command,
          env: agentEnv,
          agentKind: kind,
          onStage: (stage) => log(`[beeline] checking ${label}: ${stage}`),
          onStderr: lineWriter((line) => output(`[beeline] ${label}: ${line}`)),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (signal?.aborted)
          throw new Error(
            `${kind} adapter refresh cancelled; ${adapter.packageName}@${version} was not promoted`,
          );
        const detail = redactDiagnostic(message(error)).replace(/\s+/g, ' ').slice(0, 1800);
        // Persist rejection under the same kernel lock as promotion. Other
        // helpers and future starts neither retry nor alert for this version.
        const first = await withAdapterInstallLock(async () => {
          const state = readAdapterState(kind, env);
          if (state.rejected?.[version]) return false;
          await writeState(kind, env, {
            ...state,
            rejected: { ...state.rejected, [version]: { error: detail } },
          });
          return true;
        }, env);
        log(
          `[beeline] ${kind} adapter ${version} failed its session check; keeping ${keeping} (${detail})`,
        );
        if (!first) return false;
        const alert = new Error(
          `Beeline ACP adapter rejected ${adapter.packageName}@${version}: ${detail}`,
        );
        alert.name = `AdapterCompatibilityError:${kind}@${version}`;
        await (
          options.alert ??
          (async (failure) => {
            // Existing helper Sentry -> /api/webhooks/sentry -> Telegram channel.
            captureHelperError(failure);
            await flushHelperErrors();
          })
        )(alert);
        return false;
      }
      return await withAdapterInstallLock(async () => {
        if (signal?.aborted) throw new Error(`${kind} adapter refresh cancelled; ${adapter.packageName}@${version} was not promoted`);
        const state = readAdapterState(kind, env);
        if (state.rejected?.[version]) {
          log(`[beeline] ${kind} adapter ${version} was rejected by a concurrent check; keeping ${state.active?.version ?? 'the installed copy'}`);
          return false;
        }
        if (JSON.stringify(state.active) !== JSON.stringify(current.active)) {
          log(`[beeline] ${kind} adapter ${version} was superseded by a concurrent refresh; keeping ${state.active?.version ?? 'the installed copy'}`);
          return false;
        }
        await writeState(kind, env, { ...state, active: { version, command, negotiated } }, signal);
        adopted = true;
        superseded = await supersededPrefixes(
          directory,
          new Set(
            [candidate, prefixOf(directory, state.active?.command)].filter((p): p is string => !!p),
          ),
        );
        log(
          `[beeline] ${kind} adapter promoted to ${version} (was ${state.active?.version ?? 'none'})`,
        );
        return true;
      }, env);
    } finally {
      if (!adopted) await rm(candidate, { recursive: true, force: true });
    }
  });
  for (const prefix of superseded) await rm(prefix, { recursive: true, force: true });
  if (superseded.length)
    log(
      `[beeline] removed ${superseded.length} superseded ${kind} adapter prefix${superseded.length === 1 ? '' : 'es'}`,
    );
  return promoted;
}

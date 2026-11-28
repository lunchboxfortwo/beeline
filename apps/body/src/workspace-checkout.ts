import { runOwnedFile } from './wait.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { sessionCredentialMaskPaths, siblingAgentMaskPaths, wrapAgentCommand } from './bwrap-sandbox.js';
import { runtimeDirectory } from './runtime.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { agentGitIdentity } from './agent-git-identity.js';
import {
  agentCornerCheckoutPaths,
  isMissingRemoteRefError,
  isRemoteRepositoryEmpty,
  materializeAgentCornerCheckout,
} from './agent-corner-checkout.js';
import { bootstrapEmptyGitHubRemote } from './empty-repository-bootstrap.js';
import { CRASH_SAFE_CLONE_ARGS, fetchRepositoryCache } from './repository-cache-repair.js';
import { rememberStorageOwner } from './storage-owners.js';
import { withKernelLockWhenFree } from './kernel-lock.js';
import { prepareCodegraphIndex } from './codegraph.js';
import type { BodyConfig } from './config.js';
import { dependencyRequest, prepareWorkspaceDependencies, workspaceDependenciesDir } from './dependency-generation.js';

const appArmorUsernsRestriction = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';

async function prepareSandboxError(output: string): Promise<string> {
  if (!/^(?:bwrap:[^\n]*\b(?:mount|overlay)\b|mount:)[^\n]*(?:permission denied|operation not permitted)/im.test(output)) return output;
  if ((await readFile(appArmorUsernsRestriction, 'utf8').catch(() => '')).trim() !== '1') return output;
  return 'The sandbox mount was denied while AppArmor restricts unprivileged user namespaces. '
    + 'Ask the host owner to update bubblewrap and its AppArmor profile so bubblewrap can mount temporary overlays.';
}

async function mobilePreparationRequested(path: string): Promise<boolean> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(() => undefined);
  if (!file) return false;
  try {
    const stat = await file.stat();
    return stat.isFile() && stat.size === 6 && await file.readFile('utf8') === 'mobile';
  } finally {
    await file.close();
  }
}

export function githubHttpsRemote(remote: string): string {
  const normalized = remote
    .replace(/^git:\/\/github\.com\//i, 'https://github.com/')
    .replace(/^git@github\.com:/i, 'https://github.com/');
  const url = new URL(normalized);
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com')
    throw new Error('thread repository must be a GitHub HTTPS identity');
  url.username = '';
  url.password = '';
  return (
    url
      .toString()
      .replace(/\/$/, '')
      .replace(/\.git$/i, '') + '.git'
  );
}

/** Repository remotes are server-stamped; local file remotes support isolated proofs. */
export function roomCheckoutRemote(remote: string): string {
  return remote.startsWith('file://') ? remote : githubHttpsRemote(remote);
}

export function githubGitEnv(token: string): NodeJS.ProcessEnv {
  const authorization = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
    GIT_TERMINAL_PROMPT: '0',
  };
}

export function cornerRepositoryCacheDir(supervisorRoot: string, remote: string): string {
  const repositoryHash = createHash('sha256')
    .update(roomCheckoutRemote(remote))
    .digest('hex')
    .slice(0, 24);
  return resolve(supervisorRoot, 'beeline', 'repositories', `${repositoryHash}.git`);
}

/**
 * The agent's own copy of a corner's branch. The session already binds these
 * folders, so the copy is written into them rather than renamed over them.
 */
export async function materializeCornerWorktree(input: {
  cornerId: string;
  remote: string;
  targetBranch: string;
  featureBranch: string;
  token: string;
  supervisorRoot: string;
  committer: { name: string; publicKey: string };
  bootstrapEmptyRemote?: () => Promise<boolean>;
}): Promise<{ path: string; gitCommonDir: string }> {
  const git = (args: string[], options: Parameters<typeof runOwnedFile>[2] = {}) =>
    runOwnedFile('git', args, options);
  const remote = roomCheckoutRemote(input.remote);
  const sourceGitDir = cornerRepositoryCacheDir(input.supervisorRoot, remote);
  await mkdir(dirname(sourceGitDir), { recursive: true, mode: 0o700 });
  if (!existsSync(resolve(sourceGitDir, 'HEAD'))) {
    const staging = `${sourceGitDir}.creating-${randomUUID()}`;
    try {
      await git(['clone', '--bare', ...CRASH_SAFE_CLONE_ARGS, remote, staging], {
        env: githubGitEnv(input.token),
        maxBuffer: 4 * 1024 * 1024,
      });
      await rename(staging, sourceGitDir).catch((error: NodeJS.ErrnoException) => {
        if (
          !['EEXIST', 'ENOTEMPTY'].includes(error.code ?? '') ||
          !existsSync(resolve(sourceGitDir, 'HEAD'))
        )
          throw error;
      });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  const onEmptyRemote =
    input.bootstrapEmptyRemote ??
    (!remote.startsWith('file://') && input.token
      ? () =>
          bootstrapEmptyGitHubRemote({
            remote,
            targetBranch: input.targetBranch,
            token: input.token,
          })
      : undefined);
  const { path, gitCommonDir } = await materializeAgentCornerCheckout({
    root: input.supervisorRoot,
    cornerId: input.cornerId,
    agentId: input.committer.publicKey,
    sourceGitDir,
    remote,
    branch: input.featureBranch,
    startRef: `refs/heads/${input.targetBranch}`,
    targetBranch: input.targetBranch,
    env: githubGitEnv(input.token),
    ...(onEmptyRemote ? { onEmptyRemote } : {}),
  });
  // materializeAgentCornerCheckout already pinned worktree config and the checkout's root.
  await git([
    '-C',
    path,
    'config',
    '--worktree',
    'credential.https://github.com.helper',
    '!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f',
  ]);
  const identity = agentGitIdentity(input.committer);
  await git(['-C', path, 'config', '--worktree', 'user.name', identity.name]);
  await git(['-C', path, 'config', '--worktree', 'user.email', identity.email]);
  return { path, gitCommonDir };
}

export function roomCheckoutPath(input: {
  roomId: string;
  supervisorRoot: string;
  remote: string;
  targetBranch: string;
}): string {
  const remote = roomCheckoutRemote(input.remote);
  const checkoutId = createHash('sha256')
    .update(`${input.roomId}\0${remote}\0${input.targetBranch}`)
    .digest('hex')
    .slice(0, 24);
  return resolve(input.supervisorRoot, 'beeline', 'room-checkouts', checkoutId);
}

/** A read-only copy of a Room's repository at its target branch. */
async function materializeRoomCheckout(input: {
  path: string;
  roomId: string;
  workspaceId: string;
  supervisorRoot: string;
  remote: string;
  targetBranch: string;
  token?: string;
}): Promise<void> {
  const remote = roomCheckoutRemote(input.remote);
  const { path } = input;
  const checkoutId = basename(path);
  await rememberStorageOwner(input.supervisorRoot, {
    workspaceId: input.workspaceId,
    roomId: input.roomId,
    kind: 'room-checkouts',
    itemId: checkoutId,
  });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const env = input.token ? githubGitEnv(input.token) : process.env;
  if (!existsSync(resolve(path, '.git')))
    await runOwnedFile(
      'git',
      ['clone', '--no-checkout', ...CRASH_SAFE_CLONE_ARGS, remote, path],
      { env, maxBuffer: 4 * 1024 * 1024 },
    );
  await runOwnedFile('git', ['-C', path, 'config', 'gc.pruneExpire', 'never']);
  const gitDir = resolve(path, '.git');
  let empty = false;
  try {
    await fetchRepositoryCache({
      gitDir,
      label: `room-checkouts/${checkoutId}`,
      args: [
        '--prune',
        'origin',
        `+refs/heads/${input.targetBranch}:refs/remotes/origin/${input.targetBranch}`,
      ],
      env,
    });
  } catch (error) {
    if (!isMissingRemoteRefError(error) || !(await isRemoteRepositoryEmpty(gitDir, env)))
      throw error;
    empty = true;
  }
  if (empty) {
    await runOwnedFile('git', ['-C', path, 'symbolic-ref', 'HEAD', `refs/heads/${input.targetBranch}`]);
    return;
  }
  await runOwnedFile(
    'git',
    ['-C', path, 'checkout', '--detach', '--force', `origin/${input.targetBranch}`],
    { env, maxBuffer: 4 * 1024 * 1024 },
  );
}

/**
 * Install the checkout's packages and run its build step in the same OS
 * sandbox as the agent's own commands. A repository's `corner:prepare` is its
 * whole step and reads the thread brief from `BEELINE_BRIEF`; otherwise
 * prepare installs from the lockfile and runs the build when defined. Returns
 * why the checkout is not ready, or undefined once it is.
 */
async function readyCheckout(input: {
  path: string;
  config: BodyConfig;
  supervisorRoot: string;
  agentId: string;
  gitCommonDir?: string;
  brief?: string;
}): Promise<string | undefined> {
  const { path, config } = input;
  const manifest = await readFile(resolve(path, 'package.json'), 'utf8').catch(() => undefined);
  if (manifest === undefined) return undefined;
  const { scripts = {}, packageManager } = JSON.parse(manifest) as {
    scripts?: Record<string, unknown>;
    packageManager?: string;
  };
  const steps: [string, ...string[]][] = [];
  if (scripts['corner:prepare']) steps.push(['npm', 'run', 'corner:prepare']);
  else {
    if (existsSync(resolve(path, 'package-lock.json'))) steps.push(['npm', 'ci']);
    else if (existsSync(resolve(path, 'pnpm-lock.yaml'))) {
      const pinnedPnpm = /^pnpm@\d+\.\d+\.\d+(?:-[\w.-]+)?(?=\+|$)/.exec(packageManager ?? '')?.[0];
      steps.push(pinnedPnpm
        ? ['npm', 'exec', '--yes', `--package=${pinnedPnpm}`, '--', 'pnpm', 'install', '--frozen-lockfile']
        : ['pnpm', 'install', '--frozen-lockfile']);
    }
    if (scripts.build) steps.push(['npm', 'run', 'build']);
  }
  if (!steps.length) return undefined;
  const { bwrapPath } = config;
  if (!bwrapPath)
    return 'packages were not installed and the build step did not run: this host has no OS sandbox to run the repository scripts in.';
  const git = (args: string[]) => runOwnedFile('git', ['-C', path, ...args]);
  // An unchanged clean tree keeps the packages and build it was prepared with.
  const marker = resolve(
    path,
    (await git(['rev-parse', '--git-path', 'beeline-prepared'])).stdout.trim(),
  );
  // A revised brief may touch other workspaces, so it is part of what was prepared.
  const managed = input.gitCommonDir && scripts['corner:prepare'] === 'node packages/scripts/prepare-corner.mjs';
  const request = resolve(path, dependencyRequest);
  const requestedMobile = managed && await mobilePreparationRequested(request);
  const mobile = resolve(path, 'apps/mobile');
  const needsMobile = requestedMobile || /\bmobile\b/i.test(input.brief ?? '');
  const tree = [
    (
      await git(['rev-parse', 'HEAD^{tree}']).catch(() => ({
        stdout: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      }))
    ).stdout.trim(),
    createHash('sha256')
      .update(input.brief ?? '')
      .digest('hex'),
    ...(managed ? [`shared-npm:${process.platform}:${process.arch}:${process.versions.modules}`] : []),
  ].join(' ');
  if (
    (await readFile(marker, 'utf8').catch(() => '')) === tree &&
    !requestedMobile &&
    (!managed || (existsSync(resolve(path, 'node_modules/.package-lock.json')) &&
      (!needsMobile || existsSync(resolve(mobile, 'node_modules/.package-lock.json'))))) &&
    !(await git(['status', '--porcelain'])).stdout.trim()
  )
    return undefined;
  await rm(marker, { force: true });
  const state = resolve(input.supervisorRoot, 'beeline');
  const cache = resolve(state, 'npm-cache');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  // The sandbox keeps /tmp private and /var/tmp read-only; tests write here.
  const tmp = await mkdtemp('/var/tmp/beeline-prepare-');
  try {
    const nativeMaskMounts = await runOwnedFile(bwrapPath, ['--help'])
      .then(({ stdout }) => /^\s+--tmp-overlay\s/m.test(stdout), () => false);
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      HOME: '/tmp',
      TMPDIR: tmp,
      BEELINE_BRIEF: input.brief ?? '',
      npm_config_cache: cache,
      TURBO_CACHE_DIR: resolve(path, '.turbo', 'cache'),
    };
    async function run(executable: string, args: string[], cwd = path) {
      const command = wrapAgentCommand({
        bwrapPath,
        nativeMaskMounts,
        spec: {
          mode: 'readonly',
          cwd,
          ...(input.gitCommonDir ? { gitCommonDir: input.gitCommonDir } : {}),
          additionalWritablePaths: [path, cache, tmp],
          maskPaths: [
            ...sessionCredentialMaskPaths(config, config.operatorHome ?? homedir()),
            ...siblingAgentMaskPaths(runtimeDirectory(input.supervisorRoot, input.agentId)),
          ],
        },
        command: executable,
        args,
      });
      await runOwnedFile(command.command, command.args, {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        // Turbo otherwise caches beside a linked worktree's Git storage, outside the checkout.
        env: environment,
      }).catch(async (error: { stderr?: string; stdout?: string; message?: string }) => {
        const output = (error.stderr || error.stdout || error.message || '').trim().slice(-1500);
        throw new Error(
          `Checkout at ${path} is not ready: ${[executable, ...args].join(' ')} failed:\n${await prepareSandboxError(output)}`,
        );
      });
    }
    if (managed && input.gitCommonDir) {
      const storage = resolve(input.gitCommonDir, workspaceDependenciesDir);
      await mkdir(storage, { recursive: true, mode: 0o700 });
      if ((await realpath(storage)) !== storage) throw new Error('Invalid workspace dependency storage');
      const install = async (root: string, mobile: boolean) =>
        prepareWorkspaceDependencies({
          root,
          checkout: path,
          storage: resolve(storage, mobile ? 'mobile' : 'root'),
          storeRoot: resolve(state, mobile ? 'node-modules-mobile' : 'node-modules'),
          installIdentity: await npmInstallIdentity(root, mobile),
          install: () => run('npm', ['ci', '--no-audit', '--no-fund'], root),
        });
      if (await install(path, false)) environment.BEELINE_READONLY_DEPENDENCIES = '1';
      if (needsMobile && await realpath(mobile).catch(() => undefined) === mobile) {
        if (!(await install(mobile, true))) await run('npm', ['run', 'mobile:install']);
        environment.BEELINE_MOBILE_DEPENDENCIES_READY = '1';
      }
    }
    for (const [executable, ...args] of steps)
      await run(executable, requestedMobile ? [...args, '--', '--mobile'] : args);
    if (requestedMobile && environment.BEELINE_MOBILE_DEPENDENCIES_READY) await rm(request, { force: true });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  await writeFile(marker, tree);
  return undefined;
}

async function npmInstallIdentity(root: string, mobile = false): Promise<string> {
  const files = ['package.json', '.npmrc'];
  if (mobile) {
    files.push('scripts/patch-livekit-abort.cjs', 'scripts/patch-livekit-owned.cjs');
    for (const file of (await readdir(resolve(root, 'patches')).catch(() => [])).sort())
      files.push(`patches/${file}`);
  }
  const contents = await Promise.all(files.map(async (file) => [
    file, await readFile(resolve(root, file), 'base64').catch(() => undefined),
  ]));
  return createHash('sha256').update(JSON.stringify(contents)).digest('hex');
}

interface WorkspaceInput {
  api: DaemonApiClient;
  config: BodyConfig;
  supervisorRoot: string;
  workspaceId: string;
  agent: { name: string; publicKey: string };
  placeId: string;
  parentRoomId?: string;
}

const pendingCheckouts = new Map<string, Promise<string>>();

/** Session prepare and workspace share this agent's in-flight checkout result. */
export function prepareWorkspace(input: WorkspaceInput, homeReady?: Promise<void>): Promise<string> {
  const key = JSON.stringify([
    resolve(input.supervisorRoot),
    input.agent.publicKey,
    input.placeId,
    input.parentRoomId,
  ]);
  const pending = pendingCheckouts.get(key);
  if (pending) return pending;
  const checkout = homeReady ? homeReady.then(() => prepareCheckout(input)) : prepareCheckout(input);
  const prepared = checkout.finally(() => pendingCheckouts.delete(key));
  pendingCheckouts.set(key, prepared);
  return prepared;
}

async function prepareCheckout(input: WorkspaceInput): Promise<string> {
  const repositoryRoom = input.parentRoomId ?? input.placeId;
  const repository = await input.api.execute('getRoomRepositoryState', { roomId: repositoryRoom });
  if (repository.resolution !== 'repository' || !repository.remote)
    return 'This place has no repository; there is nothing to check out.';
  const { remote } = repository;
  const targetBranch = repository.targetBranch || 'main';
  const token = remote.startsWith('file://')
    ? undefined
    : (await input.api.execute('getRoomGitHubToken', { roomId: repositoryRoom })).token;
  const path = input.parentRoomId
    ? agentCornerCheckoutPaths(input.supervisorRoot, input.placeId, input.agent.publicKey).path
    : roomCheckoutPath({ ...input, roomId: input.placeId, remote, targetBranch });
  // Cover materialization through indexing, including recovery of abandoned staging.
  const lock = `${input.parentRoomId ? 'thread' : 'room'}-checkout:${path}`;
  return withKernelLockWhenFree(lock, () =>
    prepareCheckoutAtPath(input, { path, remote, targetBranch, token }),
  );
}

async function prepareCheckoutAtPath(
  input: WorkspaceInput,
  {
    path,
    remote,
    targetBranch,
    token,
  }: {
    path: string;
    remote: string;
    targetBranch: string;
    token?: string;
  },
): Promise<string> {
  let gitCommonDir: string | undefined;
  let brief: string | undefined;
  let where = `${targetBranch} (read-only)`;
  if (input.parentRoomId) {
    const restore = await input.api.execute('getCornerRestoreState', { cornerId: input.placeId });
    brief = restore.brief?.spec;
    const branch =
      restore.featureBranch ?? `feature/corner-${input.placeId.replaceAll('-', '').slice(0, 12)}`;
    where = `branch ${branch} (target ${targetBranch})`;
    ({ gitCommonDir } = await materializeCornerWorktree({
      cornerId: input.placeId,
      remote,
      targetBranch,
      featureBranch: branch,
      token: token ?? '',
      supervisorRoot: input.supervisorRoot,
      committer: input.agent,
    }));
    // A checkout with no work of its own moves to the base just fetched.
    const base = `refs/remotes/origin/${targetBranch}`;
    const hasHead = await runOwnedFile('git', ['-C', path, 'rev-parse', '--verify', 'HEAD']).then(
      () => true,
      () => false,
    );
    const hasBase = await runOwnedFile('git', ['-C', path, 'rev-parse', '--verify', base]).then(
      () => true,
      () => false,
    );
    if (hasHead && hasBase) {
      if (
        await runOwnedFile('git', ['-C', path, 'merge-base', '--is-ancestor', 'HEAD', base]).then(
          () => true,
          () => false,
        )
      )
        await runOwnedFile('git', ['-C', path, 'merge', '--ff-only', '--quiet', base]);
    } else if (!hasHead && hasBase) {
      const dirty = (await runOwnedFile('git', ['-C', path, 'status', '--porcelain'])).stdout.trim();
      if (!dirty)
        await runOwnedFile('git', ['-C', path, 'checkout', '--quiet', '-B', branch, base]);
    }
    await rememberStorageOwner(input.supervisorRoot, {
      workspaceId: input.workspaceId,
      roomId: input.placeId,
      kind: 'corners',
      itemId: basename(path),
      agentId: input.agent.publicKey,
      ended: false,
    });
    if (!restore.lifecycle?.branch && !restore.lifecycle?.pr)
      await input.api
        .execute('postCornerRemoteState', {
          cornerId: input.placeId,
          branch,
          state: 'working',
          checks: 'unknown',
        })
        .catch((error) =>
          console.warn(`[body] thread ${input.placeId} working state not posted:`, error),
        );
  } else {
    await materializeRoomCheckout({
      path,
      roomId: input.placeId,
      workspaceId: input.workspaceId,
      supervisorRoot: input.supervisorRoot,
      remote,
      targetBranch,
      ...(token ? { token } : {}),
    });
  }
  const notReady = await readyCheckout({
    path,
    config: input.config,
    supervisorRoot: input.supervisorRoot,
    agentId: input.agent.publicKey,
    ...(gitCommonDir ? { gitCommonDir } : {}),
    ...(brief ? { brief } : {}),
  });
  const indexed = await prepareCodegraphIndex(input.config, path, {
    readonly: !input.parentRoomId,
  });
  const indexStatus = indexed
    ? 'The code index is ready.'
    : 'The code index was not built; use the shell and file tools.';
  if (notReady) return `Checkout at ${path} on ${where} is not ready: ${notReady} ${indexStatus}`;
  const head = await runOwnedFile('git', ['-C', path, 'rev-parse', '--verify', 'HEAD']).then(
    ({ stdout }) => stdout.trim(),
    () => undefined,
  );
  return head
    ? `Checkout ready at ${path} on ${where}. HEAD is ${head}. ${indexStatus}`
    : `Checkout ready at ${path} on ${where} (repository is empty; no commits on ${targetBranch} yet). ${indexStatus}`;
}

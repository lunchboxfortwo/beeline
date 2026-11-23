import { runOwnedFile } from './wait.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { sessionCredentialMaskPaths, siblingAgentMaskPaths, wrapAgentCommand } from './bwrap-sandbox.js';
import { runtimeDirectory } from './runtime.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { agentGitIdentity } from './agent-git-identity.js';
import { materializeAgentCornerCheckout } from './agent-corner-checkout.js';
import { CRASH_SAFE_CLONE_ARGS, fetchRepositoryCache } from './repository-cache-repair.js';
import { rememberStorageOwner } from './storage-owners.js';
import { KernelLockBusyError, withKernelLock } from './kernel-lock.js';
import { prepareCodegraphIndex } from './codegraph.js';
import type { BodyConfig } from './config.js';

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
export async function materializeRoomCheckout(input: {
  roomId: string;
  workspaceId: string;
  supervisorRoot: string;
  remote: string;
  targetBranch: string;
  token?: string;
}): Promise<string> {
  const remote = roomCheckoutRemote(input.remote);
  const path = roomCheckoutPath(input);
  const checkoutId = basename(path);
  await rememberStorageOwner(input.supervisorRoot, {
    workspaceId: input.workspaceId,
    roomId: input.roomId,
    kind: 'room-checkouts',
    itemId: checkoutId,
  });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return withKernelLock(`room-checkout:${path}`, async () => {
    const env = input.token ? githubGitEnv(input.token) : process.env;
    if (!existsSync(resolve(path, '.git')))
      await runOwnedFile(
        'git',
        ['clone', '--no-checkout', ...CRASH_SAFE_CLONE_ARGS, remote, path],
        { env, maxBuffer: 4 * 1024 * 1024 },
      );
    await runOwnedFile('git', ['-C', path, 'config', 'gc.pruneExpire', 'never']);
    await fetchRepositoryCache({
      gitDir: resolve(path, '.git'),
      label: `room-checkouts/${checkoutId}`,
      args: [
        '--prune',
        'origin',
        `+refs/heads/${input.targetBranch}:refs/remotes/origin/${input.targetBranch}`,
      ],
      env,
    });
    await runOwnedFile(
      'git',
      ['-C', path, 'checkout', '--detach', '--force', `origin/${input.targetBranch}`],
      { env, maxBuffer: 4 * 1024 * 1024 },
    );
    return path;
  });
}

/**
 * Install the checkout's packages and run its build step in the same OS
 * sandbox as the agent's own commands. A repository's `corner:prepare` is its
 * whole step and reads the thread brief from `BEELINE_BRIEF`; otherwise
 * `npm ci` and `npm run build` when defined. Returns why the checkout is not
 * ready, or undefined once it is.
 */
async function readyCheckout(input: {
  path: string;
  config: BodyConfig;
  supervisorRoot: string;
  agentId: string;
  brief?: string;
}): Promise<string | undefined> {
  const { path, config } = input;
  const manifest = await readFile(resolve(path, 'package.json'), 'utf8').catch(() => undefined);
  if (manifest === undefined) return undefined;
  const scripts = (JSON.parse(manifest) as { scripts?: Record<string, unknown> }).scripts ?? {};
  const steps = scripts['corner:prepare']
    ? [['run', 'corner:prepare']]
    : [
        ...(existsSync(resolve(path, 'package-lock.json')) ? [['ci']] : []),
        ...(scripts.build ? [['run', 'build']] : []),
      ];
  if (!steps.length) return undefined;
  if (!config.bwrapPath)
    return 'packages were not installed and the build step did not run: this host has no OS sandbox to run the repository scripts in.';
  const git = (args: string[]) => runOwnedFile('git', ['-C', path, ...args]);
  // An unchanged clean tree keeps the packages and build it was prepared with.
  const marker = resolve(
    path,
    (await git(['rev-parse', '--git-path', 'beeline-prepared'])).stdout.trim(),
  );
  // A revised brief may touch other workspaces, so it is part of what was prepared.
  const tree = [
    (await git(['rev-parse', 'HEAD^{tree}'])).stdout.trim(),
    createHash('sha256')
      .update(input.brief ?? '')
      .digest('hex'),
  ].join(' ');
  if (
    (await readFile(marker, 'utf8').catch(() => '')) === tree &&
    !(await git(['status', '--porcelain'])).stdout.trim()
  )
    return undefined;
  await rm(marker, { force: true });
  const cache = resolve(input.supervisorRoot, 'beeline', 'npm-cache');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  // The sandbox keeps /tmp private and /var/tmp read-only; tests write here.
  const tmp = await mkdtemp('/var/tmp/beeline-prepare-');
  try {
    for (const args of steps) {
      const command = wrapAgentCommand({
        bwrapPath: config.bwrapPath,
        spec: {
          mode: 'readonly',
          cwd: path,
          additionalWritablePaths: [path, cache, tmp],
          maskPaths: [
            ...sessionCredentialMaskPaths(config, config.operatorHome ?? homedir()),
            ...siblingAgentMaskPaths(runtimeDirectory(input.supervisorRoot, input.agentId)),
          ],
        },
        command: 'npm',
        args,
      });
      await runOwnedFile(command.command, command.args, {
        cwd: path,
        maxBuffer: 64 * 1024 * 1024,
        // Turbo otherwise caches beside a linked worktree's Git storage, outside the checkout.
        env: {
          PATH: process.env.PATH ?? '',
          HOME: '/tmp',
          TMPDIR: tmp,
          BEELINE_BRIEF: input.brief ?? '',
          npm_config_cache: cache,
          TURBO_CACHE_DIR: resolve(path, '.turbo', 'cache'),
        },
      }).catch((error: { stderr?: string; stdout?: string; message?: string }) => {
        const output = (error.stderr || error.stdout || error.message || '').trim().slice(-1500);
        throw new Error(
          `Checkout at ${path} is not ready: npm ${args.join(' ')} failed:\n${output}`,
        );
      });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  await writeFile(marker, tree);
  return undefined;
}

/**
 * The `workspace` tool: make (or refresh) this agent's copy of the place's
 * repository and index it. It runs only when the agent asks, and every
 * failure comes back to the agent as text.
 */
export async function prepareWorkspace(input: {
  api: DaemonApiClient;
  config: BodyConfig;
  supervisorRoot: string;
  workspaceId: string;
  agent: { name: string; publicKey: string };
  placeId: string;
  parentRoomId?: string;
}): Promise<string> {
  const repositoryRoom = input.parentRoomId ?? input.placeId;
  const repository = await input.api.execute('getRoomRepositoryState', { roomId: repositoryRoom });
  if (repository.resolution !== 'repository' || !repository.remote)
    return 'This place has no repository; there is nothing to check out.';
  const targetBranch = repository.targetBranch || 'main';
  const token = repository.remote.startsWith('file://')
    ? undefined
    : (await input.api.execute('getRoomGitHubToken', { roomId: repositoryRoom })).token;
  let path: string;
  let brief: string | undefined;
  let branch = targetBranch;
  if (input.parentRoomId) {
    const restore = await input.api.execute('getCornerRestoreState', { cornerId: input.placeId });
    brief = restore.brief?.spec;
    branch =
      restore.featureBranch ?? `feature/corner-${input.placeId.replaceAll('-', '').slice(0, 12)}`;
    path = (
      await materializeCornerWorktree({
        cornerId: input.placeId,
        remote: repository.remote,
        targetBranch,
        featureBranch: branch,
        token: token ?? '',
        supervisorRoot: input.supervisorRoot,
        committer: input.agent,
      })
    ).path;
    // A checkout with no work of its own moves to the base just fetched.
    const base = `refs/remotes/origin/${targetBranch}`;
    if (
      await runOwnedFile('git', ['-C', path, 'merge-base', '--is-ancestor', 'HEAD', base]).then(
        () => true,
        () => false,
      )
    )
      await runOwnedFile('git', ['-C', path, 'merge', '--ff-only', '--quiet', base]);
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
    try {
      path = await materializeRoomCheckout({
        roomId: input.placeId,
        workspaceId: input.workspaceId,
        supervisorRoot: input.supervisorRoot,
        remote: repository.remote,
        targetBranch,
        ...(token ? { token } : {}),
      });
    } catch (error) {
      if (error instanceof KernelLockBusyError)
        return checkoutBusy(
          roomCheckoutPath({
            ...input,
            roomId: input.placeId,
            remote: repository.remote,
            targetBranch,
          }),
          error,
        );
      throw error;
    }
  }
  const ready = () =>
    readyCheckout({
      path,
      config: input.config,
      supervisorRoot: input.supervisorRoot,
      agentId: input.agent.publicKey,
      ...(brief ? { brief } : {}),
    });
  // Agents in one Room share its checkout; one prepares it at a time.
  let notReady: string | undefined;
  try {
    notReady = input.parentRoomId
      ? await ready()
      : await withKernelLock(`room-checkout:${path}`, ready, {
          step: `agent ${input.agent.publicKey.slice(0, 12)} preparing the Room checkout`,
        });
  } catch (error) {
    if (error instanceof KernelLockBusyError) return checkoutBusy(path, error);
    throw error;
  }
  const indexed = await prepareCodegraphIndex(input.config, path);
  const where = input.parentRoomId
    ? `branch ${branch} (target ${targetBranch})`
    : `${targetBranch} (read-only)`;
  return [
    notReady
      ? `Checkout at ${path} on ${where} is not ready: ${notReady}`
      : `Checkout ready at ${path} on ${where}.`,
    indexed
      ? 'The code index is ready.'
      : 'The code index was not built; use the shell and file tools.',
  ].join(' ');
}

/** Agents in one Room share its checkout; one prepares it at a time and the others are told so at once. */
function checkoutBusy(path: string, error: KernelLockBusyError): string {
  return `Checkout at ${path} is being prepared by another agent (pid ${error.holder.pid || 'unknown'}, since ${error.holder.since}). Call workspace again to read it once that finishes.`;
}

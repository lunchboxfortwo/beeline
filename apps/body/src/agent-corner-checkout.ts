import { runOwnedFile } from './wait.js';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { CRASH_SAFE_CLONE_ARGS, fetchRepositoryCache } from './repository-cache-repair.js';
import { workspaceDependenciesDir } from './dependency-generation.js';

const git = (args: string[], env?: NodeJS.ProcessEnv) => runOwnedFile('git', args, { env });

export function isMissingRemoteRefError(error: unknown): boolean {
  return /remote ref does not exist|remote reference does not exist|couldn't find remote ref/i.test(
    String(error),
  );
}

async function remoteHeadCount(gitDir: string, env?: NodeJS.ProcessEnv): Promise<number> {
  const heads = (await git([`--git-dir=${gitDir}`, 'ls-remote', '--heads', 'origin'], env)).stdout
    .trim();
  return heads ? heads.split('\n').filter(Boolean).length : 0;
}

/** True only when `origin` advertises zero branch heads (an empty repository). */
export async function isRemoteRepositoryEmpty(
  gitDir: string,
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  return (await remoteHeadCount(gitDir, env)) === 0;
}

/** Private refs let agents check out the same public branch independently. */
export function agentCornerCheckoutPaths(root: string, cornerId: string, agentId: string) {
  for (const value of [cornerId, agentId]) {
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('invalid thread checkout identity');
  }
  const key = createHash('sha256').update(`${cornerId}:${agentId}`).digest('hex');
  return {
    path: resolve(root, 'beeline', 'corners', key),
    gitCommonDir: resolve(root, 'beeline', 'repositories', `agent-corner-${key}.git`),
  };
}

/**
 * A mirror of the seed whose object files are hard links. `git clone --local`
 * ignores `--local` for a shallow seed and writes a full private pack
 * (about 0.5 GiB per Beeline copy), so the objects are linked here directly.
 * `objects/info` is skipped: it may name alternates or a stale commit-graph.
 */
async function linkSeedRepository(seed: string, staging: string): Promise<void> {
  await git([...CRASH_SAFE_CLONE_ARGS, 'init', '--bare', '--quiet', staging]);
  // `clone -c` would persist these settings; `init -c` does not.
  for (const setting of CRASH_SAFE_CLONE_ARGS.filter((arg) => arg !== '-c')) {
    const [key, value] = setting.split('=', 2) as [string, string];
    await git([`--git-dir=${staging}`, 'config', key, value]);
  }
  const linkTree = async (from: string, to: string): Promise<void> => {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const source = resolve(from, entry.name),
        target = resolve(to, entry.name);
      if (entry.isDirectory()) await linkTree(source, target);
      else if (entry.isFile())
        await link(source, target).catch(async (error: NodeJS.ErrnoException) => {
          // Another mount (a sandbox bind) cannot hold a link: copy instead.
          if (error.code === 'EXDEV') await copyFile(source, target);
          else if (error.code !== 'EEXIST') throw error;
        });
    }
  };
  for (const entry of await readdir(resolve(seed, 'objects'), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'info')
      await linkTree(resolve(seed, 'objects', entry.name), resolve(staging, 'objects', entry.name));
  }
  await copyFile(resolve(seed, 'shallow'), resolve(staging, 'shallow')).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    },
  );
  // Every object is already present, so this copies only the refs.
  await git([
    ...CRASH_SAFE_CLONE_ARGS,
    `--git-dir=${staging}`,
    'fetch',
    '--quiet',
    '--update-shallow',
    '--no-write-fetch-head',
    seed,
    '+refs/*:refs/*',
  ]);
  await git([`--git-dir=${staging}`, 'config', 'remote.origin.url', seed]);
  await git([`--git-dir=${staging}`, 'config', 'remote.origin.mirror', 'true']);
}

/**
 * Clone immutable local objects with hard links, never refs or alternates.
 * The workspace coordinator holds the checkout lock while this runs.
 * The source cache remains recovery evidence until ordinary archive cleanup.
 */
export async function materializeAgentCornerCheckout(input: {
  root: string;
  cornerId: string;
  agentId: string;
  sourceGitDir: string;
  remote: string;
  branch: string;
  startRef: string;
  targetBranch?: string;
  env?: NodeJS.ProcessEnv;
  /** Called once if `targetBranch` is missing and `origin` has zero branches. Returns true if bootstrapped. */
  onEmptyRemote?: () => Promise<boolean>;
}): Promise<{ path: string; gitCommonDir: string }> {
  const paths = agentCornerCheckoutPaths(input.root, input.cornerId, input.agentId);
  await mkdir(dirname(paths.gitCommonDir), { recursive: true });
  if ((await lstat(paths.path).catch(() => undefined))?.isSymbolicLink())
    throw new Error('refusing symlinked agent checkout');
  const creating = !existsSync(resolve(paths.gitCommonDir, 'HEAD'));
  const label = `repositories/${basename(paths.gitCommonDir)}`;
  const fetchTargetOrBootstrap = async (gitDir: string, targetBranch: string): Promise<'fetched' | 'empty'> => {
    const fetchTarget = () =>
      fetchRepositoryCache({
        gitDir,
        label,
        args: ['origin', `+refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`],
        env: input.env,
      });
    try {
      await fetchTarget();
      return 'fetched';
    } catch (error) {
      if (!isMissingRemoteRefError(error)) throw error;
      const heads = await remoteHeadCount(gitDir, input.env);
      if (heads === 0) {
        if (input.onEmptyRemote && (await input.onEmptyRemote())) {
          await fetchTarget();
          return 'fetched';
        }
        return 'empty';
      }
      // A single branch on origin may be an interrupted Beeline bootstrap commit
      // whose custom target branch was not created yet; let onEmptyRemote verify it.
      if (heads === 1 && input.onEmptyRemote && (await input.onEmptyRemote())) {
        await fetchTarget();
        return 'fetched';
      }
      throw error;
    }
  };
  const staging = `${paths.gitCommonDir}.creating`;
  // A stopped owner may have installed HEAD before it could remove staging.
  await rm(staging, { recursive: true, force: true });
  if (creating) {
    try {
      try {
        await linkSeedRepository(input.sourceGitDir, staging);
        await git([`--git-dir=${staging}`, 'fsck', '--connectivity-only', '--no-dangling']);
      } catch (error) {
        if (!input.targetBranch) throw error;
        // A damaged immutable seed must not disable every new corner. Rebuild
        // only this private staging copy from the remote; keep the seed intact.
        await rm(staging, { recursive: true, force: true });
        await git(
          ['clone', '--mirror', ...CRASH_SAFE_CLONE_ARGS, input.remote, staging],
          input.env,
        );
      }
      await git([`--git-dir=${staging}`, 'config', '--unset', 'remote.origin.mirror']);
      await git([`--git-dir=${staging}`, 'remote', 'set-url', 'origin', input.remote]);
      await git([
        `--git-dir=${staging}`,
        'config',
        '--replace-all',
        'remote.origin.fetch',
        '+refs/heads/*:refs/remotes/origin/*',
      ]);
      let startRef = input.startRef;
      let unborn = false;
      if (input.targetBranch) {
        const targetState = await fetchTargetOrBootstrap(staging, input.targetBranch);
        if (targetState === 'empty') {
          unborn = true;
        } else {
          const published = await fetchRepositoryCache({
            gitDir: staging,
            label,
            args: ['origin', `+refs/heads/${input.branch}:refs/remotes/origin/${input.branch}`],
            env: input.env,
          }).then(
            () => true,
            (error) => {
              if (isMissingRemoteRefError(error)) return false;
              throw error;
            },
          );
          startRef = `refs/remotes/origin/${published ? input.branch : input.targetBranch}`;
        }
      }
      if (!unborn) {
        const head = (
          await git([`--git-dir=${staging}`, 'rev-parse', '--verify', startRef])
        ).stdout.trim();
        await git([`--git-dir=${staging}`, 'update-ref', `refs/heads/${input.branch}`, head]);
      }
      await git([`--git-dir=${staging}`, 'symbolic-ref', 'HEAD', `refs/heads/${input.branch}`]);
      // Seed objects are shared; inherited local branches are not this agent's
      // work. Keep only its branch so later publication checks cover every
      // branch the agent creates without pinning other legacy corners.
      const inherited = (
        await git([`--git-dir=${staging}`, 'for-each-ref', '--format=%(refname)', 'refs/heads'])
      ).stdout
        .trim()
        .split('\n')
        .filter((ref) => ref && ref !== `refs/heads/${input.branch}`);
      inherited.push('refs/stash');
      await runOwnedFile('git', [`--git-dir=${staging}`, 'update-ref', '--stdin'], {
        input: inherited.map((ref) => `delete ${ref}\n`).join(''),
      });

      // PlaceSession may already bind this directory into a live sandbox.
      // Replacing its inode loses that writable mount, exposing the new Git
      // storage through the read-only parent instead. Populate it in place;
      // HEAD is the completion marker, so interrupted installs rebuild here.
      await mkdir(paths.gitCommonDir, { recursive: true });
      for (const entry of await readdir(paths.gitCommonDir))
        if (entry !== workspaceDependenciesDir)
          await rm(resolve(paths.gitCommonDir, entry), { recursive: true, force: true });
      for (const entry of await readdir(staging)) {
        if (entry !== 'HEAD')
          await rename(resolve(staging, entry), resolve(paths.gitCommonDir, entry));
      }
      await rename(resolve(staging, 'HEAD'), resolve(paths.gitCommonDir, 'HEAD'));
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  await git([`--git-dir=${paths.gitCommonDir}`, 'remote', 'set-url', 'origin', input.remote]);
  await git([
    `--git-dir=${paths.gitCommonDir}`,
    'config',
    '--replace-all',
    'remote.origin.fetch',
    '+refs/heads/*:refs/remotes/origin/*',
  ]);
  if (!creating && input.targetBranch)
    await fetchTargetOrBootstrap(paths.gitCommonDir, input.targetBranch);
  await git([`--git-dir=${paths.gitCommonDir}`, 'config', 'extensions.worktreeConfig', 'true']);
  const gitFile = resolve(paths.path, '.git');
  const pendingFiles = resolve(paths.gitCommonDir, 'beeline-worktree-pending');
  const attached =
    existsSync(gitFile) &&
    (await git(['-C', paths.path, 'rev-parse', '--absolute-git-dir']).then(
      () => true,
      () => false,
    ));
  if (!attached) {
    await mkdir(paths.path, { recursive: true });
    const marker = await lstat(gitFile).catch(() => undefined);
    if (marker && !marker.isFile()) throw new Error('refusing invalid agent checkout Git marker');
    const hasFiles = (await readdir(paths.path)).some((entry) => entry !== '.git');
    // Keep track of an empty worktree across interruptions after .git is linked.
    if (!hasFiles) await writeFile(pendingFiles, '');
    // A lost .git file need not lose the index (including staged work).
    const checkoutParent = dirname(paths.path);
    const canonicalParent = await realpath(checkoutParent);
    const canonicalGitFile = resolve(canonicalParent, basename(paths.path), '.git');
    const registrations = resolve(paths.gitCommonDir, 'worktrees');
    let registration: string | undefined;
    let abandonedWorktree: string | undefined;
    for (const entry of await readdir(registrations).catch(() => [] as string[])) {
      const candidate = resolve(registrations, entry);
      const gitdir = await readFile(resolve(candidate, 'gitdir'), 'utf8').catch(() => '');
      const target = resolve(candidate, gitdir.trim());
      if (target === gitFile || target === canonicalGitFile) {
        registration = candidate;
        break;
      }
      const worktree = dirname(target);
      const temporary = dirname(worktree);
      if (
        target === resolve(temporary, 'worktree', '.git') &&
        [checkoutParent, canonicalParent].includes(dirname(temporary)) &&
        /^\.reattach-[A-Za-z0-9]{6}$/.test(basename(temporary)) &&
        (await readFile(resolve(candidate, 'HEAD'), 'utf8').catch(() => '')).trim() ===
          `ref: refs/heads/${input.branch}`
      )
        abandonedWorktree = worktree;
    }
    if (registration) {
      await writeFile(gitFile, `gitdir: ${registration}\n`);
      await git([`--git-dir=${paths.gitCommonDir}`, 'worktree', 'repair', paths.path]);
    } else {
      // Register at an empty temporary path, then move only the Git marker.
      // Bound checkout folders keep their inode and surviving files in place.
      if (abandonedWorktree) {
        // The checkout lock is held, so this earlier temporary attachment is abandoned.
        for (const path of [dirname(abandonedWorktree), abandonedWorktree])
          if ((await lstat(path).catch(() => undefined))?.isSymbolicLink())
            throw new Error('refusing symlinked temporary agent checkout');
        await git([
          `--git-dir=${paths.gitCommonDir}`,
          'worktree',
          'remove',
          '--force',
          '--force',
          abandonedWorktree,
        ]);
      }
      const temporary = await mkdtemp(resolve(checkoutParent, '.reattach-'));
      try {
        const worktree = resolve(temporary, 'worktree');
        const hasBranchCommit = await git([
          `--git-dir=${paths.gitCommonDir}`,
          'rev-parse',
          '--verify',
          `refs/heads/${input.branch}`,
        ]).then(
          () => true,
          () => false,
        );
        await git(
          hasBranchCommit
            ? [
                `--git-dir=${paths.gitCommonDir}`,
                'worktree',
                'add',
                '--no-checkout',
                worktree,
                input.branch,
              ]
            : [
                `--git-dir=${paths.gitCommonDir}`,
                'worktree',
                'add',
                '--orphan',
                '-b',
                input.branch,
                worktree,
              ],
        );
        await rename(resolve(worktree, '.git'), gitFile);
        await git([`--git-dir=${paths.gitCommonDir}`, 'worktree', 'repair', paths.path]);
        await git(['-C', paths.path, 'config', '--worktree', 'core.bare', 'false']);
        if (hasBranchCommit) await git(['-C', paths.path, 'reset', '--mixed', 'HEAD']);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  }
  await git(['-C', paths.path, 'config', '--worktree', 'core.bare', 'false']);
  if (existsSync(pendingFiles)) {
    const hasHead = await git(['-C', paths.path, 'rev-parse', '--verify', 'HEAD']).then(
      () => true,
      () => false,
    );
    if (hasHead) {
      const index = (await git(['-C', paths.path, 'rev-parse', '--git-path', 'index'])).stdout.trim();
      if (!existsSync(resolve(paths.path, index)))
        await git(['-C', paths.path, 'reset', '--mixed', 'HEAD']);
      // Restore only missing paths from the index and keep any surviving files.
      const missing = (
        await git(['-C', paths.path, '-c', 'core.quotePath=true', 'ls-files', '--deleted'])
      ).stdout;
      if (missing)
        await runOwnedFile('git', ['-C', paths.path, 'checkout-index', '--stdin'], { input: missing });
    }
    await rm(pendingFiles);
  }
  // An import an older helper left unfinished is never resumed from here.
  if (await readFile(resolve(paths.gitCommonDir, 'beeline-legacy-pending'), 'utf8').catch(() => ''))
    throw new Error('legacy thread import source changed');
  // Git must identify exactly this checkout, including when root is symlinked.
  const top = (await git(['-C', paths.path, 'rev-parse', '--show-toplevel'])).stdout.trim();
  if ((await realpath(top)) !== (await realpath(paths.path)))
    throw new Error('agent thread checkout escaped its root');
  return paths;
}

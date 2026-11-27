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
}): Promise<{ path: string; gitCommonDir: string }> {
  const paths = agentCornerCheckoutPaths(input.root, input.cornerId, input.agentId);
  await mkdir(dirname(paths.gitCommonDir), { recursive: true });
  if ((await lstat(paths.path).catch(() => undefined))?.isSymbolicLink())
    throw new Error('refusing symlinked agent checkout');
  const creating = !existsSync(resolve(paths.gitCommonDir, 'HEAD'));
  const label = `repositories/${basename(paths.gitCommonDir)}`;
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
      if (input.targetBranch) {
        const fetchBranch = (branch: string) =>
          fetchRepositoryCache({
            gitDir: staging,
            label,
            args: ['origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
            env: input.env,
          });
        await fetchBranch(input.targetBranch);
        const published = await fetchBranch(input.branch).then(
          () => true,
          (error) => {
            if (
              /remote ref does not exist|remote reference does not exist|couldn't find remote ref/i.test(
                String(error),
              )
            )
              return false;
            throw error;
          },
        );
        startRef = `refs/remotes/origin/${published ? input.branch : input.targetBranch}`;
      }
      const head = (
        await git([`--git-dir=${staging}`, 'rev-parse', '--verify', startRef])
      ).stdout.trim();
      await git([`--git-dir=${staging}`, 'update-ref', `refs/heads/${input.branch}`, head]);
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
    await fetchRepositoryCache({
      gitDir: paths.gitCommonDir,
      label,
      args: [
        'origin',
        `+refs/heads/${input.targetBranch}:refs/remotes/origin/${input.targetBranch}`,
      ],
      env: input.env,
    });
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
    // A lost .git file need not lose the index (including staged work). Reuse
    // only the registration that names this exact checkout, never another one.
    const registrations = resolve(paths.gitCommonDir, 'worktrees');
    let registration: string | undefined;
    for (const entry of await readdir(registrations).catch(() => [] as string[])) {
      const candidate = resolve(registrations, entry);
      const target = await readFile(resolve(candidate, 'gitdir'), 'utf8').catch(() => '');
      if (resolve(target.trim()) === gitFile) {
        registration = candidate;
        break;
      }
    }
    if (registration) {
      await writeFile(gitFile, `gitdir: ${registration}\n`);
      await git([`--git-dir=${paths.gitCommonDir}`, 'worktree', 'repair', paths.path]);
    } else {
      // Register at an empty temporary path, then move only the Git marker.
      // Bound checkout folders keep their inode and surviving files in place.
      const temporary = await mkdtemp(resolve(dirname(paths.path), '.reattach-'));
      try {
        const worktree = resolve(temporary, 'worktree');
        await git([
          `--git-dir=${paths.gitCommonDir}`,
          'worktree',
          'add',
          '--no-checkout',
          worktree,
          input.branch,
        ]);
        await rename(resolve(worktree, '.git'), gitFile);
        await git([`--git-dir=${paths.gitCommonDir}`, 'worktree', 'repair', paths.path]);
        await git(['-C', paths.path, 'config', '--worktree', 'core.bare', 'false']);
        await git(['-C', paths.path, 'reset', '--mixed', 'HEAD']);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  }
  await git(['-C', paths.path, 'config', '--worktree', 'core.bare', 'false']);
  if (existsSync(pendingFiles)) {
    const index = (await git(['-C', paths.path, 'rev-parse', '--git-path', 'index'])).stdout.trim();
    if (!existsSync(resolve(paths.path, index)))
      await git(['-C', paths.path, 'reset', '--mixed', 'HEAD']);
    // Restore only missing paths from the index and keep any surviving files.
    const missing = (
      await git(['-C', paths.path, '-c', 'core.quotePath=true', 'ls-files', '--deleted'])
    ).stdout;
    if (missing)
      await runOwnedFile('git', ['-C', paths.path, 'checkout-index', '--stdin'], { input: missing });
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

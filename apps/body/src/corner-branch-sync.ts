import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Two agents, one branch. The branch on GitHub, not any one helper's
 * checkout, is the shared artifact, so before a thread turn the remote branch
 * is fetched and this checkout is brought onto it:
 *
 *   - remote absent, or already contained in this checkout → nothing to do;
 *   - this checkout strictly behind → fast-forward;
 *   - the histories diverged → rebase this checkout's own commits on top;
 *   - uncommitted work or a conflicting rebase → keep local work and throw.
 *
 * Unpublished commits survive a failed sync. The remote is never force-pushed.
 */
export async function syncCornerBranch(input: {
  worktreePath: string;
  featureBranch: string;
  env?: NodeJS.ProcessEnv;
}): Promise<'unchanged' | 'fast-forwarded' | 'rebased'> {
  const git = async (args: readonly string[]) =>
    (
      await execFileAsync('git', ['-C', input.worktreePath, ...args], {
        ...(input.env ? { env: input.env } : {}),
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout;
  const marker = await readFile(resolve(input.worktreePath, '.git'), 'utf8').catch(() => '');
  const gitDir = resolve(
    input.worktreePath,
    marker.startsWith('gitdir: ') ? marker.slice(8).trim() : '.git',
  );
  for (const directory of ['rebase-merge', 'rebase-apply'])
    if (
      await access(resolve(gitDir, directory)).then(
        () => true,
        () => false,
      )
    )
      throw new Error('a rebase is in progress; finish it before refreshing the branch');
  const remoteRef = `refs/remotes/origin/${input.featureBranch}`;
  const fetched = await git([
    'fetch',
    'origin',
    `+refs/heads/${input.featureBranch}:${remoteRef}`,
  ]).then(
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
  // Nothing has been pushed to this branch yet: this checkout is all of it.
  if (!fetched) return 'unchanged';
  const remote = (await git(['rev-parse', remoteRef])).trim();
  const local = (await git(['rev-parse', 'HEAD'])).trim();
  const contains = (head: string, ancestor: string) =>
    git(['merge-base', '--is-ancestor', ancestor, head]).then(
      () => true,
      () => false,
    );
  // Equal, or ahead: this checkout's push will fast-forward the branch.
  if (local === remote || (await contains(local, remote))) return 'unchanged';
  // Never turn another agent's unfinished edits into a destructive realignment.
  if ((await git(['status', '--porcelain'])).trim())
    throw new Error(
      'uncommitted work is preserved; commit or stash it, then sync with the remote branch',
    );
  const behind = await contains(remote, local);
  try {
    await git(behind ? ['merge', '--ff-only', remote] : ['rebase', remote]);
    return behind ? 'fast-forwarded' : 'rebased';
  } catch (error) {
    if (!behind) await git(['rebase', '--abort']).catch(() => undefined);
    throw new Error('rebase conflict: local commits preserved; resolve against the remote branch', {
      cause: error,
    });
  }
}

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { syncCornerBranch } from './corner-branch-sync.js';

const exec = promisify(execFile);

it.each([false, true])(
  'preserves an unfinished rebase and its resolutions (apply=%s)',
  async (apply) => {
    const root = await mkdtemp(join(tmpdir(), 'branch-sync-'));
    const git = (...args: string[]) =>
      exec('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args]);
    try {
      await git('init', '-b', 'main');
      await writeFile(join(root, 'file'), 'base\n');
      await git('add', 'file');
      await git('commit', '-m', 'base');
      await git('checkout', '-b', 'feature');
      await writeFile(join(root, 'file'), 'feature\n');
      await git('commit', '-am', 'feature');
      await git('checkout', 'main');
      await writeFile(join(root, 'file'), 'main\n');
      await git('commit', '-am', 'main');
      await git('checkout', 'feature');
      await expect(git('rebase', ...(apply ? ['--apply'] : []), 'main')).rejects.toThrow();
      await writeFile(join(root, 'file'), 'partially resolved\n');
      await git('add', 'file');
      const head = (await git('rev-parse', 'HEAD')).stdout;
      await expect(
        syncCornerBranch({ worktreePath: root, featureBranch: 'feature' }),
      ).rejects.toThrow('a rebase is in progress');
      expect(await readFile(join(root, 'file'), 'utf8')).toBe('partially resolved\n');
      expect((await git('show', ':file')).stdout).toBe('partially resolved\n');
      expect((await git('rev-parse', 'HEAD')).stdout).toBe(head);
      await git('rebase', '--abort');
      expect((await git('branch', '--show-current')).stdout.trim()).toBe('feature');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

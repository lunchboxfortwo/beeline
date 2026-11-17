import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { materializeAgentCornerCheckout } from './agent-corner-checkout.js';

const exec = promisify(execFile);
const git = async (...args: string[]) => (await exec('git', args)).stdout.trim();
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each(['empty folder', 'missing .git', 'rebuilt storage', 'both empty', 'intact', 'branch elsewhere'])('recovers %s without replacing bound folders', async state => {
  const root = await mkdtemp(join(tmpdir(), 'agent-checkout-'));
  roots.push(root);
  const seed = join(root, 'seed');
  await git('init', '-b', 'main', seed);
  await writeFile(join(seed, 'proof.txt'), 'seed\n');
  await git('-C', seed, 'add', '.');
  await git('-C', seed, '-c', 'user.name=Proof', '-c', 'user.email=proof@example.com', 'commit', '-m', 'seed');
  const input = { root, cornerId: 'thread', agentId: 'agent', sourceGitDir: join(seed, '.git'),
    remote: `file://${seed}`, branch: 'feature/thread', startRef: 'refs/heads/main', targetBranch: 'main' };
  const paths = await materializeAgentCornerCheckout(input);
  if (state === 'branch elsewhere') {
    const other = join(root, 'other');
    await git(`--git-dir=${paths.gitCommonDir}`, 'worktree', 'move', paths.path, other);
    await mkdir(paths.path);
    await writeFile(join(paths.path, 'proof.txt'), 'preserved\n');
    await expect(materializeAgentCornerCheckout(input)).rejects.toThrow(/already (checked out|used by worktree)/);
    expect(await readFile(join(paths.path, 'proof.txt'), 'utf8')).toBe('preserved\n');
    expect(await git('-C', other, 'branch', '--show-current')).toBe(input.branch);
    return;
  }
  const pathInode = (await stat(paths.path)).ino;
  const gitInode = (await stat(paths.gitCommonDir)).ino;
  if (state === 'empty folder' || state === 'both empty') {
    for (const entry of await readdir(paths.path)) await rm(join(paths.path, entry), { recursive: true, force: true });
  } else {
    await writeFile(join(paths.path, 'proof.txt'), 'local edit\n');
    await writeFile(join(paths.path, 'untracked.txt'), 'keep me\n');
    if (state === 'missing .git') {
      await git('-C', paths.path, 'add', 'proof.txt');
      await writeFile(join(paths.path, 'proof.txt'), 'unstaged edit\n');
      await rm(join(paths.path, '.git'));
    }
  }
  if (state === 'rebuilt storage') await rm(join(paths.gitCommonDir, 'HEAD'));
  if (state === 'both empty') {
    for (const entry of await readdir(paths.gitCommonDir)) await rm(join(paths.gitCommonDir, entry), { recursive: true, force: true });
  }
  await materializeAgentCornerCheckout(input);
  expect((await stat(paths.path)).ino).toBe(pathInode);
  expect((await stat(paths.gitCommonDir)).ino).toBe(gitInode);
  expect(await git('-C', paths.path, 'branch', '--show-current')).toBe(input.branch);
  const preserved = !['empty folder', 'both empty'].includes(state);
  expect(await readFile(join(paths.path, 'proof.txt'), 'utf8')).toBe(state === 'missing .git' ? 'unstaged edit\n' : preserved ? 'local edit\n' : 'seed\n');
  if (state === 'missing .git') expect(await git('-C', paths.path, 'show', ':proof.txt')).toBe('local edit');
  if (preserved) {
    expect(await readFile(join(paths.path, 'untracked.txt'), 'utf8')).toBe('keep me\n');
    expect(await git('-C', paths.path, 'status', '--porcelain')).toContain('M proof.txt');
  }
}, 30_000);

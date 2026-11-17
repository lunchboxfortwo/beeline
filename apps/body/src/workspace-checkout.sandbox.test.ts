import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { buildBwrapArgv, sandboxMountPlan } from './bwrap-sandbox.js';
import { cornerCheckoutFolders, materializeCornerWorktree } from './workspace-checkout.js';

const git = promisify(execFile);
const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each([false, true])('commits from the live thread sandbox after workspace setup (warm=%s)', async warm => {
  const root = await mkdtemp('/var/tmp/beeline-thread-checkout-');
  roots.push(root);
  const source = join(root, 'source');
  await mkdir(source);
  await git('git', ['init', '-b', 'main', source]);
  await writeFile(join(source, 'proof.txt'), 'seed\n');
  await git('git', ['-C', source, 'add', '.']);
  await git('git', ['-C', source, '-c', 'user.name=Proof', '-c', 'user.email=proof@example.com', 'commit', '-m', 'seed']);
  const input = { supervisorRoot: root, cornerId: 'thread', featureBranch: 'feature/thread', targetBranch: 'main',
    token: '', remote: `file://${source}`, committer: { name: 'Proof', publicKey: 'agent' } };
  const { path, gitCommonDir } = cornerCheckoutFolders(root, 'thread', 'agent');
  // PlaceSession mounts these folders before delivering the first prompt.
  await mkdir(path, { recursive: true });
  await mkdir(gitCommonDir, { recursive: true });
  if (warm) await materializeCornerWorktree(input);
  const inode = (await stat(gitCommonDir)).ino;
  const wrapped = buildBwrapArgv({ bwrapPath: '/usr/bin/bwrap',
    plan: sandboxMountPlan({ mode: 'edit', cwd: path, worktreePath: path, gitCommonDir, protectedPaths: [root] }),
    cwd: path, command: process.execPath, args: ['-e', `
      console.log('ready');
      require('node:readline').createInterface({ input: process.stdin }).once('line', () => {
        try {
          require('node:fs').writeFileSync('proof.txt', 'thread edit\\n');
          const git = args => require('node:child_process').execFileSync('/usr/bin/git', args, { encoding: 'utf8' });
          git(['add', 'proof.txt']);
          git(['commit', '-m', 'thread edit']);
          console.log(git(['rev-parse', 'HEAD']).trim());
        } catch (error) { console.error(error.stderr?.toString() ?? String(error)); process.exitCode = 1; }
        process.stdin.destroy();
      });
    `] });
  const child = spawn(wrapped.command, wrapped.args, { stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const lines: string[] = [];
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  const ended = new Promise<number | null>(resolve => child.once('exit', resolve));
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`sandbox exited before ready: ${code}: ${stderr}`)));
    createInterface({ input: child.stdout! }).on('line', line => { lines.push(line); if (line === 'ready') resolve(); });
  });
  await materializeCornerWorktree(input);
  child.stdin!.end('commit\n');
  expect(await ended, stderr).toBe(0);
  expect((await stat(gitCommonDir)).ino).toBe(inode);
  const head = (await git('git', ['-C', path, 'rev-parse', 'HEAD'])).stdout.trim();
  expect(lines.at(-1)).toBe(head);
  expect(await readFile(join(path, 'proof.txt'), 'utf8')).toBe('thread edit\n');
});

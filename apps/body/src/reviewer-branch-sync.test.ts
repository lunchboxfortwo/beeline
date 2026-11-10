import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { MonolithCornerTurnLoop } from './monolith-corner-turn.js';
import { monolithCornerTurnLoopSyncBranch } from './monolith-corner-turn-harvest-warm-node-modules.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-sync-'));
  roots.push(root);
  const remote = join(root, 'remote.git');
  const author = join(root, 'author');
  const reviewer = join(root, 'reviewer');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
  git(root, 'init', '--bare', remote);
  git(root, 'clone', remote, author);
  git(author, 'config', 'user.name', 'Reviewer test');
  git(author, 'config', 'user.email', 'reviewer@example.test');
  git(author, 'checkout', '-b', 'feature/reviewer-sync');
  writeFileSync(join(author, 'tracked.txt'), 'original\n');
  git(author, 'add', 'tracked.txt');
  git(author, 'commit', '-m', 'Initial tracked file');
  git(author, 'push', 'origin', 'HEAD');
  git(root, 'clone', '--branch', 'feature/reviewer-sync', remote, reviewer);
  git(reviewer, 'checkout', '--detach');
  writeFileSync(join(author, 'tracked.txt'), 'pushed update\n');
  git(author, 'commit', '-am', 'Update tracked file');
  git(author, 'push', 'origin', 'HEAD');
  const head = git(author, 'rev-parse', 'HEAD');
  const ctx = {
    options: {
      worktreePath: reviewer,
      parentRoomId: 'test-room',
      repository: { featureBranch: 'feature/reviewer-sync' },
      api: { execute: async () => ({ token: 'local-fixture-token' }) },
    },
    reviewerCheckout: true,
    forcedStop: false,
  } as unknown as MonolithCornerTurnLoop;
  return { reviewer, head, ctx, git };
}

it('reviewer-scratch-1: syncs to the pushed head and preserves untracked scratch files', async () => {
  const { reviewer, head, ctx, git } = fixture();
  mkdirSync(join(reviewer, '.beeline-review'));
  const scratch = join(reviewer, '.beeline-review', 'proof.sh');
  writeFileSync(scratch, '# reviewer proof\n');
  await monolithCornerTurnLoopSyncBranch(ctx);
  expect(git(reviewer, 'rev-parse', 'HEAD')).toBe(head);
  expect(readFileSync(join(reviewer, 'tracked.txt'), 'utf8')).toBe('pushed update\n');
  expect(readFileSync(scratch, 'utf8')).toBe('# reviewer proof\n');
});

it.each([false, true])('preserves and refuses tracked edits (staged: %s)', async (staged) => {
  const { reviewer, ctx, git } = fixture();
  const previousHead = git(reviewer, 'rev-parse', 'HEAD');
  writeFileSync(join(reviewer, 'tracked.txt'), 'reviewer edit\n');
  if (staged) git(reviewer, 'add', 'tracked.txt');
  await expect(monolithCornerTurnLoopSyncBranch(ctx)).rejects.toThrow(
    'review checkout has uncommitted work; preserve it before syncing',
  );
  expect(git(reviewer, 'rev-parse', 'HEAD')).toBe(previousHead);
  expect(readFileSync(join(reviewer, 'tracked.txt'), 'utf8')).toBe('reviewer edit\n');
  if (staged) expect(git(reviewer, 'show', ':tracked.txt')).toBe('reviewer edit');
});

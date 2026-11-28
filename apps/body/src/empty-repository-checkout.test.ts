import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { syncCornerBranch } from './corner-branch-sync.js';
import { cornerGitHubCommandRefusal } from './corner-github-auth.js';
import { bootstrapEmptyGitHubRemote } from './empty-repository-bootstrap.js';
import { materializeCornerWorktree, prepareWorkspace } from './workspace-checkout.js';
import { testTmpDir } from '../../../packages/test-helpers/helpers/helper.js';

const exec = promisify(execFile);
const git = async (...args: string[]) => (await exec('git', args)).stdout.trim();
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function seedRemoteCommit(bareRemote: string, branch: string, file: string, content: string) {
  const work = await mkdtemp(`${testTmpDir()}/beeline-empty-seed-`);
  roots.push(work);
  await git('init', '-b', branch, work);
  await writeFile(join(work, file), content);
  await git('-C', work, 'add', file);
  await git('-C', work, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-m', 'Initial commit');
  await git(`--git-dir=${bareRemote}`, 'fetch', `file://${work}`, `+refs/heads/${branch}:refs/heads/${branch}`);
  return git('-C', work, 'rev-parse', 'HEAD');
}

it('bootstrapEmptyGitHubRemote seeds an empty GitHub repository and skips non-empty ones', async () => {
  const headSha = 'd'.repeat(40);
  const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const fetchEmpty: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    requests.push({ method, path: `${parsed.pathname}${parsed.search}`, ...(body ? { body } : {}) });
    if (method === 'GET' && parsed.pathname === '/repos/acme/wargame/branches/develop')
      return Response.json({ message: 'Branch not found' }, { status: 404 });
    if (method === 'GET' && parsed.pathname === '/repos/acme/wargame/branches')
      return Response.json([]);
    if (method === 'GET' && parsed.pathname === '/repos/acme/wargame')
      return Response.json({ name: 'wargame', default_branch: 'main' });
    if (method === 'PUT' && parsed.pathname === '/repos/acme/wargame/contents/README.md')
      return Response.json({ commit: { sha: headSha } }, { status: 201 });
    if (method === 'POST' && parsed.pathname === '/repos/acme/wargame/git/refs')
      return Response.json({ ref: 'refs/heads/develop', object: { sha: headSha } }, { status: 201 });
    throw new Error(`Unexpected request: ${method} ${parsed.pathname}`);
  };

  expect(
    await bootstrapEmptyGitHubRemote({
      remote: 'https://github.com/acme/wargame.git',
      targetBranch: 'develop',
      token: 'ghs_test',
      apiBaseUrl: 'https://api.github.test',
      fetchImpl: fetchEmpty,
    }),
  ).toBe(true);
  expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({
    message: 'Initial commit',
    content: Buffer.from('# wargame\n').toString('base64'),
  });
  expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
    ref: 'refs/heads/develop',
    sha: headSha,
  });

  // Non-empty repository whose targetBranch is absent must never be modified.
  const fetchNonEmpty: typeof fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/repos/acme/wargame/branches/main')
      return Response.json({ message: 'Branch not found' }, { status: 404 });
    if (parsed.pathname === '/repos/acme/wargame/branches')
      return Response.json([{ name: 'master', commit: { sha: headSha } }]);
    throw new Error(`Unexpected write to non-empty repository: ${parsed.pathname}`);
  };
  expect(
    await bootstrapEmptyGitHubRemote({
      remote: 'https://github.com/acme/wargame.git',
      targetBranch: 'main',
      token: 'ghs_test',
      apiBaseUrl: 'https://api.github.test',
      fetchImpl: fetchNonEmpty,
    }),
  ).toBe(false);
});

it('thread checkout bootstraps an empty remote, branches off main, and pushes the feature branch', async () => {
  const root = await mkdtemp(`${testTmpDir()}/beeline-empty-thread-`);
  roots.push(root);
  const remote = join(root, 'remote.git');
  await git('init', '--bare', '-b', 'main', remote);

  let initialHead = '';
  const bootstrapEmptyRemote = vi.fn(async () => {
    initialHead = await seedRemoteCommit(remote, 'main', 'README.md', '# wargame\n');
    return true;
  });

  const { path } = await materializeCornerWorktree({
    cornerId: 'thread1',
    remote: `file://${remote}`,
    targetBranch: 'main',
    featureBranch: 'feature/corner-thread1',
    token: '',
    supervisorRoot: join(root, 'state'),
    committer: { name: 'Crayon', publicKey: 'a'.repeat(64) },
    bootstrapEmptyRemote,
  });

  expect(bootstrapEmptyRemote).toHaveBeenCalledTimes(1);
  expect(await git('-C', path, 'branch', '--show-current')).toBe('feature/corner-thread1');
  expect(await git('-C', path, 'rev-parse', 'HEAD')).toBe(initialHead);
  expect(await readFile(join(path, 'README.md'), 'utf8')).toBe('# wargame\n');

  // Verify branch work commits cleanly on top of the bootstrapped base and passes the push/PR guard.
  await writeFile(join(path, 'app.txt'), 'hello\n');
  await git('-C', path, 'add', 'app.txt');
  await git('-C', path, 'commit', '-m', 'Add app');
  const featureHead = await git('-C', path, 'rev-parse', 'HEAD');
  expect(
    await cornerGitHubCommandRefusal(
      'git',
      ['push', '-u', 'origin', 'feature/corner-thread1'],
      'feature/corner-thread1',
      'main',
      async (source) => ({ branch: source ?? 'feature/corner-thread1' }),
    ),
  ).toBeUndefined();
  expect(
    await cornerGitHubCommandRefusal(
      'gh',
      ['pr', 'create', '--title', 'Add app', '--body', 'Initial app', '--base', 'main', '--head', 'feature/corner-thread1'],
      'feature/corner-thread1',
      'main',
    ),
  ).toBeUndefined();
  await git(`--git-dir=${remote}`, 'fetch', `file://${path}`, '+refs/heads/feature/corner-thread1:refs/heads/feature/corner-thread1');
  expect(await git(`--git-dir=${remote}`, 'rev-parse', 'refs/heads/feature/corner-thread1')).toBe(featureHead);
  expect(await git(`--git-dir=${remote}`, 'merge-base', 'refs/heads/main', 'refs/heads/feature/corner-thread1')).toBe(initialHead);
});

it('refuses to bootstrap when a non-empty remote is missing targetBranch', async () => {
  const root = await mkdtemp(`${testTmpDir()}/beeline-missing-target-`);
  roots.push(root);
  const remote = join(root, 'remote.git');
  await git('init', '--bare', '-b', 'master', remote);
  await seedRemoteCommit(remote, 'master', 'README.md', '# existing\n');

  const bootstrapEmptyRemote = vi.fn(async () => true);
  await expect(
    materializeCornerWorktree({
      cornerId: 'thread1',
      remote: `file://${remote}`,
      targetBranch: 'main',
      featureBranch: 'feature/corner-thread1',
      token: '',
      supervisorRoot: join(root, 'state'),
      committer: { name: 'Crayon', publicKey: 'a'.repeat(64) },
      bootstrapEmptyRemote,
    }),
  ).rejects.toThrow(/couldn't find remote ref|remote ref/i);
  expect(bootstrapEmptyRemote).not.toHaveBeenCalled();
});

it('handles empty read-only Room and unborn thread checkouts and advances once main appears', async () => {
  const root = await mkdtemp(`${testTmpDir()}/beeline-empty-workspace-`);
  roots.push(root);
  const remote = join(root, 'remote.git');
  await git('init', '--bare', '-b', 'main', remote);

  const api = {
    execute: async (name: string) => {
      if (name === 'getRoomRepositoryState')
        return { resolution: 'repository', remote: `file://${remote}`, targetBranch: 'main' };
      if (name === 'getCornerRestoreState') return {};
      if (name === 'postCornerRemoteState') return {};
      throw new Error(`Unexpected operation ${name}`);
    },
  } as unknown as DaemonApiClient;
  const base = {
    api,
    config: {} as BodyConfig,
    supervisorRoot: join(root, 'state'),
    workspaceId: 'workspace',
    agent: { name: 'Crayon', publicKey: 'a'.repeat(64) },
  };

  // Read-only Room checkout succeeds on an empty repository.
  const roomEmpty = await prepareWorkspace({ ...base, placeId: 'room' });
  expect(roomEmpty).toContain('Checkout ready at ');
  expect(roomEmpty).toContain('repository is empty; no commits on main yet');

  // Unborn thread checkout succeeds on an empty local remote.
  const threadEmpty = await prepareWorkspace({ ...base, placeId: 'thread', parentRoomId: 'room' });
  expect(threadEmpty).toContain('Checkout ready at ');
  expect(threadEmpty).toContain('repository is empty; no commits on main yet');
  const threadPath = threadEmpty.slice('Checkout ready at '.length).split(' on ')[0]!;
  expect(await git('-C', threadPath, 'symbolic-ref', '--short', 'HEAD')).toBe('feature/corner-thread');

  // Once main gets its first commit, both Room and thread checkouts advance cleanly.
  const head = await seedRemoteCommit(remote, 'main', 'README.md', '# wargame\n');
  const roomReady = await prepareWorkspace({ ...base, placeId: 'room' });
  expect(roomReady).toContain(`HEAD is ${head}.`);
  const roomPath = roomReady.slice('Checkout ready at '.length).split(' on ')[0]!;
  expect(await readFile(join(roomPath, 'README.md'), 'utf8')).toBe('# wargame\n');

  const threadReady = await prepareWorkspace({ ...base, placeId: 'thread', parentRoomId: 'room' });
  expect(threadReady).toContain(`HEAD is ${head}.`);
  expect(await readFile(join(threadPath, 'README.md'), 'utf8')).toBe('# wargame\n');
  expect(existsSync(join(threadPath, '.git'))).toBe(true);
});

it('syncCornerBranch fast-forwards an unborn worktree when the remote feature branch appears', async () => {
  const root = await mkdtemp(`${testTmpDir()}/beeline-unborn-sync-`);
  roots.push(root);
  const remote = join(root, 'remote.git');
  const local = join(root, 'local');
  await git('init', '--bare', '-b', 'main', remote);
  await git('init', '-b', 'feature/test', local);
  await git('-C', local, 'remote', 'add', 'origin', `file://${remote}`);

  expect(await syncCornerBranch({ worktreePath: local, featureBranch: 'feature/test' })).toBe('unchanged');

  const pushed = await seedRemoteCommit(remote, 'feature/test', 'hello.txt', 'hi\n');
  expect(await syncCornerBranch({ worktreePath: local, featureBranch: 'feature/test' })).toBe('fast-forwarded');
  expect(await git('-C', local, 'rev-parse', 'HEAD')).toBe(pushed);
  expect(await readFile(join(local, 'hello.txt'), 'utf8')).toBe('hi\n');
});

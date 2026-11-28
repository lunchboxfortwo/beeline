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
const BOOTSTRAP_MESSAGE = 'Initial commit (Beeline repository bootstrap)';

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function seedRemoteCommit(
  bareRemote: string,
  branch: string,
  file: string,
  content: string,
  message = 'Initial commit',
) {
  const work = await mkdtemp(`${testTmpDir()}/beeline-empty-seed-`);
  roots.push(work);
  await git('init', '-b', branch, work);
  await writeFile(join(work, file), content);
  await git('-C', work, 'add', file);
  await git('-C', work, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-m', message);
  await git(`--git-dir=${bareRemote}`, 'fetch', `file://${work}`, `+refs/heads/${branch}:refs/heads/${branch}`);
  return git('-C', work, 'rev-parse', 'HEAD');
}

it('bootstrapEmptyGitHubRemote resumes target-branch creation on retry after README succeeds and first ref request fails', async () => {
  const headSha = 'd'.repeat(40);
  let defaultCreated = false;
  let targetCreated = false;
  let putCalls = 0;
  let refAttempts = 0;
  const fetchRetry: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const method = init?.method ?? 'GET';
    if (method === 'GET' && parsed.pathname === '/repos/acme/wargame/branches/develop') {
      return targetCreated
        ? Response.json({ name: 'develop', commit: { sha: headSha } })
        : Response.json({ message: 'Branch not found' }, { status: 404 });
    }
    if (method === 'GET' && parsed.pathname === '/repos/acme/wargame/branches') {
      return Response.json(defaultCreated ? [{ name: 'main', commit: { sha: headSha } }] : []);
    }
    if (method === 'GET' && parsed.pathname === '/repos/acme/wargame')
      return Response.json({ name: 'wargame', default_branch: 'main' });
    if (method === 'PUT' && parsed.pathname === '/repos/acme/wargame/contents/README.md') {
      putCalls += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        message: BOOTSTRAP_MESSAGE,
        content: Buffer.from('# wargame\n').toString('base64'),
      });
      expect(body).not.toHaveProperty('branch');
      defaultCreated = true;
      return Response.json({ commit: { sha: headSha } }, { status: 201 });
    }
    if (method === 'GET' && parsed.pathname === `/repos/acme/wargame/commits/${headSha}`) {
      return Response.json({
        sha: headSha,
        parents: [],
        commit: { message: BOOTSTRAP_MESSAGE },
        files: [{ filename: 'README.md', status: 'added' }],
      });
    }
    if (method === 'POST' && parsed.pathname === '/repos/acme/wargame/git/refs') {
      refAttempts += 1;
      if (refAttempts === 1)
        return Response.json({ message: 'Service Unavailable' }, { status: 503 });
      const body = JSON.parse(String(init?.body)) as { ref: string; sha: string };
      expect(body).toEqual({ ref: 'refs/heads/develop', sha: headSha });
      targetCreated = true;
      return Response.json({ ref: body.ref, object: { sha: body.sha } }, { status: 201 });
    }
    throw new Error(`Unexpected request: ${method} ${parsed.pathname}`);
  };

  await expect(
    bootstrapEmptyGitHubRemote({
      remote: 'https://github.com/acme/wargame.git',
      targetBranch: 'develop',
      token: 'ghs_test',
      apiBaseUrl: 'https://api.github.test',
      fetchImpl: fetchRetry,
    }),
  ).rejects.toThrow(/GitHub branch bootstrap failed: HTTP 503/);
  expect(defaultCreated).toBe(true);
  expect(targetCreated).toBe(false);

  expect(
    await bootstrapEmptyGitHubRemote({
      remote: 'https://github.com/acme/wargame.git',
      targetBranch: 'develop',
      token: 'ghs_test',
      apiBaseUrl: 'https://api.github.test',
      fetchImpl: fetchRetry,
    }),
  ).toBe(true);
  expect(putCalls).toBe(1);
  expect(refAttempts).toBe(2);
  expect(targetCreated).toBe(true);

  // A non-empty repository whose sole commit is not a Beeline bootstrap commit is left untouched.
  const fetchNonBootstrap: typeof fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/repos/acme/wargame/branches/develop')
      return Response.json({ message: 'Branch not found' }, { status: 404 });
    if (parsed.pathname === '/repos/acme/wargame/branches')
      return Response.json([{ name: 'main', commit: { sha: headSha } }]);
    if (parsed.pathname === '/repos/acme/wargame')
      return Response.json({ name: 'wargame', default_branch: 'main' });
    if (parsed.pathname === `/repos/acme/wargame/commits/${headSha}`)
      return Response.json({
        sha: headSha,
        parents: [],
        commit: { message: 'User initial commit' },
        files: [{ filename: 'README.md', status: 'added' }],
      });
    throw new Error(`Unexpected write to non-bootstrap repository: ${parsed.pathname}`);
  };
  expect(
    await bootstrapEmptyGitHubRemote({
      remote: 'https://github.com/acme/wargame.git',
      targetBranch: 'develop',
      token: 'ghs_test',
      apiBaseUrl: 'https://api.github.test',
      fetchImpl: fetchNonBootstrap,
    }),
  ).toBe(false);
});

it('thread checkout bootstraps an empty remote, resumes a failed custom target branch on retry, and passes push/PR guards', async () => {
  const root = await mkdtemp(`${testTmpDir()}/beeline-empty-thread-`);
  roots.push(root);
  const remote = join(root, 'remote.git');
  await git('init', '--bare', '-b', 'main', remote);

  let initialHead = '';
  let attempts = 0;
  const bootstrapEmptyRemote = vi.fn(async () => {
    attempts += 1;
    if (attempts === 1) {
      // Simulate README commit succeeding on default branch while target branch ref creation fails.
      initialHead = await seedRemoteCommit(remote, 'main', 'README.md', '# wargame\n', BOOTSTRAP_MESSAGE);
      throw new Error('GitHub branch bootstrap failed: HTTP 502');
    }
    // Retry resumes target-branch creation from the verified bootstrap commit on main.
    await git(`--git-dir=${remote}`, 'update-ref', 'refs/heads/develop', initialHead);
    return true;
  });

  const input = {
    cornerId: 'thread1',
    remote: `file://${remote}`,
    targetBranch: 'develop',
    featureBranch: 'feature/corner-thread1',
    token: '',
    supervisorRoot: join(root, 'state'),
    committer: { name: 'Crayon', publicKey: 'a'.repeat(64) },
    bootstrapEmptyRemote,
  };

  await expect(materializeCornerWorktree(input)).rejects.toThrow(/HTTP 502/);
  const { path } = await materializeCornerWorktree(input);

  expect(bootstrapEmptyRemote).toHaveBeenCalledTimes(2);
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
      'develop',
      async (source) => ({ branch: source ?? 'feature/corner-thread1' }),
    ),
  ).toBeUndefined();
  expect(
    await cornerGitHubCommandRefusal(
      'gh',
      ['pr', 'create', '--title', 'Add app', '--body', 'Initial app', '--base', 'develop', '--head', 'feature/corner-thread1'],
      'feature/corner-thread1',
      'develop',
    ),
  ).toBeUndefined();
  await git(`--git-dir=${remote}`, 'fetch', `file://${path}`, '+refs/heads/feature/corner-thread1:refs/heads/feature/corner-thread1');
  expect(await git(`--git-dir=${remote}`, 'rev-parse', 'refs/heads/feature/corner-thread1')).toBe(featureHead);
  expect(await git(`--git-dir=${remote}`, 'merge-base', 'refs/heads/develop', 'refs/heads/feature/corner-thread1')).toBe(initialHead);
});

it('refuses to bootstrap when a non-empty remote is missing targetBranch', async () => {
  const root = await mkdtemp(`${testTmpDir()}/beeline-missing-target-`);
  roots.push(root);
  const remote = join(root, 'remote.git');
  await git('init', '--bare', '-b', 'master', remote);
  await seedRemoteCommit(remote, 'master', 'README.md', '# existing\n');
  await seedRemoteCommit(remote, 'release', 'README.md', '# release\n');

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

  // Even with a single existing branch, refusing bootstrap propagates the missing-ref error.
  const singleBranchRemote = join(root, 'single.git');
  await git('init', '--bare', '-b', 'master', singleBranchRemote);
  await seedRemoteCommit(singleBranchRemote, 'master', 'README.md', '# user repo\n');
  const refusedBootstrap = vi.fn(async () => false);
  await expect(
    materializeCornerWorktree({
      cornerId: 'thread2',
      remote: `file://${singleBranchRemote}`,
      targetBranch: 'main',
      featureBranch: 'feature/corner-thread2',
      token: '',
      supervisorRoot: join(root, 'state'),
      committer: { name: 'Crayon', publicKey: 'a'.repeat(64) },
      bootstrapEmptyRemote: refusedBootstrap,
    }),
  ).rejects.toThrow(/couldn't find remote ref|remote ref/i);
  expect(refusedBootstrap).toHaveBeenCalledTimes(1);
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

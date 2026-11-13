import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { removeArchivedCornerData } from './archived-corner-cleanup.js';
import { wrapAgentCommand } from './bwrap-sandbox.js';
import { DEPENDENCY_LAYERS_DIR, dependencyLayers } from './dependency-generation.js';
import { pruneArchivedCheckoutStorage, rememberStorageOwner } from './storage-owners.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const roots: string[] = [];
const unreadable: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const path of unreadable.splice(0)) await chmod(path, 0o700);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('reports an unreadable archived proof once, without scheduling cleanup retries', async () => {
  const root = await mkdtemp(resolve(process.env.XDG_STATE_HOME!, 'archive-cleanup-'));
  roots.push(root);
  const checkout = resolve(root, 'beeline/corners/closed');
  const work = resolve(checkout, '.beeline-proof/overlay/a-work/work');
  await mkdir(work, { recursive: true });
  await writeFile(resolve(work, 'owned-by-proof'), 'proof');
  await chmod(work, 0);
  unreadable.push(work);
  await expect(readdir(work)).rejects.toMatchObject({ code: 'EACCES' });
  const removal = vi.mocked(rm).mockClear();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });

  await expect(removeArchivedCornerData(root, 'closed', checkout)).resolves.toEqual([]);
  expect(removal).toHaveBeenCalledOnce();
  expect(removal).toHaveBeenCalledWith(checkout, { recursive: true, force: true });
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]?.[1]).toMatchObject({ code: 'EACCES' });
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(removal).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledOnce();

  // A fresh trigger can clean up after the proof owner repairs access.
  await chmod(work, 0o700);
  unreadable.pop();
  expect(await removeArchivedCornerData(root, 'closed', checkout)).toHaveLength(1);
  expect(removal).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledOnce();
});

it('continues the archived checkout sweep after an unreadable leftover', async () => {
  const root = await mkdtemp(resolve(process.env.XDG_STATE_HOME!, 'archive-sweep-'));
  roots.push(root);
  const blocked = resolve(root, 'beeline/corners/a-blocked');
  const work = resolve(blocked, '.beeline-proof/overlay/a-work/work');
  const healthy = resolve(root, 'beeline/corners/b-healthy');
  await mkdir(work, { recursive: true });
  await writeFile(resolve(work, 'proof'), 'proof');
  await chmod(work, 0);
  unreadable.push(work);
  await mkdir(healthy, { recursive: true });
  for (const itemId of ['a-blocked', 'b-healthy'])
    await rememberStorageOwner(root, { workspaceId: 'workspace', roomId: itemId,
      kind: 'corners', itemId, archived: true, ended: true });
  const removal = vi.mocked(rm).mockClear();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  await pruneArchivedCheckoutStorage(root);

  expect(removal.mock.calls.map(([path]) => path)).toEqual([blocked, healthy]);
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]?.[1]).toMatchObject({ code: 'EACCES' });
  await expect(lstat(healthy)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await lstat(blocked)).isDirectory()).toBe(true);
});

it('deletes a private repository whose dependency layer was really mounted', async ({ skip }) => {
  const root = await mkdtemp(resolve(process.env.XDG_STATE_HOME!, 'archive-layer-'));
  roots.push(root);
  const itemId = 'a'.repeat(64);
  const checkout = resolve(root, 'beeline/corners', itemId);
  const repository = resolve(root, 'beeline/repositories', `agent-corner-${itemId}.git`);
  const tree = resolve(checkout, 'node_modules');
  await mkdir(resolve(tree, 'plugin/build'), { recursive: true });
  await writeFile(resolve(tree, 'plugin/build/old'), 'shared');
  const wrapped = wrapAgentCommand({
    bwrapPath: '/usr/bin/bwrap',
    spec: { mode: 'edit', cwd: checkout, worktreePath: checkout, protectedPaths: [],
      dependencyLayers: await dependencyLayers(resolve(repository, DEPENDENCY_LAYERS_DIR), [tree]) },
    command: 'sh', // Deleting a shared folder (as a Gradle clean does) leaves a whiteout under work/work.
    args: ['-c', 'rm -r node_modules/plugin/build && echo private > node_modules/plugin/new'],
  });
  const run = spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8' });
  // ubuntu-26.04 CI runners refuse the unprivileged overlay mount.
  if (run.status !== 0 && /permission denied|No such file/.test(run.stderr)) skip();
  expect(run.status, run.stderr).toBe(0);
  const warn = vi.spyOn(console, 'warn');

  expect(await removeArchivedCornerData(root, itemId, checkout)).toHaveLength(2);
  expect(warn).not.toHaveBeenCalled();
  await expect(lstat(repository)).rejects.toMatchObject({ code: 'ENOENT' });
});

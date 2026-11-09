import { expect, it, vi } from 'vitest';
import { GitHubAppClient, GitHubRequestError, type GitHubInstallationToken } from './github.js';

const token = (value: string): GitHubInstallationToken => ({
  token: value, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

it('MILO-GH-PERM-1: invalidates every exact grant for one installation only', async () => {
  const app = new GitHubAppClient({ appId: '1', slug: 'fixture', privateKey: 'unused' });
  let n = 0;
  const mint = vi.spyOn(app, 'mintInstallationToken').mockImplementation(async () => token(`mint-${++n}`));
  const scopes = [
    {},
    { repositoryIds: [101] },
    { repositoryIds: [102] },
    { repositoryIds: [101, 102], permissions: { actions: 'read', contents: 'read' } },
    { repositoryIds: [101], permissions: { actions: 'write' } },
    { repositoryIds: [101], permissions: {} },
  ];
  const before = await Promise.all(scopes.map(scope => app.installationToken(77, scope)));
  const other = await app.installationToken(770, { repositoryIds: [101] });
  app.invalidateInstallationTokens(77);
  const after = await Promise.all(scopes.map(scope => app.installationToken(77, scope)));
  expect(after.every((value, i) => value.token !== before[i].token)).toBe(true);
  expect(new Set(after.map(value => value.token)).size).toBe(scopes.length);
  for (const [i, scope] of scopes.entries()) {
    expect(await app.installationToken(77, scope)).toEqual(after[i]);
    expect(mint).toHaveBeenCalledWith(77, scope);
  }
  expect(await app.installationToken(77, {
    repositoryIds: [102, 101], permissions: { contents: 'read', actions: 'read' },
  })).toEqual(after[3]);
  expect(await app.installationToken(770, { repositoryIds: [101] })).toEqual(other);
  expect(mint).toHaveBeenCalledTimes(scopes.length * 2 + 1);
});

it.each(['old-first', 'fresh-first', 'old-rejects'] as const)(
  'MILO-GH-PERM-1: fences an invalidated mint and its cleanup (%s)', async order => {
    const app = new GitHubAppClient({ appId: '1', slug: 'fixture', privateKey: 'unused' });
    let releaseOld!: (value: GitHubInstallationToken) => void;
    let rejectOld!: (error: Error) => void;
    let releaseFresh!: (value: GitHubInstallationToken) => void;
    const mint = vi.spyOn(app, 'mintInstallationToken')
      .mockImplementationOnce(() => new Promise((resolve, reject) => { releaseOld = resolve; rejectOld = reject; }))
      .mockImplementationOnce(() => new Promise(resolve => { releaseFresh = resolve; }))
      .mockResolvedValue(token('unexpected'));
    const scope = { repositoryIds: [101], permissions: { actions: 'read' } };
    const old = app.installationToken(77, scope);
    const oldResult = order === 'old-rejects' ? expect(old).rejects.toThrow('refused') : expect(old).resolves.toMatchObject({ token: 'old' });
    app.invalidateInstallationTokens(77);
    const fresh = app.installationToken(77, scope);
    expect(mint).toHaveBeenCalledTimes(2);
    if (order === 'fresh-first') {
      releaseFresh(token('fresh'));
      await fresh;
    }
    if (order === 'old-rejects') rejectOld(new Error('refused'));
    else releaseOld(token('old'));
    await oldResult;
    const concurrent = app.installationToken(77, scope);
    expect(mint).toHaveBeenCalledTimes(2);
    releaseFresh(token('fresh'));
    await expect(fresh).resolves.toMatchObject({ token: 'fresh' });
    await expect(concurrent).resolves.toMatchObject({ token: 'fresh' });
    await expect(app.installationToken(77, scope)).resolves.toMatchObject({ token: 'fresh' });
    expect(mint).toHaveBeenCalledTimes(2);
  },
);

it('MILO-GH-PERM-1: a replacement refusal never falls back to an invalidated token', async () => {
  const app = new GitHubAppClient({ appId: '1', slug: 'fixture', privateKey: 'unused' });
  const refused = new GitHubRequestError('GitHub installation token', 403, 'Resource not accessible by integration');
  const mint = vi.spyOn(app, 'mintInstallationToken')
    .mockResolvedValueOnce(token('old'))
    .mockRejectedValueOnce(refused)
    .mockResolvedValueOnce(token('fresh'));
  const scope = { repositoryIds: [101] };
  await app.installationToken(77, scope);
  app.invalidateInstallationTokens(77);
  const first = app.installationToken(77, scope);
  const concurrent = app.installationToken(77, scope);
  await expect(first).rejects.toBe(refused);
  await expect(concurrent).rejects.toBe(refused);
  expect(mint).toHaveBeenCalledTimes(2);
  await expect(app.installationToken(77, scope)).resolves.toMatchObject({ token: 'fresh' });
  expect(mint).toHaveBeenCalledTimes(3);
});

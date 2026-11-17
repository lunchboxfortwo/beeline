import { expect, it, vi } from 'vitest';
import { GitHubAppClient } from './github.js';

it('lists every installation repository across GitHub pages', async () => {
  const app = new GitHubAppClient({ appId: '1', slug: 'fixture', privateKey: 'unused' });
  vi.spyOn(app, 'installationToken').mockResolvedValue({
    token: 'fixture', expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const repositories = Array.from({ length: 237 }, (_, index) => ({
    id: index + 1, name: `repo-${index}`, full_name: `owner/repo-${index}`,
    clone_url: `https://github.com/owner/repo-${index}.git`, default_branch: 'main',
  }));
  const request = vi.spyOn(app, 'request').mockImplementation(async url => {
    const page = Number(new URL(url).searchParams.get('page'));
    return Response.json({ repositories: repositories.slice((page - 1) * 100, page * 100) });
  });
  const result = await app.listRepositories(77);
  expect(result).toHaveLength(237);
  expect(result.map(repo => repo.id)).toEqual(repositories.map(repo => repo.id));
  expect(result[236]).toMatchObject({ fullName: 'owner/repo-236', installationId: 77 });
  expect(request.mock.calls.map(([url]) => new URL(url).searchParams.get('page'))).toEqual(['1', '2', '3']);
});

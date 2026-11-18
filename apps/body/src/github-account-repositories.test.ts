import { expect, it, vi } from 'vitest';
import { readPersonalGitHubRepositories } from './github-account-repositories.js';

it('discovers every personal repository across owners and pages using only the selected connection', async () => {
  const repositories = Array.from({ length: 237 }, (_, index) => ({ id: index + 1,
    full_name: `${['person', 'organization', 'collaborator'][index % 3]}/repo-${index}`,
    default_branch: index % 2 ? 'trunk' : 'main', private: index % 2 === 0 }));
  const call = vi.fn(async (_tool, args) => ({ response: { status: 200,
    body: JSON.stringify(repositories.slice((Number(args.http.query.page) - 1) * 100, Number(args.http.query.page) * 100)) } }));
  const result = await readPersonalGitHubRepositories({ call }, { reference: 'vault:selected', fieldNames: ['access_token'] });
  expect(result).toEqual(repositories.map(repo => ({ id: repo.id, fullName: repo.full_name, defaultBranch: repo.default_branch, private: repo.private })));
  expect(call.mock.calls.map(([, args]) => args.http.query.page)).toEqual(['1', '2', '3']);
  for (const [tool, args] of call.mock.calls) {
    expect(tool).toBe('use_credential');
    expect(args.reference).toBe('vault:selected');
    expect(args.http.headers.Authorization).toBe('Bearer ${SECRET.access_token}');
    expect(args.http.query.affiliation).toBe('owner,collaborator,organization_member');
  }
});

it('refuses a partial catalog when a later page fails, without substituting a token or retrying', async () => {
  const call = vi.fn().mockResolvedValueOnce({ response: { status: 200, body: Array.from({ length: 100 }, (_, id) => ({
    id: id + 1, full_name: `person/repo-${id}`, default_branch: 'main', private: true,
  })) } }).mockResolvedValueOnce({ response: { status: 401, body: { message: 'Bad credentials' } } });
  await expect(readPersonalGitHubRepositories({ call }, { reference: 'vault:selected', fieldNames: ['value'] })).rejects.toThrow('discovery failed');
  expect(call).toHaveBeenCalledTimes(2);
});

import { expect, it, vi } from 'vitest';
const session = vi.hoisted(() => vi.fn());
const operation = vi.hoisted(() => vi.fn());
vi.mock('@/auth/github-auth-session', () => ({ githubInstallationRedirectUri: () => 'beeline://github-callback' }));
vi.mock('@/auth/github-installation-host', () => ({ runHostGitHubInstallationSession: session }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: operation }));
import { installRepositoryCandidate } from './install-repository-candidate';
const candidate = { key: 'github:42', name: 'organization/project', remote: 'git://github.com/organization/project' };

it('uses the existing installation flow and links only after the returned catalog proves App coverage', async () => {
  operation.mockImplementation(async name => name === 'beginGitHubInstallation' ? { url: 'https://github.com/apps/beeline/installations/new' }
    : { repositories: [{ id: 42, fullName: candidate.name, installationId: 88, defaultBranch: 'trunk', private: true }] });
  session.mockImplementation(async options => {
    expect(await options.startInstallation()).toBe('https://github.com/apps/beeline/installations/new');
    await options.refreshRepositories();
  });
  expect(await installRepositoryCandidate(candidate, '/beeline/channels')).toMatchObject({ githubInstallationId: 88, defaultBranch: 'trunk' });
  expect(operation).toHaveBeenCalledWith('beginGitHubInstallation', { redirectUri: 'beeline://github-callback', selectTarget: true });
  session.mockImplementation(async () => null);
  expect(await installRepositoryCandidate(candidate, '/beeline/channels')).toBeUndefined();
});

it('does not start installation for a repository with verified App coverage', async () => {
  session.mockClear();
  const installed = { ...candidate, githubInstallationId: 88 };
  expect(await installRepositoryCandidate(installed, '/beeline/channels')).toBe(installed);
  expect(session).not.toHaveBeenCalled();
});

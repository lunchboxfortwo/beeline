import { githubInstallationRedirectUri } from '@/auth/github-auth-session';
import { runHostGitHubInstallationSession } from '@/auth/github-installation-host';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import type { GitHubRepositoryListResult } from '@beeline/api-contract/phone';
import type { RepoCandidate } from './room-repo-picker';

/** An account listing proves discovery, while linking still needs App coverage. */
export async function installRepositoryCandidate(
  candidate: RepoCandidate,
  returnPath: string,
  onCatalog?: (catalog: GitHubRepositoryListResult) => void,
): Promise<RepoCandidate | undefined> {
  if (candidate.githubInstallationId || !candidate.key.startsWith('github:')) return candidate;
  let installed: RepoCandidate | undefined;
  await runHostGitHubInstallationSession({
    returnPath,
    startInstallation: async () => (await monolithPhoneOperation('beginGitHubInstallation', {
      redirectUri: githubInstallationRedirectUri(), selectTarget: true,
    })).url,
    refreshRepositories: async () => {
      const catalog = await monolithPhoneOperation('listGitHubRepositories', { refresh: true, includeAccount: true });
      onCatalog?.(catalog);
      const repository = catalog.repositories.find(repository => `github:${repository.id}` === candidate.key && repository.installationId);
      installed = repository ? { ...candidate, name: repository.fullName,
        remote: `git://github.com/${repository.fullName}`, defaultBranch: repository.defaultBranch,
        private: repository.private, githubInstallationId: repository.installationId } : undefined;
    },
    onRefreshPhase: () => undefined,
  });
  return installed;
}

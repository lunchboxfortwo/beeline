import { expect, it } from 'vitest';
import { gitHubAppClientDispatchProductionWorkflow } from './github-installation-url.js';
import { ProductionReleaseBusyError, type GitHubAppClient } from './github.js';

it('answers busy when a production release is already running', async () => {
  const service = {
    readRepositoryJson: async () => ({ workflow_runs: [{ id: 9 }] }),
    request: async () => { throw new Error('dispatch must not start'); },
  };
  await expect(gitHubAppClientDispatchProductionWorkflow(
    { service: service as unknown as GitHubAppClient, config: { apiBaseUrl: 'https://api.github.com' } as never },
    'token', 'owner/repo', { dispatched_by: 'agent' },
  )).rejects.toBeInstanceOf(ProductionReleaseBusyError);
});

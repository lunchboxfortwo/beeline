import type { VaultConnectionMeta } from '@beeline/api-contract/daemon';
import type { SquireMcpClient } from './connector-squire.js';

/** Discovery uses the personal connection. App installation tokens cannot
 * enumerate private repositories outside that App's installations. */
export async function readPersonalGitHubRepositories(
  client: SquireMcpClient,
  connection: Pick<VaultConnectionMeta, 'reference' | 'fieldNames'>,
): Promise<NonNullable<VaultConnectionMeta['githubRepositories']>> {
  const field = connection.fieldNames.includes('access_token') ? 'access_token'
    : connection.fieldNames.length === 1 ? connection.fieldNames[0] : undefined;
  if (!field || !['access_token', 'value', 'token', 'api_key'].includes(field))
    throw new Error('GitHub connection has no API token');
  const repositories = new Map<number, NonNullable<VaultConnectionMeta['githubRepositories']>[number]>();
  for (let page = 1; ; page++) {
    const result = await client.call('use_credential', {
      reference: connection.reference,
      http: {
        method: 'GET', url: 'https://api.github.com/user/repos',
        headers: { Authorization: `Bearer ${'${SECRET.' + field + '}'}`, Accept: 'application/vnd.github+json' },
        query: { affiliation: 'owner,collaborator,organization_member', per_page: '100', page: String(page), sort: 'full_name' },
      },
    }) as { response?: { status?: number; body?: unknown } };
    if (result.response?.status !== 200) throw new Error('GitHub repository discovery failed');
    const body: unknown = typeof result.response.body === 'string' ? JSON.parse(result.response.body) : result.response.body;
    if (!Array.isArray(body)) throw new Error('GitHub repository list is invalid');
    for (const item of body) {
      if (!item || !Number.isSafeInteger(item.id) || item.id <= 0 ||
          typeof item.full_name !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(item.full_name) ||
          typeof item.default_branch !== 'string' || !item.default_branch || typeof item.private !== 'boolean')
        throw new Error('GitHub repository entry is invalid');
      repositories.set(item.id, { id: item.id, fullName: item.full_name, defaultBranch: item.default_branch, private: item.private });
    }
    if (body.length < 100) return [...repositories.values()];
  }
}

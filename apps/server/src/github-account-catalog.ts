import { appConnections } from './app-connections.js';
import { queueOwnerSquireWork } from './squire-machine.js';
import type { VaultConnectionMeta } from '@beeline/api-contract/daemon';
import type { SqlDatabase } from './database.js';

/** Use the same selected personal credential as the existing GitHub app route.
 * Never substitute another token when that connection refuses a read. */
export async function personalGitHubConnection(database: SqlDatabase, ownerId: string) {
  const app = (await database.query(`SELECT 1 FROM workspace_apps
    WHERE owner_identity_id=$1 AND app_key='github' AND transport='squire-api' AND state='active'`, [ownerId])).rowCount;
  if (!app) return undefined;
  const selected = (await appConnections(database, ownerId, 'github')).find(connection => connection.state === 'active');
  if (!selected) return undefined;
  return (await database.query<{
    reference: string; machine_id: string;
    repositories: VaultConnectionMeta['githubRepositories'] | null;
  }>(`SELECT reference,machine_id,connection_metadata->'githubRepositories' repositories
    FROM workspace_connections WHERE owner_identity_id=$1 AND reference=$2 AND state='active'
    ORDER BY created_at,machine_id LIMIT 1`, [ownerId, selected.reference])).rows[0];
}

export async function requestPersonalGitHubCatalog(database: SqlDatabase, ownerId: string) {
  const connection = await personalGitHubConnection(database, ownerId);
  if (connection) await queueOwnerSquireWork(database, ownerId, connection.machine_id, 'github-repositories');
}

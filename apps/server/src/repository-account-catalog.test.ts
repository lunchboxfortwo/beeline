import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import type { VaultConnectionMeta } from '@beeline/api-contract/daemon';
import { readPersonalGitHubRepositories } from '../../body/src/github-account-repositories.js';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { GitHubOperations } from './github-operations.js';
import { applyVaultList } from './workbench.js';
import { squireAssignments } from './squire-machine.js';

const owner = 'a'.repeat(64), other = 'b'.repeat(64), agent = 'c'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111', room = '22222222-2222-4222-8222-222222222222';
const connection: VaultConnectionMeta = { reference: 'vault:selected', service: 'github', label: 'Personal',
  fieldNames: ['value'], allowedHosts: ['api.github.com'], state: 'active', stale: false, createdAt: 1 };
let database: PgliteDatabase;
let phone: PhoneService;
beforeEach(async () => {
  database = await migratedDatabase();
  await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'human','Other'),($3,'agent','Helper')`, [owner, other, agent]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Test')`, [workspace]);
  await database.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner'),($1,$3,'member')`, [workspace, owner, agent]);
  await database.query(`INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,'machine')`, [agent, owner]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'test',$3)`, [room, workspace, owner]);
  await database.query(`INSERT INTO github_installations(installation_id,owner_id,account_login,account_type) VALUES(77,$1,'person','User'),(88,$2,'collaborator','User')`, [owner, other]);
  await database.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES(1,77,'person/repo-0','main'),(3,88,'collaborator/repo-2','main'),(900,77,'person/stale','main')`);
  await database.query(`INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,domain,transport,route,machine_id,state)
    VALUES('33333333-3333-4333-8333-333333333333',$1,$2,'github','GitHub','github.com','squire-api','workbench','machine','active')`, [workspace, owner]);
  await applyVaultList(database, { owner_identity_id: owner, machine_id: 'machine', workspace_id: workspace }, [connection]);
  const github = new GitHubOperations(database, {} as GitHubOAuthClient, {
    installationAccount: async () => ({ id: '42', login: 'person', type: 'User', repositorySelection: 'all' }),
    listRepositories: async () => [{ id: 1, installationId: 77, fullName: 'person/repo-0', defaultBranch: 'main', private: true, allowAutoMerge: false }],
  } as unknown as GitHubAppClient, 'test');
  phone = new PhoneService(database, 'https://test.invalid', github);
});
afterEach(async () => { await database.close(); });

async function reportCatalog() {
  const repos = Array.from({ length: 237 }, (_, index) => ({ id: index + 1,
    full_name: `${['person', 'organization', 'collaborator'][index % 3]}/repo-${index}`, default_branch: 'main', private: true }));
  const call = vi.fn(async (_tool, args) => ({ response: { status: 200,
    body: JSON.stringify(repos.slice((Number(args.http.query.page) - 1) * 100, Number(args.http.query.page) * 100)) } }));
  const repositories = await readPersonalGitHubRepositories({ call }, connection);
  await applyVaultList(database, { owner_identity_id: owner, machine_id: 'machine', workspace_id: workspace }, [{ ...connection, githubRepositories: repositories }]);
  return repositories;
}

it('lists all 237 account repos for stored and refreshed reads, independently of installed owners', async () => {
  const repositories = await reportCatalog();
  const legacy = await phone.execute('listGitHubRepositories', { refresh: false }, owner);
  expect(legacy.repositories).toHaveLength(2);
  expect(legacy.repositories.every(repository => typeof repository.installationId === 'number')).toBe(true);
  const stored = await phone.execute('listGitHubRepositories', { refresh: false, includeAccount: true }, owner);
  expect(stored.repositories.slice(0, 237).map(repo => repo.id)).toEqual(repositories.map(repo => repo.id));
  expect(stored.repositories.at(-1)).toMatchObject({ id: 900, fullName: 'person/stale' });
  expect(stored.repositories[1]).not.toHaveProperty('installationId');
  expect(stored.repositories[2]).toMatchObject({ installationId: 88 });
  const refreshed = await phone.execute('listGitHubRepositories', { refresh: true, includeAccount: true }, owner);
  expect(refreshed.repositories).toEqual(stored.repositories.slice(0, 237));
  expect((await squireAssignments(database, agent))).toEqual([{
    kind: 'sync', connectorId: 'squire:machine', connectorType: 'trusty-squire', githubReference: connection.reference,
  }]);
  // Another person's stored installation is coverage, never an invitation to
  // expose its other private repositories or transfer its ownership.
  expect((await database.query(`SELECT owner_id FROM github_installations WHERE installation_id=88`)).rows[0]?.owner_id).toBe(other);
  expect((await phone.execute('listGitHubRepositories', { refresh: false, includeAccount: true }, other)).repositories).toHaveLength(1);
});

it('preserves the last complete personal catalog across a normal vault report and provider failure', async () => {
  const repositories = await reportCatalog();
  await applyVaultList(database, { owner_identity_id: owner, machine_id: 'machine', workspace_id: workspace }, [connection]);
  expect((await phone.execute('listGitHubRepositories', { refresh: false, includeAccount: true }, owner)).repositories).toHaveLength(repositories.length + 1);
});

it('allows a verified account repository covered by another installation and refuses invented coverage', async () => {
  await reportCatalog();
  await phone.setRepository({ roomId: room, key: 'github:3', name: 'collaborator/repo-2', remote: 'git://github.com/collaborator/repo-2', targetBranch: 'main', githubInstallationId: 88 }, owner);
  await expect(phone.setRepository({ roomId: room, key: 'github:2', name: 'organization/repo-1', remote: 'git://github.com/organization/repo-1', targetBranch: 'main', githubInstallationId: 88 }, owner)).rejects.toThrow('access denied');
  await applyVaultList(database, { owner_identity_id: owner, machine_id: 'machine', workspace_id: workspace }, []);
  await expect(phone.setRepository({ roomId: room, key: 'github:3', name: 'collaborator/repo-2', remote: 'git://github.com/collaborator/repo-2', targetBranch: 'main', githubInstallationId: 88 }, owner)).rejects.toThrow('access denied');
});

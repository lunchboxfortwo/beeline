import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { GitHubOperations } from './github-operations.js';
import { PhoneService } from './phone-service.js';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';

const viewer = 'a'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const rooms = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const oldName = 'bananaman614305/milo';
const newName = 'bananaman614305/grunt';
describe('repository picker rename refresh', () => {
  let database: PgliteDatabase;
  beforeEach(async () => {
    database = await migratedDatabase();
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`, [viewer]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Test')`, [workspace]);
    await database.query(`INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
      VALUES(156013969,$1,'42','bananaman614305','User','selected','active')`, [viewer]);
    await database.query(`INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
      VALUES(1373962491,156013969,$1,'main')`, [oldName]);
    await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name,repository_key,repository_name,repository_remote,github_installation_id)
      SELECT id,$2,$3,'Milo','github:1373962491',$4,'git://github.com/' || $4,156013969 FROM unnest($1::uuid[]) id`,
    [rooms, workspace, viewer, oldName]);
  });
  afterEach(async () => { await database.close(); });
  function fixture(fail = false) {
    const app = {
      installationAccount: vi.fn(async () => ({ id: '42', login: 'bananaman614305', type: 'User', repositorySelection: 'selected' })),
      listRepositories: vi.fn(async () => {
        if (fail) throw new Error('GitHub unavailable');
        return [{ id: 1373962491, installationId: 156013969, fullName: newName, defaultBranch: 'main', private: false, allowAutoMerge: false }];
      }),
    };
    const github = new GitHubOperations(database, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'test');
    return { app, github, phone: new PhoneService(database, 'https://test.invalid', github) };
  }
  it('opening refreshes the catalog and every chat bound by id, then the webhook matcher accepts the renamed PR', async () => {
    const { phone, github, app } = fixture();
    const event = { action: 'opened', repository: { full_name: newName }, sender: { login: 'owner' },
      pull_request: { title: 'Rename proof', html_url: `https://github.com/${newName}/pull/1` } };
    await github.processRepositoryEvent('pull_request', event, 156013969);
    expect((await database.query(`SELECT id FROM messages WHERE card_type='github-event'`)).rowCount).toBe(0);
    const result = await phone.execute('listGitHubRepositories', {}, viewer);
    expect(result.repositories).toMatchObject([{ id: 1373962491, fullName: newName }]);
    expect(app.listRepositories).toHaveBeenCalledOnce();
    expect((await database.query(`SELECT repository_name,repository_remote FROM rooms ORDER BY id`)).rows).toEqual(
      rooms.map(() => ({ repository_name: newName, repository_remote: `git://github.com/${newName}` })));
    await github.processRepositoryEvent('pull_request', event, 156013969);
    expect((await database.query(`SELECT room_id FROM messages WHERE card->>'url'=$1 ORDER BY room_id`,
      [`https://github.com/${newName}/pull/1`])).rows).toEqual(rooms.map(room_id => ({ room_id })));
  });
  it('keeps catalog and chat names together when a chat update fails', async () => {
    const { phone } = fixture();
    await database.query(`CREATE FUNCTION refuse_rename() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'rename refused'; END $$;
      CREATE TRIGGER refuse_rename BEFORE UPDATE OF repository_remote ON rooms FOR EACH ROW EXECUTE FUNCTION refuse_rename()`);
    const result = await phone.execute('listGitHubRepositories', { refresh: true }, viewer);
    expect(result.repositories[0]?.fullName).toBe(oldName);
    expect((await database.query(`SELECT repository_name FROM rooms`)).rows).toEqual(rooms.map(() => ({ repository_name: oldName })));
  });
  it('matches a PR under the new name through the same repository matcher used by webhooks', async () => {
    const { phone, github } = fixture();
    await phone.execute('listGitHubRepositories', {}, viewer);
    const url = `https://github.com/${newName}/pull/2`;
    await github.processRepositoryEvent('pull_request', { action: 'opened', repository: { full_name: newName }, sender: { login: 'owner' },
      pull_request: { title: 'Renamed repository PR', html_url: url } }, 156013969);
    expect((await database.query(`SELECT room_id FROM messages WHERE card->>'url'=$1 ORDER BY room_id`, [url])).rows)
      .toEqual(rooms.map(room_id => ({ room_id })));
  });
  it('returns the latest stored catalog without contacting GitHub for the immediate read', async () => {
    const { phone, app } = fixture();
    const result = await phone.execute('listGitHubRepositories', { refresh: false }, viewer);
    expect(result.repositories[0]?.fullName).toBe(oldName);
    expect(app.listRepositories).not.toHaveBeenCalled();
  });
  it('returns the cached list without new error text when GitHub fails on opening', async () => {
    const { phone, app } = fixture(true);
    const cached = await phone.execute('listGitHubRepositories', { refresh: false }, viewer);
    expect(await phone.execute('listGitHubRepositories', { refresh: true }, viewer)).toEqual(cached);
    expect(app.listRepositories).toHaveBeenCalledOnce();
  });
});

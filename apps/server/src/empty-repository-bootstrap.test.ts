import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
import { GitHubOperations } from './github-operations.js';
import { PhoneService } from './phone-service.js';
import { postRepositoryOnboarding } from './repository-onboarding.js';

let db: PgliteDatabase;
const OWNER = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const HEAD_SHA = 'c'.repeat(40);

beforeEach(async () => {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Owner','owner'),($2,'agent','Crayon','crayon')`, [OWNER, AGENT]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Beeline')`, [WORKSPACE]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'wargame',$3)`, [ROOM, WORKSPACE, OWNER]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, OWNER]);
  for (const id of [OWNER, AGENT]) {
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner')`,
      [WORKSPACE, id, ROOM],
    );
  }
  await db.query(
    `INSERT INTO github_installations(installation_id,owner_id,account_login,account_type,repository_selection,status)
     VALUES(77,$1,'owner','User','all','active')`,
    [OWNER],
  );
  await db.query(
    `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch,active)
     VALUES(42,77,'owner/wargame','main',true)`,
  );
});

afterEach(async () => {
  await db.close();
});

function makeGitHub() {
  const oauth = new GitHubOAuthClient({ clientId: 'id', clientSecret: 'secret' });
  const app = new GitHubAppClient({ appId: '1', slug: 'beeline-test', privateKey: 'unused' });
  const installationToken = vi.spyOn(app, 'installationToken').mockResolvedValue({
    token: 'inst-token',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const bootstrapEmptyRepository = vi.spyOn(app, 'bootstrapEmptyRepository').mockResolvedValue({
    status: 'bootstrapped',
    headSha: HEAD_SHA,
  });
  const github = new GitHubOperations(db, oauth, app, 'secret');
  return { app, github, installationToken, bootstrapEmptyRepository };
}

it('bootstraps an empty linked repository after setRoomRepository commits', async () => {
  const { github, installationToken, bootstrapEmptyRepository } = makeGitHub();
  const phone = new PhoneService(db, 'https://server.test', github);
  const linked = await phone.execute(
    'setRoomRepository',
    {
      roomId: ROOM,
      key: 'github:42',
      name: 'owner/wargame',
      remote: 'git://github.com/owner/wargame',
      targetBranch: 'main',
      githubInstallationId: 77,
    },
    OWNER,
  );
  expect(linked.binding.name).toBe('owner/wargame');
  expect(installationToken).toHaveBeenCalledWith(77, {
    repositoryIds: [42],
    permissions: { contents: 'write' },
  });
  expect(bootstrapEmptyRepository).toHaveBeenCalledWith('inst-token', 'owner/wargame', 'main');
});

it('bootstraps an empty repository when creating a room linked to it', async () => {
  const { github, bootstrapEmptyRepository } = makeGitHub();
  const phone = new PhoneService(db, 'https://server.test', github);
  const created = await phone.execute(
    'createRoom',
    { workspaceId: WORKSPACE, name: 'fresh-repo', repositoryId: 42 },
    OWNER,
  );
  expect(created.id).toBeTruthy();
  expect(bootstrapEmptyRepository).toHaveBeenCalledWith('inst-token', 'owner/wargame', 'main');
});

it('bootstraps an empty repository after onboarding card link commits and settles the card', async () => {
  const { github } = makeGitHub();
  const bootstrapped: string[] = [];
  vi.spyOn(github, 'bootstrapEmptyRoomRepository').mockImplementation(async (roomId) => {
    // Confirm the room binding is already committed and visible outside the transaction.
    const row = (await db.query<{ repository_name: string | null }>(`SELECT repository_name FROM rooms WHERE id=$1`, [roomId])).rows[0];
    expect(row?.repository_name).toBe('owner/wargame');
    bootstrapped.push(roomId);
    return { status: 'bootstrapped', headSha: HEAD_SHA };
  });
  const phone = new PhoneService(db, 'https://server.test', github);
  const card = await postRepositoryOnboarding(db, github, {
    roomId: ROOM,
    agentId: AGENT,
    requesterId: OWNER,
    kind: 'repository',
  });
  await phone.execute('actOnRepositoryCard', { roomId: ROOM, cardId: card.id, action: 'link', repositoryId: 42 }, OWNER);
  expect(bootstrapped).toEqual([ROOM]);
  const settled = (await phone.readRoom(ROOM, OWNER))?.messages.find(message => message.id === card.id)?.onboarding;
  expect(settled).toMatchObject({ status: 'settled', resolution: 'linked', repository: 'owner/wargame' });
});

it('keeps the room repository binding when bootstrap fails transiently', async () => {
  const { github, bootstrapEmptyRepository } = makeGitHub();
  bootstrapEmptyRepository.mockRejectedValueOnce(new Error('GitHub 502'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const phone = new PhoneService(db, 'https://server.test', github);
  const linked = await phone.execute(
    'setRoomRepository',
    {
      roomId: ROOM,
      key: 'github:42',
      name: 'owner/wargame',
      remote: 'git://github.com/owner/wargame',
      targetBranch: 'main',
      githubInstallationId: 77,
    },
    OWNER,
  );
  expect(linked.binding.name).toBe('owner/wargame');
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { repositoryMarkColumnsSql } from './repository-mark.js';
import { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { LiveHub } from './live.js';
import { DaemonService } from './daemon-service.js';
import { GitHubOperations } from './github-operations.js';
import { createPhoneOperationDispatcher } from './phone-operations.js';
import type { ServerOptions } from './server.js';
import type { TokenAuth } from './auth.js';
const homepageIcon = vi.hoisted(() => vi.fn());
vi.mock('./company-logos.js', async original => ({ ...await original<typeof import('./company-logos.js')>(), resolveHomepageIcon: homepageIcon }));
let db: PgliteDatabase;
afterEach(async () => { homepageIcon.mockReset(); await db?.close(); });

const owner = 'a'.repeat(64), workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222', thread = '33333333-3333-4333-8333-333333333333';
const square = (background: string) => sharp({ create: { width: 180, height: 180, channels: 4, background } }).png().toBuffer();

async function linkedRepository() {
  db = await migratedDatabase();
  await db.query("INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')", [owner]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Workspace')", [workspace]);
  await db.query("INSERT INTO github_installations(installation_id,owner_id,account_login,account_type,account_avatar_url) VALUES(77,$1,'owner','Organization','https://avatars.githubusercontent.com/u/42')", [owner]);
  await db.query("INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch,homepage) VALUES(99,77,'owner/repo','main','https://homepage.example')");
  await db.query(`INSERT INTO rooms(id,workspace_id,name,repository_key,repository_name,repository_remote,repository_resolution,github_installation_id)
    VALUES($1,$2,'Repo chat','github:99','owner/repo','git://github.com/owner/repo','repository',77)`, [room, workspace]);
  await db.query("INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Thread')", [thread, workspace, room]);
  await db.query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'member')", [workspace, room, owner]);
  // A fake GitHub App: one repository whose committed icon is `files[path]`.
  const files: Record<string, Buffer> = { 'public/favicon.png': await square('#123456') };
  const app = {
    installationToken: vi.fn(async () => ({ token: 'installation-token', expiresAt: new Date(Date.now() + 3_600_000).toISOString() })),
    issuesRequest: vi.fn(async (_token: string, _name: string, _method: string, path: string) => {
      const paths = Object.keys(files);
      if (path.startsWith('git/trees/')) return { tree: paths.map((file, index) => ({ path: file, type: 'blob', sha: `sha${index}` })) };
      return { content: files[paths[Number(path.slice('git/blobs/sha'.length))]!]!.toString('base64') };
    }),
  };
  const changed: string[] = [];
  const github = new GitHubOperations(db, {} as GitHubOAuthClient, app as unknown as GitHubAppClient, 'secret', undefined, id => changed.push(id));
  const service = new PhoneService(db, 'https://beeline.example');
  const reads = async () => [(await service.readRoom(room, owner))?.room, (await service.readRoom(thread, owner))?.room,
    (await service.readChats(workspace, owner))?.chats.find(item => item.room.id === room)?.room,
    (await service.readCorners(room, owner))?.corners.find(item => item.corner.id === thread)?.corner];
  return { files, app, github, changed, service, reads };
}

it('stores the icon once at link time; list loads and the endpoint read only the database', async () => {
  const { app, github, changed, service, reads } = await linkedRepository();
  // Not resolved yet: no picture, so the chat shows #.
  for (const read of await reads()) expect(read?.homepageIcon).toBeUndefined();
  await github.resolveRepositoryIcons();
  expect(app.issuesRequest.mock.calls.map(call => call[3])).toEqual(['git/trees/main?recursive=1', 'git/blobs/sha0']);
  expect(changed).toEqual([room]);
  const stored = (await db.query<{ icon_hash: string; icon_png: Uint8Array }>('SELECT icon_hash,icon_png FROM repository_icons WHERE repository_id=99')).rows[0]!;
  expect(stored.icon_hash).toBe(createHash('sha256').update(Buffer.from(stored.icon_png)).digest('hex'));
  // Resolved repositories are skipped: a second link or a restart's backfill reads nothing.
  await github.resolveRepositoryIcons();
  expect(app.issuesRequest).toHaveBeenCalledTimes(2);
  app.issuesRequest.mockClear(); app.installationToken.mockClear();

  const url = `https://beeline.example/v1/repository-icons/${room}/${stored.icon_hash}`;
  // The one chat picture: list rows, the chat page and thread headers all carry this URL and nothing else.
  for (const read of await reads()) { expect(read).toMatchObject({ homepageIcon: url }); expect(read).not.toHaveProperty('avatar'); expect(read).not.toHaveProperty('favicon'); }
  expect(homepageIcon).not.toHaveBeenCalled();
  const live = new LiveHub();
  const server = createBeelineServer({ database: db, phone: service, live, auth: {} as TokenAuth, daemon: new DaemonService(db, live), mediaMaximumBytes: 1, github: {} });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const icon = await fetch(`${origin}/v1/repository-icons/${room}/${stored.icon_hash}?size=108`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(Buffer.from(await icon.arrayBuffer()).equals(Buffer.from(stored.icon_png))).toBe(true);
    expect((await fetch(`${origin}/v1/repository-icons/${room}/${'0'.repeat(64)}`)).status).toBe(404);
    expect((await fetch(`${origin}/v1/repository-icons/${thread}/${stored.icon_hash}`)).status).toBe(404);
    expect((await fetch(`${origin}/v1/repository-icons/${room}`)).status).toBe(404);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  // Every list load, room read and icon fetch above made zero GitHub calls.
  expect(app.issuesRequest).not.toHaveBeenCalled();
  expect(app.installationToken).not.toHaveBeenCalled();

  await db.query('DELETE FROM github_repositories');
  const fallback = (await db.query(`SELECT ${repositoryMarkColumnsSql('room')} FROM rooms room WHERE id=$1`, [thread])).rows[0];
  expect(fallback).toEqual({ repository_icon: null });
});

it('re-resolves only on a default-branch push that touches an icon path', async () => {
  const { files, app, github, reads } = await linkedRepository();
  await github.resolveRepositoryIcons();
  const before = (await reads())[2]?.homepageIcon;
  app.issuesRequest.mockClear();
  files['public/favicon.png'] = await square('#654321');
  const push = (ref: string, commits: unknown[]) => github.processWebhook('push', {
    installation: { id: 77 }, repository: { id: 99, full_name: 'owner/repo' }, ref, before: '1'.repeat(40), after: '2'.repeat(40), commits });
  const iconCalls = () => app.issuesRequest.mock.calls.filter(call => String(call[3]).startsWith('git/'));
  await push('refs/heads/main', [{ added: ['src/index.ts'], modified: ['README.md'], removed: [] }]);
  await push('refs/heads/feature', [{ added: [], modified: ['public/favicon.png'], removed: [] }]);
  expect(iconCalls()).toHaveLength(0);
  expect((await reads())[2]?.homepageIcon).toBe(before);

  await push('refs/heads/main', [{ added: [], modified: ['README.md'], removed: [] }, { added: [], modified: ['public/favicon.png'], removed: [] }]);
  expect(iconCalls().map(call => call[3])).toEqual(['git/trees/main?recursive=1', 'git/blobs/sha0']);
  const after = (await reads())[2]?.homepageIcon;
  expect(after).toMatch(/^https:\/\/beeline\.example\/v1\/repository-icons\/2{8}-.+\/[0-9a-f]{64}$/);
  expect(after).not.toBe(before);

  // A custom <link> target re-resolves by its stored path even though its name is not an icon name.
  delete files['public/favicon.png'];
  files['index.html'] = Buffer.from('<link rel="icon" href="/brand/mark.png">');
  files['public/brand/mark.png'] = await square('#123456');
  await push('refs/heads/main', [{ added: ['index.html', 'public/brand/mark.png'], modified: [], removed: ['public/favicon.png'] }]);
  const branded = (await reads())[2]?.homepageIcon;
  expect(branded).not.toBe(after);
  app.issuesRequest.mockClear();
  files['public/brand/mark.png'] = await square('#abcdef');
  await push('refs/heads/main', [{ added: [], modified: ['public/brand/mark.png'], removed: [] }]);
  expect(iconCalls()).toHaveLength(3);
  expect((await reads())[2]?.homepageIcon).not.toBe(branded);

  // Removing the icon files stores none: the chat goes back to #.
  delete files['index.html']; delete files['public/brand/mark.png'];
  await push('refs/heads/main', [{ added: [], modified: [], removed: ['index.html', 'public/brand/mark.png'] }]);
  expect((await reads())[2]?.homepageIcon).toBeUndefined();
});

it('linking a chat to a repository resolves its icon after the write commits', async () => {
  const { app, github, service, reads } = await linkedRepository();
  const resolve = vi.fn(() => github.resolveRepositoryIcons());
  const dispatch = createPhoneOperationDispatcher({ database: db, phone: service, live: new LiveHub(),
    github: { resolveRepositoryIcons: resolve } } as unknown as ServerOptions);
  await dispatch('setRoomRepository', { roomId: room, key: 'github:99', name: 'owner/repo', remote: 'git://github.com/owner/repo',
    targetBranch: 'main', githubInstallationId: 77 }, owner);
  expect(resolve).toHaveBeenCalledTimes(1);
  await vi.waitFor(async () => expect((await reads())[2]?.homepageIcon).toMatch(/\/v1\/repository-icons\/.+\/[0-9a-f]{64}$/));
  expect(app.issuesRequest).toHaveBeenCalledTimes(2);
});

it('falls back to the homepage site icon when the repository commits none, stored the same way', async () => {
  const { files, app, github, reads } = await linkedRepository();
  delete files['public/favicon.png'];
  const png = await square('#0a0b0c');
  homepageIcon.mockResolvedValue({ image: { bytes: png, mime: 'image/png' }, path: 'https://homepage.example/' });
  await github.resolveRepositoryIcons();
  expect(homepageIcon.mock.calls).toEqual([['https://homepage.example']]);
  const stored = (await db.query<{ icon_path: string; icon_hash: string }>('SELECT icon_path,icon_hash FROM repository_icons WHERE repository_id=99')).rows[0]!;
  expect(stored).toEqual({ icon_path: 'https://homepage.example/', icon_hash: createHash('sha256').update(png).digest('hex') });
  for (const read of await reads()) expect(read?.homepageIcon).toBe(`https://beeline.example/v1/repository-icons/${room}/${stored.icon_hash}`);
  // Stored once: later backfills and reads touch neither GitHub nor the site.
  app.issuesRequest.mockClear(); homepageIcon.mockClear();
  await github.resolveRepositoryIcons(); await reads();
  expect(app.issuesRequest).not.toHaveBeenCalled();
  expect(homepageIcon).not.toHaveBeenCalled();
});

it('re-resolves rows stored by an older resolver once', async () => {
  const { app, github, changed } = await linkedRepository();
  await db.query("INSERT INTO repository_icons(repository_id,icon_path,icon_hash,icon_png) VALUES(99,'public/favicon.png',$1,$2)", ['0'.repeat(64), Buffer.from('old')]);
  await github.resolveRepositoryIcons();
  expect(app.issuesRequest).toHaveBeenCalledTimes(2);
  expect(changed).toEqual([room]);
  expect((await db.query<{ resolver_revision: number; icon_hash: string }>('SELECT resolver_revision,icon_hash FROM repository_icons')).rows[0])
    .toMatchObject({ resolver_revision: 2, icon_hash: expect.not.stringMatching(/^0+$/) });
  await github.resolveRepositoryIcons();
  expect(app.issuesRequest).toHaveBeenCalledTimes(2);
});

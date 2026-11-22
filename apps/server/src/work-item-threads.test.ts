import { startQueuedCommand } from './test-fixtures/queued-turn.test-support.js';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';
import { GitHubOperations } from './github-operations.js';
import { LiveHub } from './live.js';
import { updateWorkItem } from './work-board.js';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';

/**
 * Reproduction R1 stand-in: a backlog task moves to In progress when a thread
 * opens to build it, Done when that thread lands, and back to Backlog when it
 * closes unmerged. Merges drive the real GitHub `pull_request` closed webhook.
 */

const H = 'a'.repeat(64),
  A = 'b'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111',
  R = '22222222-2222-4222-8222-222222222222',
  OTHER = '33333333-3333-4333-8333-333333333333';
let db: PgliteDatabase, phone: PhoneService, daemon: DaemonService, github: GitHubOperations;
let pr = 0;

beforeAll(async () => {
  db = await migratedDatabase();
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Human','human'),($2,'agent','Ruby','ruby')`,
    [H, A],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [A, H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Board')`, [W]);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,repository_key,repository_remote,repository_resolution,
       repository_target_branch,github_installation_id)
     VALUES($1,$2,'Widgets','owner/widgets','https://github.com/owner/widgets.git','repository','main',77),
       ($3,$2,'Other',NULL,NULL,'none','main',NULL)`,
    [R, W, OTHER],
  );
  await db.query(
    `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
     VALUES(77,$1,'42','owner','User','selected','active')`,
    [H],
  );
  await db.query(
    `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
     VALUES(101,77,'owner/widgets','main')`,
  );
  for (const who of [H, A])
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'owner'),($1,$3,$2,'owner'),($1,$4,$2,'owner')`,
      [W, who, R, OTHER],
    );
  phone = new PhoneService(db, 'http://test');
  daemon = new DaemonService(db, new LiveHub());
  github = new GitHubOperations(
    db,
    {} as unknown as GitHubOAuthClient,
    { deleteBranch: vi.fn(async () => undefined) } as unknown as GitHubAppClient,
    'secret',
  );
}, 30_000);
afterAll(async () => db?.close());

async function task(title: string, roomId = R) {
  const id = randomBytes(32).toString('hex');
  await updateWorkItem(db, { roomId, id, title, state: 'backlog' }, A);
  return id;
}

async function open(workItems: string[]) {
  await phone.execute(
    'sendRoomMessage',
    { roomId: R, messageId: randomBytes(32).toString('hex'), text: '@ruby please build this' },
    H,
  );
  const command = (await daemon.execute('getAgentCommands', { roomId: R }, A)).commands.at(-1)!;
  await startQueuedCommand(daemon, { roomId: R, commandId: command.id }, A);
  pr += 1;
  return daemon.execute(
    'createCorner',
    {
      roomId: R, requestId: command.turnRequestId, name: `Build-${pr}`, objective: 'Build the task',
      repository: 'owner/widgets', targetBranch: 'main', workItems,
      brief: { spec: 'Build the task', approval: { sourceMessageId: command.sourceMessageId } },
    },
    A,
  );
}

async function merge(cornerId: string) {
  const branch = `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`;
  const number = 100 + pr;
  const url = `https://github.com/owner/widgets/pull/${number}`;
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
    cornerId,
    JSON.stringify({ lifecycle: 'in-review', checks: 'passing',
      pr: { number, url, headSha: '9'.repeat(40), targetBranch: 'main' } }),
  ]);
  await github.processWebhook('pull_request', {
    installation: { id: 77 },
    repository: { id: 101, full_name: 'owner/widgets' },
    action: 'closed',
    pull_request: {
      number, title: 'Build the task', html_url: url,
      head: { ref: branch, sha: '9'.repeat(40) }, base: { ref: 'main' },
      merged: true, merged_at: '2026-11-22T20:03:00Z', merge_commit_sha: 'f'.repeat(40),
      commits: 1, changed_files: 1,
    },
    sender: { login: 'octocat' },
  });
}

async function state(id: string) {
  return (await db.query<{ state: string; completed: boolean }>(
    `SELECT state,completed_at IS NOT NULL completed FROM work_items WHERE id=$1`, [id])).rows[0];
}

async function events(id: string) {
  return (await db.query<{ text: string }>(
    `SELECT text FROM work_item_entries WHERE work_item_id=$1 AND kind='event' ORDER BY created_at,id`, [id],
  )).rows.map(row => row.text);
}

it('opening a thread for a backlog task moves it to in progress with a thread link; landing moves it to done', async () => {
  const id = await task('`npx usebeeline update` hangs with no output');
  const created = await open([id]);
  expect(await state(id)).toEqual({ state: 'in-progress', completed: false });
  const links = (await db.query(
    `SELECT kind,name,url FROM work_item_attachments WHERE work_item_id=$1`, [id])).rows;
  expect(links).toEqual([{ kind: 'link', name: `Thread: Build-${pr}`,
    url: `https://web.usebeeline.app/beeline/chat/${created.cornerId}?communityId=${W}` }]);
  await merge(created.cornerId);
  expect(await state(id)).toEqual({ state: 'done', completed: true });
  expect(await events(id)).toEqual([
    'created this item in Backlog', 'moved this to In progress', 'moved this to Done',
  ]);
}, 30_000);

it('closing the thread without merging returns its task to backlog', async () => {
  const id = await task('/login card hangs');
  const created = await open([id]);
  expect((await state(id))!.state).toBe('in-progress');
  await daemon.execute('archiveCorner', { cornerId: created.cornerId }, A);
  expect(await state(id)).toEqual({ state: 'backlog', completed: false });
}, 30_000);

it('a task linked to two threads is done only when the last open one closes', async () => {
  const id = await task('Shared task');
  const first = await open([id]);
  const second = await open([id]);
  await merge(first.cornerId);
  expect((await state(id))!.state).toBe('in-progress');
  await daemon.execute('archiveCorner', { cornerId: second.cornerId }, A);
  // One linked thread landed, so the task is done.
  expect((await state(id))!.state).toBe('done');
}, 30_000);

it('refuses ids that are not tasks in the parent chat, and opens nothing', async () => {
  const elsewhere = await task('Other chat task', OTHER);
  const threads = async () => (await db.query(`SELECT 1 FROM rooms WHERE parent_id=$1`, [R])).rowCount;
  const before = await threads();
  await expect(open([elsewhere])).rejects.toThrow(/workItems must be task ids in the thread's parent chat/);
  await expect(open(['missing'])).rejects.toThrow(/missing/);
  expect(await threads()).toBe(before);
  expect((await state(elsewhere))!.state).toBe('backlog');
}, 30_000);

import { startQueuedCommand } from './test-fixtures/queued-turn.test-support.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';
import { GitHubOperations } from './github-operations.js';
import { LiveHub } from './live.js';
import { readWorkBoard, updateWorkItem } from './work-board.js';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';

/**
 * In-place backlog-to-thread promotion: passing a single backlog task UUID to
 * `open_thread` promotes that exact UUID and normalized 3-word hyphenated name
 * into its thread without writing a duplicate `work_item_threads` row.
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

async function task(title: string, roomId = R, note?: string) {
  const id = randomUUID();
  await updateWorkItem(db, { roomId, id, title, state: 'backlog', ...(note ? { note } : {}) }, A);
  return id;
}

async function open(workItems: string[] | undefined, retry?: (string[] | undefined)[]) {
  await phone.execute(
    'sendRoomMessage',
    { roomId: R, messageId: randomBytes(32).toString('hex'), text: '@ruby please build this' },
    H,
  );
  const command = (await daemon.execute('getAgentCommands', { roomId: R }, A)).commands.at(-1)!;
  await startQueuedCommand(daemon, { roomId: R, commandId: command.id }, A);
  pr += 1;
  const create = (items: string[] | undefined) =>
    daemon.execute(
      'createCorner',
      {
        roomId: R,
        requestId: command.turnRequestId,
        idempotencyKey: `open-${pr}`,
        name: `Build-${pr}`,
        objective: 'Build the task',
        repository: 'owner/widgets',
        targetBranch: 'main',
        ...(items ? { workItems: items } : {}),
        brief: { spec: 'Build the task', approval: { sourceMessageId: command.sourceMessageId } },
      },
      A,
    );
  const created = await create(workItems);
  const retries = [];
  for (const items of retry ?? [])
    retries.push(await create(items).then((value) => value, (error: Error) => error));
  return Object.assign(created, { retries });
}

async function merge(cornerId: string) {
  const branch = `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`;
  const number = 100 + pr;
  const url = `https://github.com/owner/widgets/pull/${number}`;
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
    cornerId,
    JSON.stringify({
      lifecycle: 'in-review',
      checks: 'passing',
      pr: { number, url, headSha: '9'.repeat(40), targetBranch: 'main' },
    }),
  ]);
  await github.processWebhook('pull_request', {
    installation: { id: 77 },
    repository: { id: 101, full_name: 'owner/widgets' },
    action: 'closed',
    pull_request: {
      number,
      title: 'Build the task',
      html_url: url,
      head: { ref: branch, sha: '9'.repeat(40) },
      base: { ref: 'main' },
      merged: true,
      merged_at: '2026-11-22T20:03:00Z',
      merge_commit_sha: 'f'.repeat(40),
      commits: 1,
      changed_files: 1,
    },
    sender: { login: 'octocat' },
  });
}

it('promotes a backlog task UUID in-place without work_item_threads duplicates, and landing marks it done', async () => {
  const id = await task('fix update hangs with no output', R, 'Keep spinner quiet');
  const created = await open([id]);
  expect(created.cornerId).toBe(id);
  expect(created.name).toBe('fix-update-hangs');
  expect((await db.query(`SELECT 1 FROM work_item_threads`)).rowCount).toBe(0);
  const board = await readWorkBoard(db, W, H);
  const rows = board.items.filter((item) => item.id === id || item.title === 'fix-update-hangs');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id, roomId: id, title: 'fix-update-hangs', state: 'in-progress' });
  expect(rows[0]!.entries?.some((entry) => entry.kind === 'note' && entry.text === 'Keep spinner quiet')).toBe(true);
  await merge(created.cornerId);
  const landed = (await readWorkBoard(db, W, H)).items.filter((item) => item.id === id);
  expect(landed).toHaveLength(1);
  expect(landed[0]).toMatchObject({ id, title: 'fix-update-hangs', state: 'done', roomArchived: true });
}, 30_000);

it('preserves a human backlog assignee while recording a separate agent implementer on open_thread promotion', async () => {
  const id = randomUUID();
  await updateWorkItem(db, { roomId: R, id, title: 'keep human assignee', state: 'backlog', assigneeId: H }, H);
  const created = await open([id]);
  expect(created.cornerId).toBe(id);

  const boardItem = (await readWorkBoard(db, W, H)).items.find((item) => item.id === id);
  expect(boardItem?.assignee?.pubkey).toBe(H);
  const storedWork = (await db.query<{ assignee_id: string | null }>('SELECT assignee_id FROM work_items WHERE id=$1', [id])).rows[0];
  expect(storedWork?.assignee_id).toBe(H);
  const storedFact = (await db.query<{ implementer_agent_id: string | null }>('SELECT implementer_agent_id FROM corner_facts WHERE corner_id=$1', [id])).rows[0];
  expect(storedFact?.implementer_agent_id).toBe(A);

  // Legacy non-UUID backlog task promoted to a new thread UUID also preserves its stored human assignee.
  await db.query(
    `INSERT INTO work_items(id,room_id,state,title,assignee_id,opened_by) VALUES('legacy-human-owned',$1,'backlog','legacy-owned',$2,$2)`,
    [R, H],
  );
  const promotedLegacy = await open(['legacy-human-owned']);
  expect(promotedLegacy.cornerId).not.toBe('legacy-human-owned');
  const legacyWork = (await db.query<{ assignee_id: string | null }>('SELECT assignee_id FROM work_items WHERE id=$1', [promotedLegacy.cornerId])).rows[0];
  expect(legacyWork?.assignee_id).toBe(H);
  const legacyFact = (await db.query<{ implementer_agent_id: string | null }>('SELECT implementer_agent_id FROM corner_facts WHERE corner_id=$1', [promotedLegacy.cornerId])).rows[0];
  expect(legacyFact?.implementer_agent_id).toBe(A);
}, 30_000);

it('moves a promoted thread back to backlog via updateWorkItem and closes via archiveCorner', async () => {
  const id = await task('login card hangs');
  const created = await open([id]);
  expect(created.cornerId).toBe(id);
  await updateWorkItem(db, { roomId: id, state: 'backlog' }, H);
  expect((await readWorkBoard(db, W, H)).items.find((item) => item.id === id)?.state).toBe('backlog');
  await daemon.execute('archiveCorner', { cornerId: id }, A);
  expect((await readWorkBoard(db, W, H)).items.find((item) => item.id === id)?.state).toBe('done');
}, 30_000);

it('refuses a second open against an already-promoted task UUID or more than one task id', async () => {
  const a = await task('first task');
  const b = await task('second task');
  await expect(open([a, b])).rejects.toThrow(/at most one backlog task/);
  const promoted = await open([a]);
  expect(promoted.cornerId).toBe(a);
  await expect(open([a])).rejects.toThrow(/workItems must be task ids in the thread's parent chat/);
}, 30_000);

it('refuses ids that are not tasks in the parent chat, and opens nothing', async () => {
  const elsewhere = await task('Other chat task', OTHER);
  const threads = async () => (await db.query(`SELECT 1 FROM rooms WHERE parent_id=$1`, [R])).rowCount;
  const before = await threads();
  await expect(open([elsewhere])).rejects.toThrow(/workItems must be task ids in the thread's parent chat/);
  await expect(open(['missing'])).rejects.toThrow(/missing/);
  expect(await threads()).toBe(before);
}, 30_000);

it('a retry of the same opening must name the same task', async () => {
  const a = await task('Retry A');
  const c = await task('Retry C');
  const same = await open([a], [[a, a]]);
  expect(same.cornerId).toBe(a);
  expect(same.retries[0]).toMatchObject({ cornerId: a });
  const changed = await open([c], [[randomUUID()]]);
  const added = await open(undefined, [[randomUUID()]]);
  for (const retry of [changed.retries[0], added.retries[0]])
    expect(String(retry)).toMatch(/thread assignment conflict.*work items/);
  expect((await db.query(`SELECT 1 FROM work_item_threads`)).rowCount).toBe(0);
}, 30_000);

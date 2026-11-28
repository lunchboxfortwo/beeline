import { createHash, randomUUID } from 'node:crypto';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerQueuedMessage, readAgentCommands } from './agent-command.js';
import { sendMessage } from './agent-messaging.js';
import { notifyCommanderCornerClosed } from './commander.js';
import { closeInactiveCorners } from './corner-auto-close.js';
import { archiveCornerState, closeCornerState } from './corner-close.js';
import { recordCornerGithubFact, setCornerLockedFact } from './corner-lifecycle.js';
import { DaemonService } from './daemon-service.js';
import { GitHubOperations } from './github-operations.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';

const H = '1'.repeat(64);
const CMD = '2'.repeat(64);
const WORKER = '3'.repeat(64);
const OTHER = '4'.repeat(64);
const WS = '11111111-1111-4111-8111-111111111111';
const CHAT = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(40);
const MERGE_SHA = 'b'.repeat(40);
const NO_MESSAGE_DIRECTIVE =
  'Do not print any message in this turn if you have no pending work on this basis; end silently.';

let db: PgliteDatabase;
let daemon: DaemonService;
let phone: PhoneService;
let github: GitHubOperations;
let githubApp: {
  closePullRequest: ReturnType<typeof vi.fn>;
  deleteBranch: ReturnType<typeof vi.fn>;
  installationToken: ReturnType<typeof vi.fn>;
  branchDeletionSafety: ReturnType<typeof vi.fn>;
  openPullRequestsForBranch: ReturnType<typeof vi.fn>;
};

async function seedWorld() {
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Beeline')`, [WS]);
  await db.query(`INSERT INTO institutional_memory_workspace_rollouts(workspace_id,stage) VALUES($1,'live')`, [WS]);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Captain','captain'),
       ($2,'agent','Commander','commander'),
       ($3,'agent','Worker','worker'),
       ($4,'agent','Other','other')`,
    [H, CMD, WORKER, OTHER],
  );
  await db.query(
    `INSERT INTO agents(agent_id,owner_id) VALUES($1,$4),($2,$4),($3,$4)`,
    [CMD, WORKER, OTHER, H],
  );
  await db.query(
    `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status)
     VALUES(77,$1,'42','owner','User','selected','active')`,
    [H],
  );
  await db.query(
    `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
     VALUES(101,77,'owner/beeline','main')`,
  );
  await db.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name,repository_key,repository_remote,repository_resolution,github_installation_id)
     VALUES($1,$2,$3,'beeline','owner/beeline','https://github.com/owner/beeline.git','repository',77)`,
    [CHAT, WS, H],
  );
  for (const [id, role] of [
    [H, 'owner'],
    [CMD, 'member'],
    [WORKER, 'member'],
    [OTHER, 'member'],
  ] as const) {
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,$3),($1,$4,$2,$3)`,
      [WS, id, role, CHAT],
    );
  }
}

async function seedCommanderTurn(roomId = CHAT, agentId = CMD) {
  const sourceMessageId = createHash('sha256').update(`human:${randomUUID()}`).digest('hex');
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@commander build this')`, [
    sourceMessageId,
    roomId,
    H,
  ]);
  const cmd = await sendMessage(db, {
    route: { from: { agent: H, place: roomId }, to: { agent: agentId, place: roomId } },
    text: '@commander build this',
  });
  await db.query(`UPDATE agent_commands SET source_message_id=$2,root_source_message_id=$2 WHERE id=$1`, [
    cmd.id,
    sourceMessageId,
  ]);
  await daemon.execute(
    'startAgentTurn',
    { roomId, requestId: cmd.id, invocationId: randomUUID() },
    agentId,
  );
  return { cmd, sourceMessageId };
}

async function openThread(options: {
  name?: string;
  implementer?: string;
  repositoryWork?: boolean;
  fromRoomId?: string;
  commanderId?: string;
  requestId?: string;
  sourceMessageId?: string;
} = {}) {
  const fromRoomId = options.fromRoomId ?? CHAT;
  const commanderId = options.commanderId ?? CMD;
  let requestId = options.requestId;
  let sourceMessageId = options.sourceMessageId;
  if (!requestId || !sourceMessageId) {
    const seeded = await seedCommanderTurn(fromRoomId, commanderId);
    requestId = seeded.cmd.id;
    sourceMessageId = seeded.sourceMessageId;
  }
  const opened = await daemon.execute(
    'createCorner',
    {
      roomId: fromRoomId,
      targetRoomId: CHAT,
      requestId,
      name: options.name ?? 'ship-widget',
      objective: 'Ship the widget',
      implementer: options.implementer ?? 'worker',
      ...(options.repositoryWork !== false ? { repository: 'owner/beeline' } : {}),
      brief: {
        spec: 'Ship the widget.',
        ...(options.repositoryWork !== undefined ? { repositoryWork: options.repositoryWork } : {}),
        approval: { sourceMessageId },
      },
    },
    commanderId,
  );
  await db.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`, [requestId]);
  return { cornerId: opened.cornerId, requestId, sourceMessageId };
}

async function attachPr(cornerId: string, prNumber = 42) {
  await recordCornerGithubFact(db, cornerId, {
    kind: 'pr-opened',
    pr: {
      number: prNumber,
      url: `https://github.com/owner/beeline/pull/${prNumber}`,
      title: 'Ship the widget',
      targetBranch: 'main',
      headSha: SHA,
    },
  });
  return `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`;
}

async function closeWakes(agentId: string, roomId?: string) {
  return (await readAgentCommands(db, agentId, roomId)).commands.filter(
    (cmd) => cmd.reason === 'corner_closed',
  );
}

beforeEach(async () => {
  db = await migratedDatabase();
  githubApp = {
    closePullRequest: vi.fn(async () => undefined),
    deleteBranch: vi.fn(async () => undefined),
    installationToken: vi.fn(async () => ({ token: 'ghs_test' })),
    branchDeletionSafety: vi.fn(async () => ({
      defaultBranch: 'main',
      aheadBy: 0,
      protected: false,
      openBasePullRequest: false,
    })),
    openPullRequestsForBranch: vi.fn(async () => []),
  };
  github = new GitHubOperations(
    db,
    {} as GitHubOAuthClient,
    githubApp as unknown as GitHubAppClient,
    'secret',
  );
  daemon = new DaemonService(
    db,
    new LiveHub(),
    undefined,
    undefined,
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (id) => github.closeCornerPullRequest(id),
  );
  phone = new PhoneService(db, 'http://test', github);
  await seedWorld();
});

afterEach(async () => {
  await db?.close();
});

describe('corner_closed commander wake', () => {
  it('wakes the commanding agent at its parent chat on PR merge with PR #, merge SHA, and silent directive, and completes silently with empty text', async () => {
    const { cornerId } = await openThread({ name: 'merge-wake' });
    const branch = await attachPr(cornerId, 42);
    const messagesBefore = (
      await db.query<{ count: number }>(
        `SELECT count(*)::int count FROM messages WHERE room_id=$1 AND presentation='message'`,
        [CHAT],
      )
    ).rows[0]!.count;

    const webhook = {
      action: 'closed',
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/beeline' },
      pull_request: {
        number: 42,
        title: 'Ship the widget',
        html_url: 'https://github.com/owner/beeline/pull/42',
        head: { ref: branch, sha: SHA },
        base: { ref: 'main' },
        merged: true,
        merged_at: '2026-11-28T14:50:00Z',
        merge_commit_sha: MERGE_SHA,
      },
    };
    await github.processWebhook('pull_request', webhook);
    // Replaying the merge webhook and archival transition never duplicates the wake.
    await github.processWebhook('pull_request', webhook);
    await archiveCornerState(db, cornerId, { prNumber: 42, mergeCommitSha: MERGE_SHA });
    await notifyCommanderCornerClosed(db, cornerId, {
      outcome: 'merged',
      merge: { prNumber: 42, mergeCommitSha: MERGE_SHA },
    });

    const wakes = await closeWakes(CMD, CHAT);
    expect(wakes).toHaveLength(1);
    const wake = wakes[0]!;
    expect(wake.id).toBe(createHash('sha256').update(`corner-closed:${cornerId}`).digest('hex'));
    expect(wake.roomId).toBe(CHAT);
    expect(wake.returnRoomId).toBe(CHAT);
    expect(wake.from).toEqual({ agent: SYSTEM_IDENTITY_ID, place: cornerId });
    expect(wake.source.body).toContain('#merge-wake');
    expect(wake.source.body).toContain(cornerId);
    expect(wake.source.body).toContain('PR #42');
    expect(wake.source.body).toContain(MERGE_SHA);
    expect(wake.source.body).toContain(NO_MESSAGE_DIRECTIVE);

    // No public chat card or message is posted when the thread closes.
    const messagesAfterClose = (
      await db.query<{ count: number }>(
        `SELECT count(*)::int count FROM messages WHERE room_id=$1 AND presentation='message'`,
        [CHAT],
      )
    ).rows[0]!.count;
    expect(messagesAfterClose).toBe(messagesBefore);

    // Ending the woken turn with empty text completes cleanly without posting any chat message.
    const inv = { id: randomUUID(), requestId: wake.turnRequestId };
    await daemon.execute('startAgentTurn', { roomId: CHAT, requestId: wake.turnRequestId, invocationId: inv.id }, CMD);
    const silent = await daemon.execute(
      'postRoomMessage',
      { roomId: CHAT, requestId: wake.turnRequestId, text: '', harnessEnded: true, invocation: inv },
      CMD,
    );
    expect(silent.completed).toBe(true);
    expect(silent.published).toBe(false);
    expect(await closeWakes(CMD, CHAT)).toEqual([]);
    const messagesAfterSilent = (
      await db.query<{ count: number }>(
        `SELECT count(*)::int count FROM messages WHERE room_id=$1 AND presentation='message'`,
        [CHAT],
      )
    ).rows[0]!.count;
    expect(messagesAfterSilent).toBe(messagesBefore);
  });

  it.each(['human-ui', 'other-agent', 'pr-closed-unmerged', 'idle-auto-close'] as const)(
    'wakes the agent commander when closed without merging via %s',
    async (mode) => {
      const { cornerId } = await openThread({ name: `close-${mode}` });
      const branch = await attachPr(cornerId, 55);

      if (mode === 'human-ui') {
        await phone.execute('requestCornerClose', { roomId: cornerId }, H);
      } else if (mode === 'other-agent') {
        const otherTurn = await seedCommanderTurn(CHAT, OTHER);
        await daemon.execute(
          'archiveCorner',
          { cornerId, roomId: CHAT, requestId: otherTurn.cmd.id },
          OTHER,
        );
      } else if (mode === 'pr-closed-unmerged') {
        await github.processWebhook('pull_request', {
          action: 'closed',
          installation: { id: 77 },
          repository: { id: 101, full_name: 'owner/beeline' },
          pull_request: {
            number: 55,
            title: 'Ship the widget',
            html_url: 'https://github.com/owner/beeline/pull/55',
            head: { ref: branch, sha: SHA },
            base: { ref: 'main' },
            merged: false,
          },
        });
      } else {
        await db.query(`UPDATE rooms SET created_at=now() - interval '8 days' WHERE id=$1`, [cornerId]);
        expect(await closeInactiveCorners(db)).toBe(1);
      }

      // Replaying archival emits no duplicate wake.
      await closeCornerState(db, cornerId);

      const wakes = await closeWakes(CMD, CHAT);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]!.source.body).toContain(cornerId);
      expect(wakes[0]!.source.body).toContain('closed without merging');
      expect(wakes[0]!.source.body).toContain(NO_MESSAGE_DIRECTIVE);
    },
  );

  it('wakes a commander who also implemented the thread at its parent return address, unless it closed from that same return address', async () => {
    // 1. Commander === implementer closes from inside the thread -> wakes at parent CHAT.
    const selfImpl = await openThread({ name: 'self-impl', implementer: 'commander' });
    const [opening] = (await readAgentCommands(db, CMD, selfImpl.cornerId)).commands;
    await daemon.execute(
      'startAgentTurn',
      { roomId: selfImpl.cornerId, requestId: opening!.turnRequestId, invocationId: randomUUID() },
      CMD,
    );
    await daemon.execute(
      'archiveCorner',
      { cornerId: selfImpl.cornerId, roomId: selfImpl.cornerId, requestId: opening!.turnRequestId },
      CMD,
    );
    const wakesAfterThreadClose = await closeWakes(CMD, CHAT);
    expect(wakesAfterThreadClose).toHaveLength(1);
    expect(wakesAfterThreadClose[0]!.source.body).toContain(selfImpl.cornerId);
    await answerQueuedMessage(db, CMD, {
      roomId: CHAT,
      requestId: wakesAfterThreadClose[0]!.turnRequestId,
      text: '',
      harnessEnded: true,
    });

    // 2. Commander closes a thread (even with an open PR) from its own return address CHAT -> no self-wake.
    const ownClosed = await openThread({ name: 'self-closed-from-chat', implementer: 'commander' });
    await attachPr(ownClosed.cornerId, 61);
    const parentTurn = await seedCommanderTurn(CHAT, CMD);
    await daemon.execute(
      'archiveCorner',
      { cornerId: ownClosed.cornerId, roomId: CHAT, requestId: parentTurn.cmd.id },
      CMD,
    );
    expect(githubApp.closePullRequest).toHaveBeenCalledWith(77, 101, 'owner/beeline', 61);
    expect(await closeWakes(CMD, CHAT)).toEqual([]);
  });

  it('wakes the commander in a live parent thread, and skips when the parent thread return room is archived', async () => {
    const parent = await openThread({ name: 'parent-thread', implementer: 'worker', repositoryWork: false });
    const [parentOpening] = (await readAgentCommands(db, WORKER, parent.cornerId)).commands;
    await daemon.execute(
      'startAgentTurn',
      { roomId: parent.cornerId, requestId: parentOpening!.turnRequestId, invocationId: randomUUID() },
      WORKER,
    );

    // Child 1 closes while parent thread is still open -> WORKER wakes in parent.cornerId.
    const child1 = await openThread({
      name: 'child-live',
      implementer: 'other',
      fromRoomId: parent.cornerId,
      commanderId: WORKER,
      requestId: parentOpening!.turnRequestId,
      sourceMessageId: parentOpening!.sourceMessageId,
    });
    await phone.execute('requestCornerClose', { roomId: child1.cornerId }, H);
    const liveParentWakes = await closeWakes(WORKER, parent.cornerId);
    expect(liveParentWakes).toHaveLength(1);
    expect(liveParentWakes[0]!.roomId).toBe(parent.cornerId);
    expect(liveParentWakes[0]!.source.body).toContain(child1.cornerId);

    // Child 2 closes AFTER parent thread is archived -> no wake queued in archived return room.
    const child2 = await openThread({
      name: 'child-archived-parent',
      implementer: 'other',
      fromRoomId: parent.cornerId,
      commanderId: WORKER,
      requestId: parentOpening!.turnRequestId,
      sourceMessageId: parentOpening!.sourceMessageId,
    });
    await phone.execute('requestCornerClose', { roomId: parent.cornerId }, H);
    await phone.execute('requestCornerClose', { roomId: child2.cornerId }, H);
    expect(
      (
        await db.query(
          `SELECT id FROM agent_commands WHERE reason='corner_closed' AND private_payload->>'fromRoomId'=$1`,
          [child2.cornerId],
        )
      ).rowCount,
    ).toBe(0);
  });

  it('does not queue corner_closed for human commanders, locked standing threads, or removed commanders', async () => {
    // 1. Human commander.
    const humanThread = await phone.execute('createHumanCorner', { roomId: CHAT, title: 'human-owned' }, H);
    await phone.execute('requestCornerClose', { roomId: humanThread.id }, H);
    expect(
      (await db.query(`SELECT id FROM agent_commands WHERE reason='corner_closed'`)).rowCount,
    ).toBe(0);

    // 2. Locked standing thread merged -> stays open and emits no wake.
    const locked = await openThread({ name: 'standing-locked' });
    const branch = await attachPr(locked.cornerId, 77);
    await setCornerLockedFact(db, locked.cornerId, true);
    await github.processWebhook('pull_request', {
      action: 'closed',
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/beeline' },
      pull_request: {
        number: 77,
        title: 'Standing PR',
        html_url: 'https://github.com/owner/beeline/pull/77',
        head: { ref: branch, sha: SHA },
        base: { ref: 'main' },
        merged: true,
        merged_at: '2026-11-28T15:00:00Z',
        merge_commit_sha: MERGE_SHA,
      },
    });
    expect(
      (await db.query<{ archived: boolean }>(`SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`, [locked.cornerId]))
        .rows[0]!.archived,
    ).toBe(false);
    expect(await closeWakes(CMD, CHAT)).toEqual([]);

    // 3. Removed commander.
    const removed = await openThread({ name: 'removed-commander' });
    await db.query(
      `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
      [CHAT, CMD],
    );
    await phone.execute('requestCornerClose', { roomId: removed.cornerId }, H);
    expect(
      (
        await db.query(
          `SELECT id FROM agent_commands WHERE reason='corner_closed' AND private_payload->>'fromRoomId'=$1`,
          [removed.cornerId],
        )
      ).rowCount,
    ).toBe(0);
  });

  it('skips duplicate corner_closed on repo-less self-close while still waking on external human close', async () => {
    // 1. Self-closing repo-less thread -> only one `reply` wake with closing deliverable, no `corner_closed`.
    const selfClosed = await openThread({ name: 'repoless-self', repositoryWork: false });
    const [opening] = (await readAgentCommands(db, WORKER, selfClosed.cornerId)).commands;
    const inv = { id: randomUUID(), requestId: opening!.turnRequestId };
    await daemon.execute(
      'startAgentTurn',
      { roomId: selfClosed.cornerId, requestId: opening!.turnRequestId, invocationId: inv.id },
      WORKER,
    );
    await daemon.execute(
      'archiveCorner',
      { cornerId: selfClosed.cornerId, roomId: selfClosed.cornerId, requestId: opening!.turnRequestId },
      WORKER,
    );
    expect(await closeWakes(CMD, CHAT)).toEqual([]);
    await daemon.execute(
      'postRoomMessage',
      {
        roomId: selfClosed.cornerId,
        requestId: opening!.turnRequestId,
        text: 'Audit deliverable attached.',
        harnessEnded: true,
        invocation: inv,
      },
      WORKER,
    );
    const wakes = (await readAgentCommands(db, CMD, CHAT)).commands;
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      reason: 'reply',
      roomId: CHAT,
      source: { body: 'Audit deliverable attached.' },
    });
    await db.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`, [wakes[0]!.id]);

    // 2. External human close of a repo-less thread -> emits `corner_closed` wake.
    const externallyClosed = await openThread({ name: 'repoless-human-close', repositoryWork: false });
    await phone.execute('requestCornerClose', { roomId: externallyClosed.cornerId }, H);
    const extWakes = await closeWakes(CMD, CHAT);
    expect(extWakes).toHaveLength(1);
    expect(extWakes[0]!.source.body).toContain('#repoless-human-close');
    expect(extWakes[0]!.source.body).toContain(NO_MESSAGE_DIRECTIVE);
  });
});

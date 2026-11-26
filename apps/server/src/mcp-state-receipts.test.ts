import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readAgentMessagePage } from '@beeline/api-contract/daemon';
import { createAgentCommand } from './agent-command.js';
import { LiveHub } from './live.js';
import { RoomsMcpAgentTools } from './rooms-mcp-agent.js';
import { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';
import { startQueuedCommand } from './test-fixtures/queued-turn.test-support.js';
import { migratedDatabase } from './test-support.js';

const OWNER = 'a'.repeat(64);
const MEMBER = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);
const WORKER = 'd'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const DM_ROOM = '44444444-4444-4444-8444-444444444444';

async function setupFixture() {
  const database = await migratedDatabase();
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Lunchbox','lunchboxfortwo'),($2,'human','Teammate','teammate'),($3,'agent','Carbon','carbon'),($4,'agent','Crayon','crayon')`,
    [OWNER, MEMBER, AGENT, WORKER],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Beeline')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO workspace_handles(workspace_id,identity_id,handle) VALUES
      ($1,$2,'lunchboxfortwo'),($1,$3,'teammate'),($1,$4,'carbon'),($1,$5,'crayon')`,
    [WORKSPACE, OWNER, MEMBER, AGENT, WORKER],
  );
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'beeline')`,
    [ROOM, WORKSPACE, OWNER],
  );
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name,direct_participants) VALUES($1,$2,$3,'Private DM',$4::jsonb)`,
    [DM_ROOM, WORKSPACE, OWNER, JSON.stringify([OWNER, AGENT])],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),($1,NULL,$5,'member'),
      ($1,$6,$2,'owner'),($1,$6,$3,'member'),($1,$6,$4,'member'),($1,$6,$5,'member'),
      ($1,$7,$2,'owner'),($1,$7,$4,'member')`,
    [WORKSPACE, OWNER, MEMBER, AGENT, WORKER, ROOM, DM_ROOM],
  );
  await database.query(
    `INSERT INTO agents(agent_id,owner_id) VALUES($1,$2),($3,$2)`,
    [AGENT, OWNER, WORKER],
  );
  const daemon = new DaemonService(database, new LiveHub());
  return { database, daemon };
}

async function startHumanTurn(
  database: Awaited<ReturnType<typeof migratedDatabase>>,
  daemon: DaemonService,
  roomId: string,
  agentId: string,
  authorId = OWNER,
  text = 'Proceed with the requested work',
) {
  const messageId = randomBytes(32).toString('hex');
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`,
    [messageId, roomId, authorId, text],
  );
  const command = (await createAgentCommand(database, {
    roomId,
    agentId,
    sourceMessageId: messageId,
    reason: 'human_message',
  }))!;
  await startQueuedCommand(daemon, { roomId, commandId: command.id }, agentId);
  return { messageId, commandId: command.id, requestId: command.turn_request_id };
}

describe('mcp-state-receipts server provenance and post-condition receipts', () => {
  it('exposes repliesTo and approvedBy on wake list and explicit receipts across wake mutations without leaking deleted or cross-partition sources', async () => {
    const { database, daemon } = await setupFixture();
    try {
      const turn = await startHumanTurn(database, daemon, ROOM, AGENT, OWNER, 'Schedule the morning card');
      const created = await daemon.execute(
        'createAgentSchedule',
        {
          roomId: ROOM,
          requestId: turn.requestId,
          title: 'Morning card',
          prompt: 'Send the morning digest',
          cadence: { kind: 'interval', everyMinutes: 60 },
        },
        AGENT,
      );
      expect(created.scheduleId).toBeTruthy();
      expect(created.repliesTo).toMatchObject({ identityId: OWNER, handle: 'lunchboxfortwo' });
      expect(created.approvedBy).toMatchObject({
        identityId: OWNER,
        handle: 'lunchboxfortwo',
        sourceMessageId: turn.messageId,
      });
      expect(created.receipt).toContain('Created "Morning card"');
      expect(created.receipt).toContain('replies to @lunchboxfortwo');

      const listed = await daemon.execute('listAgentSchedules', { roomId: ROOM, selfOnly: true }, AGENT);
      const entry = listed.schedules.find((row) => row.scheduleId === created.scheduleId);
      expect(entry).toMatchObject({
        title: 'Morning card',
        repliesTo: { identityId: OWNER, handle: 'lunchboxfortwo' },
        approvedBy: {
          identityId: OWNER,
          handle: 'lunchboxfortwo',
          sourceMessageId: turn.messageId,
        },
      });

      const updated = await daemon.execute(
        'updateAgentSchedule',
        {
          roomId: ROOM,
          requestId: turn.requestId,
          scheduleId: created.scheduleId,
          title: 'Morning brief',
          cadence: { kind: 'interval', everyMinutes: 30 },
        },
        AGENT,
      );
      expect(updated.receipt).toContain('Updated "Morning brief"');
      expect(updated.receipt).toContain('replies to @lunchboxfortwo');
      expect(updated.approvedBy).toMatchObject({
        identityId: OWNER,
        handle: 'lunchboxfortwo',
        sourceMessageId: turn.messageId,
      });

      const paused = await daemon.execute(
        'setAgentWakePaused',
        { roomId: ROOM, requestId: turn.requestId, scheduleId: created.scheduleId, paused: true },
        AGENT,
      );
      expect(paused.paused).toBe(true);
      expect(paused.receipt).toContain('Paused "Morning brief"');
      expect(paused.repliesTo).toMatchObject({ identityId: OWNER, handle: 'lunchboxfortwo' });

      const resumed = await daemon.execute(
        'setAgentWakePaused',
        { roomId: ROOM, requestId: turn.requestId, scheduleId: created.scheduleId, paused: false },
        AGENT,
      );
      expect(resumed.paused).toBe(false);
      expect(resumed.receipt).toContain('Resumed "Morning brief"');

      // Partition isolation: a deleted source message or a DM source message must never leak into approvedBy.
      const dmSourceId = randomBytes(32).toString('hex');
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Secret DM command')`,
        [dmSourceId, DM_ROOM, OWNER],
      );
      await database.query(
        `UPDATE agent_schedules SET human_command_message_id=$2 WHERE id=$1`,
        [created.scheduleId, dmSourceId],
      );
      const listedAfterDm = await daemon.execute('listAgentSchedules', { roomId: ROOM, selfOnly: true }, AGENT);
      const dmLeakEntry = listedAfterDm.schedules.find((row) => row.scheduleId === created.scheduleId);
      expect(dmLeakEntry?.approvedBy).toBeUndefined();

      await database.query(
        `UPDATE agent_schedules SET human_command_message_id=$2 WHERE id=$1`,
        [created.scheduleId, turn.messageId],
      );
      await database.query(`UPDATE messages SET deleted_at=now() WHERE id=$1`, [turn.messageId]);
      const listedAfterDelete = await daemon.execute('listAgentSchedules', { roomId: ROOM, selfOnly: true }, AGENT);
      const deletedLeakEntry = listedAfterDelete.schedules.find((row) => row.scheduleId === created.scheduleId);
      expect(deletedLeakEntry?.approvedBy).toBeUndefined();

      // Restore source message so deletion turn still sees normal provenance, then delete.
      await database.query(`UPDATE messages SET deleted_at=NULL WHERE id=$1`, [turn.messageId]);
      const deleted = await daemon.execute(
        'deleteAgentSchedule',
        { roomId: ROOM, requestId: turn.requestId, scheduleId: created.scheduleId },
        AGENT,
      );
      expect(deleted.receipt).toContain('Deleted "Morning brief"');

      const events = await daemon.execute(
        'setEventSubscriptions',
        { roomId: ROOM, requestId: turn.requestId, kinds: ['check-failed'] },
        AGENT,
      );
      expect(events.receipt).toContain('Updated event subscriptions');
      expect(events.receipt).toContain('check-failed');

      const sub = await daemon.execute(
        'createAgentSubscription',
        {
          roomId: ROOM,
          requestId: turn.requestId,
          source: 'room',
          event: 'check-failed',
          title: 'CI watch',
          when: 'On thread checks failing',
          prompt: 'Inspect the failing check',
        },
        AGENT,
      );
      expect(sub.receipt).toContain('Created subscription "CI watch"');
      const deletedSub = await daemon.execute(
        'deleteAgentSubscription',
        { roomId: ROOM, requestId: turn.requestId, subscriptionId: sub.id },
        AGENT,
      );
      expect(deletedSub.receipt).toContain('Deleted subscription "CI watch"');
    } finally {
      await database.close();
    }
  });

  it('exposes bounded repliesTo and causal request provenance on read(messages) and read(message) while omitting deleted parents', async () => {
    const { database, daemon } = await setupFixture();
    try {
      const parentId = randomBytes(32).toString('hex');
      const longParent = `${'Quarterly metrics review '.repeat(12)}end`;
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`,
        [parentId, ROOM, OWNER, longParent],
      );
      const replyId = randomBytes(32).toString('hex');
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,reply_to_message_id,root_message_id,request_id) VALUES($1,$2,$3,'Acknowledged and scheduled',$4,$4,$4)`,
        [replyId, ROOM, AGENT, parentId],
      );

      const page = await readAgentMessagePage({ roomId: ROOM, limit: 8 }, (input) =>
        daemon.execute('getRoomConversation', input, AGENT),
      );
      const pageReply = page.items.find((item) => item.id === replyId)!;
      expect(pageReply).toMatchObject({
        id: replyId,
        rootMessageId: parentId,
        requestAuthorId: OWNER,
        repliesTo: {
          messageId: parentId,
          authorId: OWNER,
          authorName: 'Lunchbox',
        },
      });
      expect(pageReply.repliesTo!.excerpt!.length).toBeLessThanOrEqual(160);
      expect(pageReply.repliesTo!.excerpt!.endsWith('…')).toBe(true);

      const single = await daemon.execute(
        'getRoomMessage',
        { roomId: ROOM, messageId: replyId },
        AGENT,
      );
      expect(single).toMatchObject({
        messageId: replyId,
        authorId: AGENT,
        authorHandle: 'carbon',
        rootMessageId: parentId,
        requestAuthorId: OWNER,
        repliesTo: {
          messageId: parentId,
          authorId: OWNER,
          authorName: 'Lunchbox',
        },
      });
      expect(single.repliesTo!.excerpt!.length).toBeLessThanOrEqual(160);

      // Deleting the parent must suppress repliesTo completely on both reads.
      await database.query(`UPDATE messages SET deleted_at=now() WHERE id=$1`, [parentId]);
      const pageAfterDelete = await readAgentMessagePage({ roomId: ROOM, limit: 8 }, (input) =>
        daemon.execute('getRoomConversation', input, AGENT),
      );
      expect(pageAfterDelete.items.find((item) => item.id === replyId)?.repliesTo).toBeUndefined();

      const singleAfterDelete = await daemon.execute(
        'getRoomMessage',
        { roomId: ROOM, messageId: replyId },
        AGENT,
      );
      expect(singleAfterDelete.repliesTo).toBeUndefined();
    } finally {
      await database.close();
    }
  });

  it('returns explicit receipts and provenance across message, open_thread, revise_thread, set_thread_hold, claim_thread, work items, close_ask, and close_thread', async () => {
    const { database, daemon } = await setupFixture();
    try {
      const turn = await startHumanTurn(database, daemon, ROOM, AGENT, OWNER, 'Yes go, open and hold');

      const sent = await daemon.execute(
        'message',
        {
          roomId: ROOM,
          requestId: turn.requestId,
          type: 'normal',
          address: `${WORKER}@${ROOM}`,
          text: 'Please stand by for thread dispatch.',
        },
        AGENT,
      );
      expect(sent.to).toMatchObject({ identityId: WORKER, handle: 'crayon', place: ROOM });
      expect(sent.receipt).toContain('Sent message to @crayon');

      // Worker replies to that pending message via RoomsMcpAgentTools.
      const replied = (await new RoomsMcpAgentTools(database, daemon).call(WORKER, 'reply', {
        id: sent.id,
        commandId: sent.id,
        text: 'Standing by.',
      })) as {
        id?: string;
        to?: { identityId: string; handle?: string; place: string };
        repliesTo?: { messageId: string; authorId?: string; authorHandle?: string };
        receipt?: string;
      };
      expect(replied.to).toMatchObject({ identityId: AGENT, handle: 'carbon', place: ROOM });
      expect(replied.repliesTo).toMatchObject({ messageId: sent.id, authorId: AGENT, authorHandle: 'carbon' });
      expect(replied.receipt).toContain('Replied to @carbon');

      const opened = await daemon.execute(
        'createCorner',
        {
          roomId: ROOM,
          requestId: turn.requestId,
          name: 'receipt-proof',
          objective: 'Add explicit state receipts across Beeline tools',
          implementer: 'crayon',
          brief: {
            spec: '## Intent\nAdd receipts.\n\n## User stories\n- Receipts everywhere.',
            repositoryWork: false,
            approval: { sourceMessageId: turn.messageId },
          },
        },
        AGENT,
      );
      expect(opened.cornerId).toBeTruthy();
      expect(opened.name).toBe('receipt-proof');
      expect(opened.implementer).toBe('crayon');
      expect(opened.approvedBy).toMatchObject({
        identityId: OWNER,
        sourceMessageId: turn.messageId,
      });
      expect(opened.receipt).toContain('Opened thread receipt-proof');
      expect(opened.receipt).toContain('assigned @crayon');

      const cornerId = opened.cornerId;

      // Worker claims the thread and gets an explicit receipt.
      const workerCommands = (await daemon.execute('getAgentCommands', { roomId: cornerId }, WORKER)).commands;
      expect(workerCommands.length).toBeGreaterThan(0);
      const workerCmd = workerCommands[0]!;
      await startQueuedCommand(daemon, { roomId: cornerId, commandId: workerCmd.id }, WORKER);

      const claimed = await daemon.execute(
        'becomeImplementer',
        { roomId: cornerId, requestId: workerCmd.turnRequestId, cornerId },
        WORKER,
      );
      expect(claimed.receipt).toContain('Claimed thread #receipt-proof');

      // Commander revises thread brief and metadata.
      const revised = await daemon.execute(
        'reviseCornerBrief',
        {
          roomId: ROOM,
          requestId: turn.requestId,
          cornerId,
          expectedRevision: 1,
          brief: {
            change: 'Clarify scope',
            spec: '## Intent\nAdd receipts.\n\n## User stories\n- Receipts everywhere.\n- Clarified.',
            repositoryWork: false,
            approval: { sourceMessageId: turn.messageId },
          },
        },
        AGENT,
      );
      expect(revised.revision).toBe(2);
      expect(revised.receipt).toContain('Revised thread receipt-proof brief (r2)');

      const renamed = await daemon.execute(
        'renameCorner',
        {
          roomId: ROOM,
          requestId: turn.requestId,
          cornerId,
          name: 'receipt-proof-v2',
        },
        AGENT,
      );
      expect(renamed.receipt).toContain('Renamed thread to #receipt-proof-v2');

      // Hold set + release.
      const held = await daemon.execute(
        'setCornerHold',
        {
          roomId: ROOM,
          requestId: turn.requestId,
          cornerId,
          sourceMessageId: turn.messageId,
        },
        AGENT,
      );
      expect(held.holdId).toBeTruthy();
      expect(held.approvedBy).toMatchObject({ identityId: OWNER, sourceMessageId: turn.messageId });
      expect(held.receipt).toContain('Set merge hold on #receipt-proof-v2');

      const released = await daemon.execute(
        'setCornerHold',
        {
          roomId: ROOM,
          requestId: turn.requestId,
          cornerId,
          releaseHoldId: held.holdId,
        },
        AGENT,
      );
      expect(released.released).toBe(true);
      expect(released.receipt).toContain('Released merge hold on #receipt-proof-v2');

      // Work item create & update.
      const taskId = randomUUID();
      const workCreated = await daemon.execute(
        'updateWorkItem',
        {
          roomId: ROOM,
          targetRoomId: ROOM,
          requestId: turn.requestId,
          id: taskId,
          title: 'Verify receipts',
          state: 'backlog',
        },
        AGENT,
      );
      expect(workCreated.receipt).toContain('Created task "Verify receipts"');
      expect(workCreated.receipt).toContain('backlog');

      const workUpdated = await daemon.execute(
        'updateWorkItem',
        {
          roomId: ROOM,
          targetRoomId: ROOM,
          requestId: turn.requestId,
          id: taskId,
          state: 'in-progress',
        },
        AGENT,
      );
      expect(workUpdated.receipt).toContain('Updated task "Verify receipts"');
      expect(workUpdated.receipt).toContain('in-progress');

      // Blocked message + close_ask.
      const blocked = await daemon.execute(
        'message',
        {
          roomId: cornerId,
          requestId: workerCmd.turnRequestId,
          type: 'blocked',
          text: 'Need confirmation on naming.',
        },
        WORKER,
      );
      expect(blocked.receipt).toContain('Reported blocker to @carbon');
      expect(blocked.to).toMatchObject({ identityId: AGENT, handle: 'carbon' });

      const closedAsk = await daemon.execute(
        'closeAgentAsk',
        {
          roomId: cornerId,
          requestId: workerCmd.turnRequestId,
          messageId: blocked.id!,
          reason: 'answered',
        },
        WORKER,
      );
      expect(closedAsk.receipt).toContain('Closed');
      expect(closedAsk.receipt).toContain('answered');

      // Close thread.
      const archived = await daemon.execute(
        'archiveCorner',
        {
          roomId: ROOM,
          requestId: turn.requestId,
          cornerId,
        },
        AGENT,
      );
      expect(archived.receipt).toContain('Closed thread #receipt-proof-v2');
    } finally {
      await database.close();
    }
  });
});

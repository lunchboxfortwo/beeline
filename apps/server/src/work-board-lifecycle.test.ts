import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describedWorkflow, migratedDatabase, type PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { HelperDaemonService } from './test-fixtures/helper-daemon.js';
import {
  readOpenBacklogTasks,
  readWorkBoard,
  readWorkItemsForAgent,
  readWorkThread,
  unifyWorkItemsAndThreads,
  updateWorkItem,
} from './work-board.js';
import { currentCornerBrief } from './corner-brief.js';
import { cornerMergeGate } from './corner-lifecycle-review-state.js';
import { createAgentCommand, readAgentCommands } from './agent-command.js';
import { modelText } from './message-origin.js';
import { getWorkflowRun, saveWorkflow, startWorkflow } from './workflow-runs.js';

const lunchbox = 'a'.repeat(64);
const juniper = 'c'.repeat(64);
const ruby = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const chat = '22222222-2222-4222-8222-222222222222';
const otherChat = '22222222-2222-4222-8222-333333333333';
const dm = '44444444-4444-4444-8444-444444444444';

let db: PgliteDatabase;
let phone: PhoneService;
let daemon: HelperDaemonService;

beforeEach(async () => {
  db = await migratedDatabase();
  phone = new PhoneService(db, 'https://server.example');
  daemon = new HelperDaemonService(db, new LiveHub());
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Lunchbox','lunchbox'),
       ($2,'human','Juniper','juniper'),
       ($3,'agent','Ruby','ruby')`,
    [lunchbox, juniper, ruby],
  );
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [ruby, lunchbox]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Beeline')", [workspace]);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,name,created_by,repository_key,repository_resolution,repository_target_branch)
     VALUES($1,$4,NULL,'beeline',$3,'owner/beeline','repository','main'),
           ($2,$4,NULL,'ops',$3,NULL,'none','main')`,
    [chat, otherChat, ruby, workspace],
  );
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,direct_participants,created_by)
     VALUES($1,$2,'DM',$3::jsonb,$4)`,
    [dm, workspace, JSON.stringify([lunchbox, ruby]), ruby],
  );
  for (const id of [lunchbox, juniper, ruby]) {
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member'),($1,$4,$2,'member')`,
      [workspace, id, chat, otherChat],
    );
  }
  for (const id of [lunchbox, ruby]) {
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [workspace, dm, id],
    );
  }
});

afterEach(async () => {
  await db.close();
});

describe('unified work lifecycle', () => {
  it('keeps one UUID and normalized 3-word hyphenated title across backlog, promotion, parking, resume, and done', async () => {
    const taskId = randomUUID();
    const objectId = '77777777-7777-4777-8777-777777777777';
    await db.query(
      `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
       VALUES($1,$2,'media','spec-pdf','application/pdf','spec.pdf',512,$3,'ready',now()+interval '1 day')`,
      [objectId, lunchbox, 'e'.repeat(64)],
    );

    // 1. Create in Backlog with multi-word title, @handle assignee, note, and attachments
    await updateWorkItem(
      db,
      {
        roomId: chat,
        id: taskId,
        title: 'squire 5618 fix extra words',
        objective: 'Keep one UUID and name across every column.',
        assigneeId: '@ruby',
        note: 'Verify push notifications too.',
        attachments: [
          { kind: 'link', name: 'Design doc', url: 'https://example.org/design' },
          { kind: 'file', name: 'spec.pdf', objectId },
        ],
      },
      lunchbox,
    );

    const created = (await readWorkBoard(db, workspace, lunchbox)).items.find((i) => i.id === taskId)!;
    expect(created).toMatchObject({
      id: taskId,
      roomId: chat,
      title: 'squire-5618-fix',
      threadName: 'squire-5618-fix',
      state: 'backlog',
      assignee: { pubkey: ruby },
      openedBy: { pubkey: lunchbox },
    });

    // 2. Promote Backlog -> In progress in-place into its thread
    await updateWorkItem(db, { roomId: chat, id: taskId, state: 'in-progress' }, lunchbox);

    const promotedRoom = (
      await db.query<{ id: string; parent_id: string; name: string; repository_key: string | null }>(
        'SELECT id::text id,parent_id::text parent_id,name,repository_key FROM rooms WHERE id=$1',
        [taskId],
      )
    ).rows[0];
    expect(promotedRoom).toEqual({
      id: taskId,
      parent_id: chat,
      name: 'squire-5618-fix',
      repository_key: 'owner/beeline',
    });

    // Single row on board, preserving notes, attachments, opener, and assignee
    const afterPromote = await readWorkBoard(db, workspace, lunchbox);
    expect(afterPromote.items.filter((i) => i.id === taskId || i.title === 'squire-5618-fix')).toHaveLength(1);
    const promotedItem = afterPromote.items.find((i) => i.id === taskId)!;
    expect(promotedItem).toMatchObject({
      id: taskId,
      roomId: taskId,
      title: 'squire-5618-fix',
      state: 'in-progress',
      openedBy: { pubkey: lunchbox },
      assignee: { pubkey: ruby },
    });
    expect(promotedItem.entries?.some((e) => e.kind === 'note' && e.text === 'Verify push notifications too.')).toBe(true);
    expect(promotedItem.attachments).toHaveLength(2);

    // Static corner-open card posted once in parent chat
    expect(
      (
        await db.query(
          `SELECT id FROM messages WHERE room_id=$1 AND card_type='daemon-fact' AND card->>'type'='corner-open' AND card->>'cornerId'=$2`,
          [chat, taskId],
        )
      ).rowCount,
    ).toBe(1);

    // Brief revision 1 synthesized with objective, notes, and file attachments; implementer woken
    const brief = await currentCornerBrief(db, taskId);
    expect(brief).toMatchObject({ revision: 1 });
    expect(brief?.spec).toContain('Keep one UUID and name across every column.');
    expect(brief?.spec).toContain('Verify push notifications too.');
    expect(brief?.spec).toContain('https://example.org/design');
    expect(brief?.attachments).toHaveLength(1);
    expect(brief?.attachments[0]).toMatchObject({ objectId, title: 'spec.pdf' });
    expect(
      (await db.query(`SELECT id FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND state='pending'`, [taskId, ruby]))
        .rowCount,
    ).toBe(1);

    // 3. Move open thread In progress -> Backlog: cancels commands/turns, abandons workflows, clears Needs you, closes merge gate
    await db.query(
      `INSERT INTO agent_turns(room_id,agent_id,request_id,status) VALUES($1,$2,'active-req','working')`,
      [taskId, ruby],
    );
    await db.query(
      `INSERT INTO messages(id,room_id,author_id,text,card)
       VALUES('block-1',$1,$2,'blocked: need staging key',jsonb_build_object('reportStatus','blocked','reportToId',$3::text))`,
      [taskId, ruby, lunchbox],
    );
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('wf-root',$1,$2,'start deploy')`, [taskId, lunchbox]);
    const wfCmd = await createAgentCommand(db, { roomId: taskId, agentId: ruby, sourceMessageId: 'wf-root', reason: 'test' });
    await saveWorkflow(db, wfCmd!, {
      contract: describedWorkflow({
        version: 1,
        name: 'deploy-check',
        description: 'Check deploy state',
        roles: ['worker'],
        start: 'run',
        handoffs: {
          run: { role: 'worker', requires: [], on: { ok: 'done' } },
          done: { kind: 'terminal', status: 'done' },
        },
      }),
    });
    const { runId } = await startWorkflow(db, wfCmd!, { name: 'deploy-check', roleBindings: { worker: ruby } });
    const reconcileMergeQueue = vi.fn(async () => undefined);
    await updateWorkItem(db, { roomId: taskId, state: 'backlog', note: 'Paused for v2.' }, lunchbox, lunchbox, {
      reconcileMergeQueue,
    });

    expect(reconcileMergeQueue).toHaveBeenCalledWith(taskId);
    expect((await db.query(`SELECT id FROM agent_commands WHERE room_id=$1 AND state='pending'`, [taskId])).rowCount).toBe(0);
    expect((await db.query(`SELECT status FROM agent_turns WHERE room_id=$1`, [taskId])).rows[0]?.status).toBe('cancelled');
    expect((await getWorkflowRun(db, taskId, runId))?.status).toBe('abandoned');
    expect(
      (await db.query<{ cleared_reason: string | null }>(`SELECT cleared_reason FROM needs_you_marks WHERE message_id='block-1' AND identity_id=$1`, [lunchbox])).rows[0]?.cleared_reason,
    ).toBe('withdrawn');
    expect((await cornerMergeGate(db, taskId, { number: 12, headSha: '9'.repeat(40) })).open).toBe(false);
    expect((await readWorkThread(db, taskId, lunchbox))[0]).toMatchObject({ id: taskId, title: 'squire-5618-fix', state: 'backlog' });

    // 4. Move parked thread Backlog -> In progress: clears backlog and queues resume command
    await updateWorkItem(db, { roomId: taskId, state: 'in-progress' }, lunchbox);
    expect((await cornerMergeGate(db, taskId, { number: 12, headSha: '9'.repeat(40) })).open).toBe(true);
    expect(
      (await db.query(`SELECT id FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND state='pending'`, [taskId, ruby]))
        .rowCount,
    ).toBe(1);

    // 5. Move thread -> Done: executes closeThread
    await phone.execute('updateWorkItem', { roomId: taskId, state: 'done' }, lunchbox);
    expect((await readWorkBoard(db, workspace, lunchbox)).items.find((i) => i.id === taskId)).toMatchObject({
      id: taskId,
      title: 'squire-5618-fix',
      state: 'done',
      roomArchived: true,
    });
  });

  it('rejects unknown @handle assignees cleanly', async () => {
    await expect(
      updateWorkItem(db, { roomId: chat, id: randomUUID(), title: 'test', assigneeId: '@nobody' }, lunchbox),
    ).rejects.toThrow(/unknown assignee/);
  });

  it('raises one off-transcript Needs you item on human assignment and clears on clearNeedsYou, reassign, In progress, and Done', async () => {
    const t1 = randomUUID();
    await updateWorkItem(db, { roomId: chat, id: t1, title: 'squire 5618', objective: 'Check push' }, lunchbox);
    // Assigning to self raises nothing
    await updateWorkItem(db, { roomId: chat, id: t1, assigneeId: '@lunchbox' }, lunchbox);
    expect((await phone.execute('countNeedsYou', { workspaceId: workspace }, lunchbox)).count).toBe(0);

    // Assigning to another human raises one Needs you item without polluting visible chat messages
    await updateWorkItem(db, { roomId: chat, id: t1, assigneeId: '@juniper' }, lunchbox);
    const juniperBoard = await readWorkBoard(db, workspace, juniper);
    const ping = juniperBoard.items.find((item) => item.state === 'needs-you' && item.ask);
    expect(ping?.ask?.text).toBe('Lunchbox assigned you backlog item squire-5618');
    expect(ping?.title).toBe('squire-5618');
    expect((await phone.execute('countNeedsYou', { workspaceId: workspace }, juniper)).count).toBe(1);
    expect((await phone.readRoom(chat, juniper))?.messages).toEqual([]);
    const chatRow = (await phone.readChats(workspace, juniper))?.chats.find((c) => c.room.id === chat);
    expect(chatRow?.latestMessage).toBeUndefined();
    expect(chatRow?.unreadCount ?? 0).toBe(0);

    // Clear via clearNeedsYou (×)
    await phone.execute('clearNeedsYou', { workspaceId: workspace, messageId: ping!.messageId! }, juniper);
    expect((await phone.execute('countNeedsYou', { workspaceId: workspace }, juniper)).count).toBe(0);

    // Reassignment clears previous person's ping and notifies the new person
    const t2 = randomUUID();
    await updateWorkItem(db, { roomId: chat, id: t2, title: 'handoff-task', assigneeId: juniper }, lunchbox);
    expect((await phone.execute('countNeedsYou', { workspaceId: workspace }, juniper)).count).toBe(1);
    await updateWorkItem(db, { roomId: chat, id: t2, assigneeId: ruby }, lunchbox);
    expect((await phone.execute('countNeedsYou', { workspaceId: workspace }, juniper)).count).toBe(0);

    // Promoting to In progress clears the ping
    const t3 = randomUUID();
    await updateWorkItem(db, { roomId: chat, id: t3, title: 'promote-clears', assigneeId: juniper }, lunchbox);
    expect((await phone.execute('countNeedsYou', { workspaceId: workspace }, juniper)).count).toBe(1);
    await updateWorkItem(db, { roomId: chat, id: t3, state: 'in-progress' }, lunchbox);
    expect((await phone.execute('countNeedsYou', { workspaceId: workspace }, juniper)).count).toBe(0);

    // Completing an unopened task (Done) clears the ping
    const t4 = randomUUID();
    await updateWorkItem(db, { roomId: chat, id: t4, title: 'done-clears', assigneeId: juniper }, lunchbox);
    expect((await phone.execute('countNeedsYou', { workspaceId: workspace }, juniper)).count).toBe(1);
    await updateWorkItem(db, { roomId: chat, id: t4, state: 'done' }, lunchbox);
    expect((await phone.execute('countNeedsYou', { workspaceId: workspace }, juniper)).count).toBe(0);
  });

  it('folds legacy work_item_threads and normalizes standalone non-UUID rows idempotently without touching asks', async () => {
    const existingThread = randomUUID();
    await db.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'legacy-thread',$4)`,
      [existingThread, workspace, chat, ruby],
    );
    await db.query(`INSERT INTO corner_facts(corner_id,machine) VALUES($1,'{"state":"idle"}'::jsonb)`, [existingThread]);
    await db.query(
      `INSERT INTO work_items(id,room_id,state,title,objective,assignee_id,opened_by)
       VALUES('legacy-linked',$1,'in-progress','Legacy Linked Task Extra','Keep notes and opener',$2,$3),
             ('legacy-standalone',$1,'backlog','My Standalone Backlog Task','Ship later',NULL,$3)`,
      [chat, juniper, lunchbox],
    );
    await db.query(`INSERT INTO work_item_threads(work_item_id,thread_id) VALUES('legacy-linked',$1)`, [existingThread]);
    await db.query(`INSERT INTO work_item_entries(work_item_id,author_id,kind,text) VALUES('legacy-linked',$1,'note','Linked note'),('legacy-standalone',$1,'note','Standalone note')`, [lunchbox]);
    await db.query(
      `INSERT INTO work_item_attachments(work_item_id,kind,name,url,added_by)
       VALUES('legacy-linked','link','Thread: legacy-thread',$1,$2),
             ('legacy-linked','link','Spec','https://example.org/spec',$2)`,
      [`https://web.usebeeline.app/beeline/chat/${existingThread}?communityId=${workspace}`, lunchbox],
    );
    // Ask-backed row must remain untouched
    const askMsgId = 'd'.repeat(64);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Choose one')`, [askMsgId, chat, ruby]);
    await db.query(
      `INSERT INTO work_items(id,room_id,source_message_id,state,opened_by) VALUES($1,$2,$1,'needs-you',$3)`,
      [askMsgId, chat, ruby],
    );

    await unifyWorkItemsAndThreads(db);
    await unifyWorkItemsAndThreads(db); // idempotent

    expect((await db.query('SELECT 1 FROM work_item_threads')).rowCount).toBe(0);
    // Ask row untouched
    expect((await db.query('SELECT id FROM work_items WHERE id=$1', [askMsgId])).rowCount).toBe(1);

    const board = await readWorkBoard(db, workspace, lunchbox);
    // Folded thread row has zero duplicates and retains note, non-self attachment, objective, assignee, opener
    const folded = board.items.filter((i) => i.id === existingThread);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({
      id: existingThread,
      objective: 'Keep notes and opener',
      assignee: { pubkey: juniper },
      openedBy: { pubkey: lunchbox },
    });
    expect(folded[0]!.entries?.some((e) => e.kind === 'note' && e.text === 'Linked note')).toBe(true);
    expect(folded[0]!.attachments?.map((a) => a.name)).toEqual(['Spec']);

    // Standalone non-UUID row normalized to UUID and 3-word hyphenated name
    const migrated = board.items.find((i) => i.title === 'My-Standalone-Backlog');
    expect(migrated?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(migrated?.entries?.some((e) => e.kind === 'note' && e.text === 'Standalone note')).toBe(true);
  });

  it('unwraps bracketed [slug] titles in updateWorkItem and keeps unfinished backlog items alive when linked threads archived unmerged', async () => {
    // 1. updateWorkItem unwraps [slug] and moves trailing prose into empty objective
    const bracketId = randomUUID();
    await updateWorkItem(
      db,
      {
        roomId: chat,
        id: bracketId,
        title: '[verify-provider-recovery] Measure recovery latency across restarts',
      },
      lunchbox,
    );
    const created = (await readWorkBoard(db, workspace, lunchbox)).items.find((i) => i.id === bracketId)!;
    expect(created).toMatchObject({
      id: bracketId,
      title: 'verify-provider-recovery',
      objective: 'Measure recovery latency across restarts',
      state: 'backlog',
    });

    // Explicit objective is preserved when title is bracketed
    const explicitId = randomUUID();
    await updateWorkItem(
      db,
      {
        roomId: chat,
        id: explicitId,
        title: '[audit-token-refresh] Trailing ignored',
        objective: 'Keep explicit objective.',
      },
      lunchbox,
    );
    expect((await readWorkBoard(db, workspace, lunchbox)).items.find((i) => i.id === explicitId)).toMatchObject({
      title: 'audit-token-refresh',
      objective: 'Keep explicit objective.',
    });

    // 2. Migration keeps state='backlog' items whose linked threads archived unmerged alive in Backlog,
    //    while folding landed threads into Done without duplicates
    const archivedUnmerged = randomUUID();
    const landedThread = randomUUID();
    await db.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name,created_by,archived_at) VALUES
         ($1,$3,$4,'verify-provider-recovery',$5,now()),
         ($2,$3,$4,'ship-queue-fix',$5,now())`,
      [archivedUnmerged, landedThread, workspace, chat, ruby],
    );
    await db.query(
      `INSERT INTO corner_facts(corner_id,machine) VALUES($1,'{"state":"archived"}'::jsonb),($2,'{"state":"archived"}'::jsonb)`,
      [archivedUnmerged, landedThread],
    );
    await db.query(
      `INSERT INTO work_items(id,room_id,state,title,objective,assignee_id,opened_by) VALUES
         ('emberus-unfinished',$1,'backlog','[verify-provider-recovery] Measure recovery after crash',NULL,$2,$3),
         ('emberus-landed',$1,'done','[ship-queue-fix] Fix stuck queue',NULL,$2,$3)`,
      [chat, ruby, lunchbox],
    );
    await db.query(
      `INSERT INTO work_item_threads(work_item_id,thread_id,landed) VALUES
         ('emberus-unfinished',$1,false),
         ('emberus-landed',$2,true)`,
      [archivedUnmerged, landedThread],
    );
    await db.query(
      `INSERT INTO work_item_entries(work_item_id,author_id,kind,text) VALUES
         ('emberus-unfinished',$1,'note','Still needs real test'),
         ('emberus-landed',$1,'note','Merged cleanly')`,
      [lunchbox],
    );
    const unrelatedThread = randomUUID();
    // Record the original opening card, then rename the linked thread before migration.
    await db.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,system_event)
       VALUES('open-card-1',$1,$2,'@ruby opened a corner verify-provider-recovery','card','daemon-fact',$3::jsonb,$4::jsonb)`,
      [
        chat,
        ruby,
        JSON.stringify({ type: 'corner-open', cornerId: archivedUnmerged, name: 'verify-provider-recovery' }),
        JSON.stringify({ kind: 'corner-opened', object: { text: 'verify-provider-recovery', id: archivedUnmerged } }),
      ],
    );
    await db.query(`UPDATE rooms SET name='provider-recovery-renamed' WHERE id=$1`, [archivedUnmerged]);
    await db.query(
      `INSERT INTO work_item_attachments(work_item_id,kind,name,url,added_by) VALUES
         ('emberus-unfinished','link','Thread: verify-provider-recovery',$1,$3),
         ('emberus-unfinished','link','Thread: custom-bookmark',$1,$3),
         ('emberus-unfinished','link','Thread: unrelated-design',$4,$3),
         ('emberus-unfinished','link','Prior thread note',$1,$3),
         ('emberus-unfinished','link','Runbook','https://example.org/runbook',$3),
         ('emberus-landed','link','Thread: ship-queue-fix',$2,$3)`,
      [
        `https://web.usebeeline.app/beeline/chat/${archivedUnmerged}?communityId=${workspace}`,
        `https://web.usebeeline.app/beeline/chat/${landedThread}?communityId=${workspace}`,
        lunchbox,
        `https://web.usebeeline.app/beeline/chat/${unrelatedThread}?communityId=${workspace}`,
      ],
    );
    // Standalone task with a user-added Thread: link to an unrelated thread must also keep its link.
    const standaloneLinkTask = randomUUID();
    await updateWorkItem(
      db,
      {
        roomId: chat,
        id: standaloneLinkTask,
        title: 'keep-user-links',
        attachments: [
          {
            kind: 'link',
            name: 'Thread: unrelated-design',
            url: `https://web.usebeeline.app/beeline/chat/${unrelatedThread}?communityId=${workspace}`,
          },
        ],
      },
      lunchbox,
    );

    await unifyWorkItemsAndThreads(db);
    await unifyWorkItemsAndThreads(db);

    expect((await db.query('SELECT 1 FROM work_item_threads')).rowCount).toBe(0);
    const board = await readWorkBoard(db, workspace, lunchbox);
    const unfinished = board.items.find(
      (i) => i.state === 'backlog' && i.title === 'verify-provider-recovery' && i.id !== bracketId,
    );
    expect(unfinished).toMatchObject({
      roomId: chat,
      title: 'verify-provider-recovery',
      objective: 'Measure recovery after crash',
      state: 'backlog',
    });
    expect(unfinished!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(unfinished!.entries?.some((e) => e.kind === 'note' && e.text === 'Still needs real test')).toBe(true);
    expect(unfinished!.attachments?.map((a) => a.name).sort()).toEqual([
      'Prior thread note',
      'Runbook',
      'Thread: custom-bookmark',
      'Thread: unrelated-design',
    ]);
    expect(
      board.items.find((i) => i.id === standaloneLinkTask)?.attachments?.map((a) => a.name),
    ).toEqual(['Thread: unrelated-design']);

    const landed = board.items.filter((i) => i.id === landedThread);
    expect(landed).toHaveLength(1);
    expect(landed[0]).toMatchObject({
      id: landedThread,
      title: 'ship-queue-fix',
      objective: 'Fix stuck queue',
      state: 'done',
      roomArchived: true,
    });
    expect(landed[0]!.entries?.some((e) => e.kind === 'note' && e.text === 'Merged cleanly')).toBe(true);
    expect(landed[0]!.attachments).toEqual([]);
  });

  it('settles a repo-less promoted thread cleanly to Done on close_thread without bouncing back to Backlog', async () => {
    const taskId = randomUUID();
    await updateWorkItem(
      db,
      { roomId: otherChat, id: taskId, title: 'audit-ops-checklist', objective: 'Run ops audit.', assigneeId: '@ruby' },
      lunchbox,
    );
    await updateWorkItem(db, { roomId: otherChat, id: taskId, state: 'in-progress' }, lunchbox);
    expect((await readWorkBoard(db, workspace, lunchbox)).items.find((i) => i.id === taskId)).toMatchObject({
      id: taskId,
      roomId: taskId,
      title: 'audit-ops-checklist',
      state: 'in-progress',
    });
    await daemon.execute('archiveCorner', { cornerId: taskId }, ruby);
    const settled = (await readWorkBoard(db, workspace, lunchbox)).items.filter((i) => i.id === taskId);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      id: taskId,
      title: 'audit-ops-checklist',
      state: 'done',
      roomArchived: true,
    });
  });

  it('exposes listWorkItems by chat, DM/workspace, and state, and attaches open backlog tasks to room commands', async () => {
    const tChat = randomUUID();
    const tOther = randomUUID();
    await updateWorkItem(db, { roomId: chat, id: tChat, title: 'chat-task', objective: 'In beeline.', assigneeId: '@juniper' }, lunchbox);
    await updateWorkItem(db, { roomId: otherChat, id: tOther, title: 'ops-task', objective: 'In ops.' }, lunchbox);

    const chatTasks = await readWorkItemsForAgent(db, ruby, { roomId: chat, state: 'backlog' });
    expect(chatTasks.tasks.map((t) => t.id)).toEqual([tChat]);

    const dmTasks = await readWorkItemsForAgent(db, ruby, { roomId: dm });
    expect(dmTasks.tasks.map((t) => t.id).sort()).toEqual([tChat, tOther].sort());

    const wsTasks = await daemon.execute('listWorkItems', {}, ruby);
    expect(wsTasks.tasks.map((t) => t.id).sort()).toEqual([tChat, tOther].sort());

    const openBacklog = await readOpenBacklogTasks(db, chat, ruby, 15);
    expect(openBacklog).toEqual([
      { id: tChat, title: 'chat-task', objective: 'In beeline.', assigneeHandle: 'juniper', assigneeName: 'Juniper' },
    ]);

    await createAgentCommand(db, {
      roomId: chat,
      agentId: ruby,
      sourceMessageId: null,
      privatePayload: { kind: 'message', authorId: lunchbox, fromRoomId: chat, text: modelText('Check tasks') },
      reason: 'human_tag',
    });
    const delivered = await readAgentCommands(db, ruby, chat);
    expect(delivered.commands[0]?.tasks).toEqual(openBacklog);
  });
});

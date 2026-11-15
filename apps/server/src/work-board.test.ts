import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { askOwnerQuestion } from './work-questions.js';
import { readWorkBoard, updateWorkItem } from './work-board.js';

const person = 'a'.repeat(64),
  agent = 'b'.repeat(64),
  other = 'c'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const chat = '22222222-2222-4222-8222-222222222222';
const thread = '33333333-3333-4333-8333-333333333333';
const dm = '44444444-4444-4444-8444-444444444444';
let db: PgliteDatabase;
let phone: PhoneService;
beforeEach(async () => {
  db = await migratedDatabase();
  phone = new PhoneService(db, 'https://server.example');
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Ada','ada'),($2,'agent','Jellybean','jellybean'),($3,'human','Juniper','juniper')`,
    [person, agent, other],
  );
  await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agent, person]);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Tubing Crew')", [workspace]);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$3,NULL,'beeline',$4),($2,$3,$1,'latency-coverage',$4)`,
    [chat, thread, workspace, agent],
  );
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,direct_participants,created_by) VALUES($1,$2,'DM',$3::jsonb,$4)`,
    [dm, workspace, JSON.stringify([person, agent]), agent],
  );
  for (const identity of [person, agent, other])
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'owner'),($1,$2,$3,'member'),($1,$4,$3,'member')`,
      [workspace, chat, identity, dm],
    );
});
afterEach(async () => {
  await db.close();
});
const read = () => readWorkBoard(db, workspace, person);

describe('Work board recorded sources and single assignee', () => {
  it('creates typed choices, preserves the recommendation, and quotes a choice answer in its thread', async () => {
    const posted = await askOwnerQuestion(
      db,
      {
        about: { kind: 'thread', roomId: thread },
        question: 'Which surface should Milo do next?',
        options: [
          { label: 'Web', recommended: true },
          { label: 'Web and phone' },
          { label: 'Phone' },
        ],
      },
      agent,
    );
    const before = await read();
    const card = before.items.find((item) => item.messageId === posted.messageId)!;
    expect(card.ask?.approval?.subject).toBe('Which surface should Milo do next?');
    expect(card.assignee?.pubkey).toBe(person);
    expect(card.state).toBe('needs-you');
    expect(card.recommendedOptionId).toBe(
      card.ask!.approval!.actions![0]!.kind === 'choice'
        ? (card.ask!.approval!.actions![0] as { optionId: string }).optionId
        : '',
    );
    const option = card.ask!.approval!.actions!.find((a) => a.kind === 'choice')!;
    if (option.kind !== 'choice') throw new Error('choice missing');
    await phone.execute(
      'answerChoice',
      { choiceId: option.choiceId, optionId: option.optionId },
      person,
    );
    const answer = (
      await db.query<{ reply_to_message_id: string }>(
        `SELECT reply_to_message_id FROM messages WHERE card_type='choice-answered'`,
      )
    ).rows[0];
    expect(answer?.reply_to_message_id).toBe(posted.messageId);
    const after = await read();
    expect(after.items.some((item) => item.messageId === posted.messageId && item.ask)).toBe(false);
    expect(after.items.find((item) => item.id === posted.messageId)?.assignee?.pubkey).toBe(agent);
    expect(after.items.find((item) => item.id === posted.messageId)?.state).toBe('in-progress');
  });
  it('posts an inline free-text quote reply and hands the ball back', async () => {
    const posted = await askOwnerQuestion(
      db,
      {
        about: { kind: 'thread', roomId: thread },
        question: 'What should Jellybean verify before the next run?',
        freeText: true,
      },
      agent,
    );
    expect(
      (await read()).items.find((item) => item.messageId === posted.messageId)?.ask?.text,
    ).toBe('What should Jellybean verify before the next run?');
    await phone.execute(
      'sendRoomReply',
      {
        roomId: thread,
        parentMessageId: posted.messageId,
        text: '@jellybean Check the phone reply path first.',
      },
      person,
    );
    const after = await read();
    expect(
      (
        await db.query(
          `SELECT id FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND reason='human_tag'`,
          [thread, agent],
        )
      ).rowCount,
    ).toBe(1);
    expect(after.items.find((item) => item.id === posted.messageId)?.assignee?.pubkey).toBe(agent);
    expect(
      (await db.query('SELECT id FROM messages WHERE reply_to_message_id=$1', [posted.messageId]))
        .rowCount,
    ).toBe(1);
  });
  it('keeps DM asks in Needs you while the Chat filter lists chats only', async () => {
    const posted = await askOwnerQuestion(
      db,
      {
        about: { kind: 'request', roomId: dm, messageId: 'source' },
        question: 'Name the latency handoff recipient',
        freeText: true,
      },
      agent,
    );
    const board = await read();
    expect(board.items.find((item) => item.messageId === posted.messageId)?.ask?.roomKind).toBe(
      'direct',
    );
    expect(board.chats.map((c) => c.id)).toEqual([chat]);
    await phone.execute(
      'sendRoomReply',
      {
        roomId: dm,
        parentMessageId: posted.messageId,
        text: '@jellybean Send the handoff to Juniper.',
      },
      person,
    );
    const handedBack = (await read()).items.find((item) => item.id === posted.messageId);
    expect(handedBack).toMatchObject({
      roomId: dm,
      roomKind: 'direct',
      state: 'in-progress',
      title: 'Name the latency handoff recipient',
      assignee: { pubkey: agent },
      messageId: posted.messageId,
    });
    expect(handedBack?.ask).toBeUndefined();
  });
  it('lets another member assign and reprioritize, sorts, and omits Done older than seven days', async () => {
    await updateWorkItem(
      db,
      { roomId: thread, state: 'done', priority: 'urgent', assigneeId: other },
      agent,
    );
    let board = await read();
    expect(board.items[0]?.assignee?.pubkey).toBe(other);
    expect(board.items[0]?.openedBy.pubkey).toBe(agent);
    await updateWorkItem(db, { roomId: thread, assigneeId: null }, other);
    board = await read();
    expect(board.items[0]?.assignee).toBeNull();
    expect(board.items[0]?.state).toBe('done');
    await db.query(`UPDATE work_items SET completed_at=now()-interval '8 days' WHERE room_id=$1`, [
      thread,
    ]);
    expect((await read()).items.some((item) => item.state === 'done')).toBe(false);
    expect((await db.query('SELECT room_id FROM work_items')).rowCount).toBe(1);
  });
  it('moves the single question assignee to another person without duplicating the ask', async () => {
    const posted = await askOwnerQuestion(
      db,
      {
        about: { kind: 'thread', roomId: thread },
        question: 'Which surface?',
        options: [{ label: 'Web' }, { label: 'Phone' }],
      },
      agent,
    );
    await updateWorkItem(db, { id: posted.messageId, roomId: thread, assigneeId: other }, agent);
    expect(
      (await read()).items.some((item) => item.messageId === posted.messageId && item.ask),
    ).toBe(false);
    const assigned = await readWorkBoard(db, workspace, other);
    expect(
      assigned.items.find((item) => item.messageId === posted.messageId)?.assignee?.pubkey,
    ).toBe(other);
    expect((await phone.execute('countNeedsYou', { workspaceId: workspace }, other)).count).toBe(1);
    expect((await phone.execute('countNeedsYou', { workspaceId: workspace }, person)).count).toBe(
      0,
    );
  });
  it('assigns a legacy tagged ask independently of its original mention', async () => {
    const messageId = 'd'.repeat(64);
    await db.query(
      "INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@ada Can you verify phone latency?')",
      [messageId, thread, agent],
    );
    expect((await read()).items.find((item) => item.id === messageId)?.ask).toBeDefined();
    await updateWorkItem(db, { id: messageId, roomId: thread, assigneeId: other }, agent);
    expect((await read()).items.find((item) => item.id === messageId)?.ask).toBeUndefined();
    const assigned = await readWorkBoard(db, workspace, other);
    expect(assigned.items.find((item) => item.id === messageId)?.ask).toBeDefined();
    expect(assigned.items.find((item) => item.id === messageId)?.openedBy.pubkey).toBe(agent);
  });
  it('projects an archived working thread as Done for seven days', async () => {
    await updateWorkItem(db, { roomId: thread, state: 'in-progress', assigneeId: agent }, agent);
    await db.query('UPDATE rooms SET archived_at=now() WHERE id=$1', [thread]);
    expect((await read()).items.find((item) => item.id === thread)?.state).toBe('done');
    await db.query("UPDATE rooms SET archived_at=now()-interval '8 days' WHERE id=$1", [thread]);
    expect((await read()).items.find((item) => item.id === thread)).toBeUndefined();
    expect((await db.query('SELECT id FROM work_items WHERE room_id=$1', [thread])).rowCount).toBe(
      1,
    );
  });
  it('refuses overlong fields with a shortening error, before writing a message', async () => {
    await expect(
      askOwnerQuestion(
        db,
        {
          about: { kind: 'thread', roomId: thread },
          question: Array(21).fill('word').join(' '),
          freeText: true,
        },
        agent,
      ),
    ).rejects.toThrow('Shorten question');
    await expect(
      askOwnerQuestion(
        db,
        {
          about: { kind: 'thread', roomId: thread },
          question: 'Which surface?',
          options: [{ label: 'One two three four' }, { label: 'Phone' }],
        },
        agent,
      ),
    ).rejects.toThrow('Shorten options');
    expect((await db.query('SELECT message_id FROM work_questions')).rowCount).toBe(0);
  });
  it('keeps independent questions and ongoing work in the same thread', async () => {
    await updateWorkItem(
      db,
      { roomId: thread, state: 'in-progress', priority: 'high', assigneeId: agent },
      agent,
    );
    const input = {
      about: { kind: 'thread' as const, roomId: thread },
      question: 'Which surface?',
      options: [{ label: 'Web' }, { label: 'Phone' }],
    };
    const first = await askOwnerQuestion(db, input, agent),
      second = await askOwnerQuestion(db, input, agent);
    const before = await read();
    expect(before.items.find((item) => item.id === thread)?.state).toBe('in-progress');
    expect(before.items.filter((item) => item.ask)).toHaveLength(2);
    const option = before.items.find((item) => item.id === first.messageId)!.ask!.approval!
      .actions![0]!;
    if (option.kind !== 'choice') throw new Error('choice missing');
    await phone.execute(
      'answerChoice',
      { choiceId: option.choiceId, optionId: option.optionId },
      person,
    );
    const after = await read();
    expect(after.items.find((item) => item.id === second.messageId)?.ask).toBeDefined();
    expect(after.items.find((item) => item.id === first.messageId)?.assignee?.pubkey).toBe(agent);
    expect(after.items.find((item) => item.id === thread)?.state).toBe('in-progress');
  });
  it('does not let a task id change a different conversation', async () => {
    const privateRoom = '55555555-5555-4555-8555-555555555555';
    await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Private')", [
      privateRoom,
      workspace,
    ]);
    await db.query(
      "INSERT INTO work_items(id,room_id,state,opened_by) VALUES('private-task',$1,'backlog',$2)",
      [privateRoom, other],
    );
    await expect(
      updateWorkItem(db, { id: 'private-task', roomId: thread, state: 'done' }, person),
    ).rejects.toThrow('room access denied');
    expect(
      (await db.query<{ state: string }>("SELECT state FROM work_items WHERE id='private-task'"))
        .rows[0]?.state,
    ).toBe('backlog');
  });
  it('does not add a per-agent open-question gate', async () => {
    const input = {
      about: { kind: 'thread' as const, roomId: thread },
      question: 'Which surface?',
      options: [{ label: 'Web' }, { label: 'Phone' }],
    };
    await askOwnerQuestion(db, input, agent);
    await askOwnerQuestion(db, input, agent);
    expect(
      (await read()).items.filter((item) => item.ask?.approval?.kind === 'choice'),
    ).toHaveLength(2);
  });
});

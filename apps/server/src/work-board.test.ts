import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { readMediaMetadata } from './phone-media.js';
import { PhoneService } from './phone-service.js';
import { askOwnerQuestion } from './work-questions.js';
import { readWorkBoard, readWorkThread, updateWorkItem } from './work-board.js';

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
const stored = async (id: string) =>
  (
    await db.query<{ state: string; assignee_id: string | null }>(
      'SELECT state,assignee_id FROM work_items WHERE id=$1',
      [id],
    )
  ).rows[0];
const machine = (corner: string, state: string) =>
  db.query(
    `INSERT INTO corner_facts(corner_id,machine) VALUES($1,$2::jsonb)
     ON CONFLICT(corner_id) DO UPDATE SET machine=EXCLUDED.machine`,
    [corner, JSON.stringify({ state })],
  );

describe('work item detail', () => {
  const address = { roomId: chat, id: 'detail-task' };
  const create = () => updateWorkItem(db, { ...address, title: 'youtube-pipeline', objective: 'Private videos until approved.', assigneeId: null }, agent);
  it('records real creation, assignment and state changes once, with the actor', async () => {
    await create();
    await updateWorkItem(db, { ...address, assigneeId: agent }, person);
    await updateWorkItem(db, { ...address, state: 'in-progress' }, other);
    await updateWorkItem(db, { ...address, state: 'in-progress', assigneeId: agent }, person);
    const item = (await read()).items.find(i => i.id === address.id)!;
    expect(item.entries?.map(e => [e.kind, e.author.pubkey, e.text])).toEqual([
      ['event', agent, 'created this item in Backlog'],
      ['event', person, 'assigned this to Jellybean'],
      ['event', other, 'moved this to In progress'],
    ]);
  });
  it('lets a human and agent append plain notes without starting a conversation', async () => {
    await create();
    await phone.execute('addWorkNote', { ...address, text: '  Hold until approved.  ' }, person);
    await phone.execute('addWorkNote', { ...address, text: 'Waiting on owner approval.' }, agent);
    await phone.execute('addWorkNote', { ...address, text: '   ' }, person);
    await updateWorkItem(db, { ...address, state: 'done' }, agent);
    const item = (await read()).items.find(i => i.id === address.id)!;
    expect(item.entries?.filter(e => e.kind === 'note').map(e => [e.author.pubkey, e.text])).toEqual([
      [person, 'Hold until approved.'], [agent, 'Waiting on owner approval.'],
    ]);
    expect((await db.query('SELECT id FROM messages')).rows).toEqual([]);
    expect((await db.query('SELECT id FROM agent_commands')).rows).toEqual([]);
  });
  it('attaches existing file objects and links, and shares file metadata only with current members', async () => {
    await create();
    const objectId = '77777777-7777-4777-8777-777777777777';
    await db.query(`INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
      VALUES($1,$2,'media','detail-proof','application/pdf','channel-plan.pdf',123,$3,'ready',now()+interval '1 day')`,
      [objectId, person, 'f'.repeat(64)]);
    await phone.execute('attachToWorkItem', { ...address, attachment: { kind: 'file', name: 'channel-plan.pdf', objectId } }, person);
    await phone.execute('attachToWorkItem', { ...address, attachment: { kind: 'link', name: 'Plan', url: 'https://example.org/plan' } }, agent);
    const item = (await read()).items.find(i => i.id === address.id)!;
    expect(item.attachments).toMatchObject([
      { kind: 'file', name: 'channel-plan.pdf', addedBy: { pubkey: person }, file: { mimeType: 'application/pdf', size: 123 } },
      { kind: 'link', url: 'https://example.org/plan', addedBy: { pubkey: agent } },
    ]);
    expect(await readMediaMetadata(db, objectId, other)).toMatchObject({ objectId, size: 123 });
    await db.query('UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id=$2', [other, chat]);
    await expect(readMediaMetadata(db, objectId, other)).rejects.toThrow();
    await expect(phone.execute('addWorkNote', { ...address, text: 'No access' }, other)).rejects.toThrow('room access denied');
    await expect(phone.execute('attachToWorkItem', { ...address, attachment: { kind: 'link', name: 'No access', url: 'https://example.org' } }, other)).rejects.toThrow('room access denied');
  });
  it('rejects cross-conversation ids and unseen objects without adding detail', async () => {
    await create();
    await expect(phone.execute('addWorkNote', { roomId: thread, id: address.id, text: 'Wrong place' }, person)).rejects.toThrow('room access denied');
    const objectId = '77777777-7777-4777-8777-777777777777';
    await db.query(`INSERT INTO objects(id,owner_id,kind,key,mime,size,sha256,state,expires_at)
      VALUES($1,$2,'media','private-proof','application/pdf',123,$3,'ready',now()+interval '1 day')`,
      [objectId, other, 'f'.repeat(64)]);
    await expect(phone.execute('attachToWorkItem', { ...address, attachment: { kind: 'file', name: 'private.pdf', objectId } }, person)).rejects.toThrow();
    await expect(phone.execute('attachToWorkItem', { ...address, attachment: { kind: 'link', name: 'Script', url: 'javascript:alert(1)' } }, person)).rejects.toThrow();
    expect((await read()).items.find(i => i.id === address.id)?.attachments).toEqual([]);
  });
  it('keeps asking-item notes on that item rather than the thread task', async () => {
    const posted = await askOwnerQuestion(db, { about: { kind: 'thread', roomId: thread }, question: 'Which surface?', freeText: true }, agent);
    await phone.execute('addWorkNote', { roomId: thread, id: posted.messageId, text: 'Phone first.' }, person);
    const ask = (await read()).items.find(item => item.id === posted.messageId)!;
    expect(ask.entries?.some(entry => entry.text === 'Phone first.')).toBe(true);
    expect(ask.ask?.text).toBe('Which surface?');
    expect((await readWorkThread(db, thread, person))[0]?.entries).toEqual([]);
  });
  it('materializes a thread task for notes and returns bounded chronological tails', async () => {
    await phone.execute('addWorkNote', { roomId: thread, text: 'Thread note' }, person);
    await db.query(`INSERT INTO work_item_entries(work_item_id,author_id,kind,text,created_at)
      SELECT $1,$2,'note',n::text,now()+n*interval '1 second' FROM generate_series(1,105) n`, [thread, agent]);
    const [item] = await readWorkThread(db, thread, person);
    expect(item?.entries).toHaveLength(100);
    expect(item?.entries?.[0]?.text).toBe('6');
    expect(item?.entries?.at(-1)?.text).toBe('105');
    expect(item).toEqual((await read()).items.find(i => i.id === thread));
  });
});

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
    expect(after.items.some((item) => item.ask)).toBe(false);
    // An ask is never a task row of its own; the thread returns to In progress.
    expect(after.items.some((item) => item.id === posted.messageId)).toBe(false);
    expect(after.items.find((item) => item.id === thread)?.state).toBe('in-progress');
    expect(await stored(posted.messageId)).toEqual({ state: 'in-progress', assignee_id: agent });
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
    expect(after.items.some((item) => item.ask)).toBe(false);
    expect(
      (
        await db.query(
          `SELECT id FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND reason='human_tag'`,
          [thread, agent],
        )
      ).rowCount,
    ).toBe(1);
    expect((await stored(posted.messageId))?.assignee_id).toBe(agent);
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
    expect((await read()).items.some((item) => item.roomId === dm)).toBe(false);
    expect(await stored(posted.messageId)).toEqual({ state: 'in-progress', assignee_id: agent });
  });
  it('lets another member assign and omits Done older than seven days', async () => {
    await updateWorkItem(db, { roomId: thread, state: 'done', assigneeId: other }, agent);
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
    expect(assigned.items.filter((item) => item.roomId === thread)).toHaveLength(1);
    expect((await phone.execute('countNeedsYou', { workspaceId: workspace }, other)).count).toBe(1);
    expect((await phone.execute('countNeedsYou', { workspaceId: workspace }, person)).count).toBe(
      0,
    );
  });
  it('never puts a plain mention or keyword in Needs you, only reports addressed to the viewer', async () => {
    await db.query(
      `INSERT INTO messages(id,room_id,author_id,text,card) VALUES
        ($1,$2,$4,'@ada Can you verify phone latency? Please approve.',NULL),
        ($3,$2,$4,'blocked: Phone latency needs a signed build.',jsonb_build_object('reportToId',$5::text))`,
      ['d'.repeat(64), thread, 'e'.repeat(64), agent, person],
    );
    const board = await read();
    expect(board.items.filter((item) => item.ask).map((item) => item.ask!.messageId)).toEqual([
      'e'.repeat(64),
    ]);
    expect(board.items.find((item) => item.ask)?.ask?.text).toBe(
      'Phone latency needs a signed build.',
    );
    expect((await readWorkBoard(db, workspace, other)).items.some((item) => item.ask)).toBe(false);
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
    await updateWorkItem(db, { roomId: thread, state: 'in-progress', assigneeId: agent }, agent);
    const input = {
      about: { kind: 'thread' as const, roomId: thread },
      question: 'Which surface?',
      options: [{ label: 'Web' }, { label: 'Phone' }],
    };
    const first = await askOwnerQuestion(db, input, agent),
      second = await askOwnerQuestion(db, input, agent);
    const before = await read();
    // One row per thread: the thread itself, carrying both asks.
    const row = before.items.filter((item) => item.ask);
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ roomId: thread, askIds: [first.messageId, second.messageId] });
    expect(before.items.some((item) => item.id === thread)).toBe(false);
    const option = row[0]!.ask!.approval!.actions![0]!;
    if (option.kind !== 'choice') throw new Error('choice missing');
    await phone.execute(
      'answerChoice',
      { choiceId: option.choiceId, optionId: option.optionId },
      person,
    );
    const after = await read();
    expect(after.items.find((item) => item.ask)?.askIds).toEqual([second.messageId]);
    expect((await stored(first.messageId))?.assignee_id).toBe(agent);
    await phone.execute('clearNeedsYou', { workspaceId: workspace, messageId: second.messageId }, person);
    const cleared = await read();
    expect(cleared.items.some((item) => item.ask)).toBe(false);
    expect(cleared.items.find((item) => item.id === thread)?.state).toBe('in-progress');
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
    expect((await read()).items.find((item) => item.ask)?.askIds).toHaveLength(2);
    await phone.execute('clearNeedsYouSection', { workspaceId: workspace }, person);
    expect((await read()).items.some((item) => item.ask)).toBe(false);
  });
  it('keeps idle threads In progress after active ones; Backlog holds only stored not-started work', async () => {
    const idle = '66666666-6666-4666-8666-666666666666';
    await db.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'release-corner',$4)`,
      [idle, workspace, chat, agent],
    );
    await machine(thread, 'working');
    await machine(idle, 'idle');
    await updateWorkItem(db, { id: 'later', roomId: chat, title: 'youtube-pipeline' }, agent);
    const board = await read();
    const progress = board.items.filter((item) => item.state === 'in-progress');
    expect(progress.map((item) => [item.title, item.idle ?? false])).toEqual([
      ['latency-coverage', false],
      ['release-corner', true],
    ]);
    expect(board.items.filter((item) => item.state === 'backlog').map((item) => item.title)).toEqual([
      'youtube-pipeline',
    ]);
    expect(board.items.every((item) => item.priority === 'none')).toBe(true);
    await machine(thread, 'review');
    expect((await read()).items.find((item) => item.id === thread)).toMatchObject({
      state: 'in-review',
    });
  });
  it('leaves a standing (locked) corner off the board while its stored tasks stay', async () => {
    await machine(thread, 'idle');
    await db.query('UPDATE corner_facts SET locked=true WHERE corner_id=$1', [thread]);
    await updateWorkItem(db, { id: 'standing-task', roomId: thread, title: 'youtube-pipeline' }, agent);
    expect((await read()).items.map((item) => item.id)).toEqual(['standing-task']);
  });
  it('carries a started item objective into its thread and shows it only in details', async () => {
    await updateWorkItem(
      db,
      { id: 'pipeline', roomId: chat, title: 'youtube-pipeline', objective: 'Upload private videos.' },
      agent,
    );
    expect((await read()).items.find((item) => item.id === 'pipeline')).toMatchObject({
      state: 'backlog',
      objective: 'Upload private videos.',
    });
    await db.query(
      `INSERT INTO corner_brief_revisions(corner_id,revision,content,author_id,source_room_id)
       VALUES($1,1,'Measure latency.',$2,$3)`,
      [thread, agent, chat],
    );
    await updateWorkItem(
      db,
      { id: 'measure', roomId: thread, title: 'measure', objective: 'Measure reply latency.' },
      agent,
    );
    expect((await read()).items.find((item) => item.id === thread)?.objective).toBeUndefined();
    await updateWorkItem(db, { id: 'measure', roomId: thread, state: 'in-progress' }, agent);
    expect((await read()).items.find((item) => item.id === thread)?.objective).toBe(
      'Measure reply latency.',
    );
  });
  it('gives the thread header the same idle state and objective as the board', async () => {
    await machine(thread, 'idle');
    await updateWorkItem(db, { roomId: thread, objective: 'Measure reply latency.' }, agent);
    const [header] = await readWorkThread(db, thread, person);
    expect(header).toMatchObject({ id: thread, state: 'in-progress', idle: true, objective: 'Measure reply latency.' });
    expect(header).toEqual((await read()).items.find((item) => item.id === thread));
    expect(await readWorkThread(db, chat, person)).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { sendMessage } from './agent-messaging.js';
import { agentOpenAsks, closeAgentAsk } from './agent-open-asks.js';
import { postRoomChoice } from './room-choice.js';
import { askOwnerQuestion } from './work-questions.js';
import { updateWorkItem } from './work-board.js';

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

describe('question retirement', () => {
  const tasks = async () =>
    (await phone.execute('readNeedsYou', { workspaceId: workspace }, person)).items.map(
      (item) => item.messageId,
    );
  const retirement = async (id: string) =>
    (
      await db.query(
        'SELECT cleared_reason,cleared_at IS NOT NULL cleared FROM needs_you_marks WHERE message_id=$1 AND identity_id=$2',
        [id, person],
      )
    ).rows;

  it.each([true, false])(
    'tracks owner questions and agent closure, options=%s',
    async (options) => {
      const { messageId } = await askOwnerQuestion(
        db,
        {
          about: { kind: 'thread', roomId: thread },
          question: 'Which surface?',
          ...(options ? { options: [{ label: 'Web' }, { label: 'Phone' }] } : { freeText: true }),
        },
        agent,
      );
      expect(await tasks()).toEqual([messageId]);
      expect((await agentOpenAsks(db, agent, chat)).text).toContain(messageId);
      expect(await closeAgentAsk(db, agent, { messageId, reason: 'withdrawn' })).toEqual({
        closed: 1,
      });
      expect(await retirement(messageId)).toEqual([{ cleared_reason: 'withdrawn', cleared: true }]);
      expect(await tasks()).toEqual([]);
      expect((await agentOpenAsks(db, agent, chat)).text).toBe('');
    },
  );

  it.each([true, false])(
    'preserves unanswered questions through reassignment, options=%s',
    async (options) => {
      const { messageId } = await askOwnerQuestion(
        db,
        {
          about: { kind: 'thread', roomId: thread },
          question: 'Which surface?',
          ...(options ? { options: [{ label: 'Web' }, { label: 'Phone' }] } : { freeText: true }),
        },
        agent,
      );
      const otherTasks = async () =>
        (await phone.execute('readNeedsYou', { workspaceId: workspace }, other)).items.map(
          (item) => item.messageId,
        );
      const original = await agentOpenAsks(db, agent, chat);
      expect(await tasks()).toEqual([messageId]);
      await updateWorkItem(db, { id: messageId, roomId: thread, assigneeId: other }, person);
      expect(await tasks()).toEqual([]);
      expect(await otherTasks()).toEqual([messageId]);
      const reassigned = await agentOpenAsks(db, agent, chat);
      expect(reassigned.text).toContain('to @juniper:');
      expect(reassigned.text).not.toContain('to @ada:');
      expect(reassigned.version).not.toBe(original.version);
      expect(await retirement(messageId)).toEqual([{ cleared_reason: null, cleared: false }]);
      await updateWorkItem(db, { id: messageId, roomId: thread, assigneeId: null }, person);
      expect(await tasks()).toEqual([]);
      expect(await otherTasks()).toEqual([]);
      expect((await agentOpenAsks(db, agent, chat)).text).toBe('');
      await updateWorkItem(db, { id: messageId, roomId: thread, assigneeId: person }, person);
      expect(await tasks()).toEqual([messageId]);
      expect(await otherTasks()).toEqual([]);
      expect((await agentOpenAsks(db, agent, chat)).version).toBe(original.version);
      await closeAgentAsk(db, agent, { messageId, reason: 'withdrawn' });
      await updateWorkItem(db, { id: messageId, roomId: thread, assigneeId: other }, person);
      await updateWorkItem(db, { id: messageId, roomId: thread, assigneeId: person }, person);
      expect(await tasks()).toEqual([]);
      expect(await retirement(messageId)).toEqual([{ cleared_reason: 'withdrawn', cleared: true }]);
    },
  );

  it.each(
    [true, false].flatMap((options) =>
      [other, null].map((assigneeId) => ({ options, assigneeId })),
    ),
  )(
    'bulk clearing preserves dormant question marks, options=$options assignee=$assigneeId',
    async ({ options, assigneeId }) => {
      const input = {
        about: { kind: 'thread' as const, roomId: thread },
        question: 'Which surface?',
        ...(options ? { options: [{ label: 'Web' }, { label: 'Phone' }] } : { freeText: true }),
      };
      const dormant = await askOwnerQuestion(db, input, agent);
      await updateWorkItem(db, { id: dormant.messageId, roomId: thread, assigneeId }, person);
      const visible = await askOwnerQuestion(db, input, agent);
      expect(await tasks()).toEqual([visible.messageId]);
      await phone.execute('clearNeedsYouSection', { workspaceId: workspace }, person);
      expect(await retirement(visible.messageId)).toEqual([
        { cleared_reason: 'manual', cleared: true },
      ]);
      expect(await retirement(dormant.messageId)).toEqual([
        { cleared_reason: null, cleared: false },
      ]);
      await updateWorkItem(
        db,
        { id: dormant.messageId, roomId: thread, assigneeId: person },
        person,
      );
      expect(await tasks()).toEqual([dormant.messageId]);
      expect((await agentOpenAsks(db, agent, chat)).text).toContain(dormant.messageId);
    },
  );

  it.each(
    [true, false].flatMap((options) =>
      [true, false].map((workspaceAccess) => ({ options, workspaceAccess })),
    ),
  )(
    'records assignments before access is granted, options=$options workspaceAccess=$workspaceAccess',
    async ({ options, workspaceAccess }) => {
      await db.query("UPDATE rooms SET visibility='invite-only' WHERE id=$1", [chat]);
      await phone.execute('removeRoomMember', { roomId: chat, memberId: other }, person);
      if (!workspaceAccess)
        await db.query(
          'UPDATE memberships SET removed_at=now() WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2',
          [workspace, other],
        );
      const { messageId } = await askOwnerQuestion(
        db,
        {
          about: { kind: 'thread', roomId: thread },
          question: 'Which surface?',
          ...(options ? { options: [{ label: 'Web' }, { label: 'Phone' }] } : { freeText: true }),
        },
        agent,
      );
      await updateWorkItem(db, { id: messageId, roomId: thread, assigneeId: other }, person);
      expect(
        (
          await db.query(
            'SELECT cleared_at,cleared_reason FROM needs_you_marks WHERE message_id=$1 AND identity_id=$2',
            [messageId, other],
          )
        ).rows,
      ).toEqual([{ cleared_at: null, cleared_reason: null }]);
      if (workspaceAccess) {
        expect(
          (await phone.execute('readNeedsYou', { workspaceId: workspace }, other)).items,
        ).toEqual([]);
        expect(await phone.execute('countNeedsYou', { workspaceId: workspace }, other)).toEqual({
          count: 0,
        });
      } else {
        await db.query(
          'UPDATE memberships SET removed_at=NULL WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2',
          [workspace, other],
        );
      }
      await phone.execute('addRoomMember', { roomId: chat, memberId: other }, person);
      expect(
        (await phone.execute('readNeedsYou', { workspaceId: workspace }, other)).items.map(
          (item) => item.messageId,
        ),
      ).toEqual([messageId]);
      expect(await phone.execute('countNeedsYou', { workspaceId: workspace }, other)).toEqual({
        count: 1,
      });
      expect((await agentOpenAsks(db, agent, chat)).text).toContain(messageId);
    },
  );

  it('records an addressed standalone choice before its recipient joins the Room', async () => {
    await db.query("UPDATE rooms SET visibility='invite-only' WHERE id=$1", [chat]);
    await phone.execute('removeRoomMember', { roomId: chat, memberId: other }, person);
    const choice = await postRoomChoice(db, {
      roomId: chat,
      agentId: agent,
      requesterId: person,
      mode: 'question',
      prompt: 'Which surface?',
      options: [
        { label: 'Web' },
        { label: 'Phone' },
      ],
    });
    await db.query(
      `UPDATE messages SET card=jsonb_set(card,'{mentionIds}',to_jsonb(ARRAY[$2::text])) WHERE id=$1`,
      [choice.messageId, other],
    );
    expect(
      (
        await db.query(
          'SELECT cleared_at FROM needs_you_marks WHERE message_id=$1 AND identity_id=$2',
          [choice.messageId, other],
        )
      ).rows,
    ).toEqual([{ cleared_at: null }]);
    expect((await phone.execute('readNeedsYou', { workspaceId: workspace }, other)).items).toEqual(
      [],
    );
    await phone.execute('addRoomMember', { roomId: chat, memberId: other }, person);
    expect(
      (await phone.execute('readNeedsYou', { workspaceId: workspace }, other)).items.map(
        (item) => item.messageId,
      ),
    ).toEqual([choice.messageId]);
  });

  it.each(
    [true, false].flatMap((options) =>
      (['answered', 'withdrawn', 'superseded'] as const).map((reason) => ({ options, reason })),
    ),
  )(
    'keeps agent closure for a first-time assignee, options=$options reason=$reason',
    async ({ options, reason }) => {
      const { messageId } = await askOwnerQuestion(
        db,
        {
          about: { kind: 'thread', roomId: thread },
          question: 'Which surface?',
          ...(options ? { options: [{ label: 'Web' }, { label: 'Phone' }] } : { freeText: true }),
        },
        agent,
      );
      expect(await tasks()).toEqual([messageId]);
      expect(
        (
          await db.query('SELECT 1 FROM needs_you_marks WHERE message_id=$1 AND identity_id=$2', [
            messageId,
            other,
          ])
        ).rowCount,
      ).toBe(0);
      expect(await closeAgentAsk(db, agent, { messageId, reason })).toEqual({ closed: 1 });
      await updateWorkItem(db, { id: messageId, roomId: thread, assigneeId: other }, person);
      expect(
        (await phone.execute('readNeedsYou', { workspaceId: workspace }, other)).items,
      ).toEqual([]);
      expect(await phone.execute('countNeedsYou', { workspaceId: workspace }, other)).toEqual({
        count: 0,
      });
      expect((await agentOpenAsks(db, agent, chat)).text).toBe('');
      expect((await agentOpenAsks(db, agent, null)).text).toBe('');
      expect(
        (
          await db.query(
            'SELECT identity_id,cleared_reason,cleared_at IS NOT NULL cleared FROM needs_you_marks WHERE message_id=$1 ORDER BY identity_id',
            [messageId],
          )
        ).rows,
      ).toEqual([
        { identity_id: person, cleared_reason: reason, cleared: true },
        { identity_id: other, cleared_reason: reason, cleared: true },
      ]);
      expect(await closeAgentAsk(db, agent, { messageId, reason: 'withdrawn' })).toEqual({
        closed: 0,
      });
      expect(
        (await db.query('SELECT ask_closed_reason FROM messages WHERE id=$1', [messageId])).rows,
      ).toEqual([{ ask_closed_reason: reason }]);
    },
  );

  it('preserves standalone choice closure when it is addressed to a new person', async () => {
    const question = await postRoomChoice(db, {
      roomId: dm,
      agentId: agent,
      requesterId: person,
      mode: 'question',
      prompt: 'Which surface?',
      options: [
        { label: 'Web' },
        { label: 'Phone' },
      ],
    });
    await closeAgentAsk(db, agent, { messageId: question.messageId, reason: 'withdrawn' });
    await db.query(
      `UPDATE messages SET card=jsonb_set(card,'{mentionIds}',to_jsonb(ARRAY[$2::text])) WHERE id=$1`,
      [question.messageId, other],
    );
    expect((await phone.execute('readNeedsYou', { workspaceId: workspace }, other)).items).toEqual(
      [],
    );
    expect(
      (
        await db.query(
          'SELECT cleared_reason,cleared_at IS NOT NULL cleared FROM needs_you_marks WHERE message_id=$1 AND identity_id=$2',
          [question.messageId, other],
        )
      ).rows,
    ).toEqual([{ cleared_reason: 'withdrawn', cleared: true }]);
  });

  it('hides reminders after Room access is revoked, including changed private details', async () => {
    await db.query("UPDATE rooms SET visibility='invite-only' WHERE id=$1", [chat]);
    const { messageId } = await askOwnerQuestion(
      db,
      {
        about: { kind: 'thread', roomId: thread },
        question: 'Which surface?',
        freeText: true,
      },
      agent,
    );
    const before = await agentOpenAsks(db, agent, dm);
    expect(before.text).toContain(messageId);
    expect((await agentOpenAsks(db, agent, null)).text).toContain(messageId);
    await phone.execute('removeRoomMember', { roomId: chat, memberId: agent }, person);
    await db.query('UPDATE rooms SET name=$2 WHERE id=$1', [thread, 'Confidential new name']);
    await updateWorkItem(db, { id: messageId, roomId: thread, assigneeId: other }, person);
    for (const roomId of [dm, null]) {
      const after = await agentOpenAsks(db, agent, roomId);
      expect(after.text).toBe('');
      expect(after.version).not.toBe(before.version);
    }
    expect(
      (await phone.execute('readNeedsYou', { workspaceId: workspace }, other)).items.map(
        (item) => item.messageId,
      ),
    ).toEqual([messageId]);
  });

  it.each([true, false])(
    'keeps quote answers terminal for new assignees, options=%s',
    async (options) => {
      const { messageId } = await askOwnerQuestion(
        db,
        {
          about: { kind: 'thread', roomId: thread },
          question: 'Which surface?',
          ...(options ? { options: [{ label: 'Web' }, { label: 'Phone' }] } : { freeText: true }),
        },
        agent,
      );
      const reply = await phone.execute(
        'sendRoomReply',
        { roomId: thread, parentMessageId: messageId, text: 'Use Web.' },
        person,
      );
      expect(await retirement(messageId)).toEqual([{ cleared_reason: 'answered', cleared: true }]);
      await updateWorkItem(db, { id: messageId, roomId: thread, assigneeId: other }, person);
      expect(
        (
          await db.query(
            'SELECT cleared_reason,cleared_at IS NOT NULL cleared FROM needs_you_marks WHERE message_id=$1 AND identity_id=$2',
            [messageId, other],
          )
        ).rows,
      ).toEqual([{ cleared_reason: 'answered', cleared: true }]);
      await db.query('UPDATE messages SET deleted_at=now() WHERE id=$1', [reply.messageId]);
      expect(
        (await phone.execute('readNeedsYou', { workspaceId: workspace }, other)).items,
      ).toEqual([]);
      expect(await phone.execute('countNeedsYou', { workspaceId: workspace }, other)).toEqual({
        count: 0,
      });
      expect((await agentOpenAsks(db, agent, chat)).text).toBe('');
      expect((await agentOpenAsks(db, agent, null)).text).toBe('');
      await updateWorkItem(db, { id: messageId, roomId: thread, assigneeId: person }, person);
      expect(await tasks()).toEqual([]);
    },
  );

  it('settles every recipient of a standalone question when one quote-answers', async () => {
    const question = await postRoomChoice(db, {
      roomId: dm,
      agentId: agent,
      requesterId: person,
      mode: 'question',
      prompt: 'Which surface?',
      options: [
        { label: 'Web' },
        { label: 'Phone' },
      ],
    });
    await db.query(
      `UPDATE messages SET card=jsonb_set(card,'{mentionIds}',to_jsonb($2::text[])) WHERE id=$1`,
      [question.messageId, [person, other]],
    );
    await phone.execute(
      'sendRoomReply',
      { roomId: dm, parentMessageId: question.messageId, text: 'Use Web.' },
      person,
    );
    expect(
      (
        await db.query(
          'SELECT identity_id,cleared_reason FROM needs_you_marks WHERE message_id=$1 AND cleared_at IS NOT NULL ORDER BY identity_id',
          [question.messageId],
        )
      ).rows,
    ).toEqual([
      { identity_id: person, cleared_reason: 'answered' },
      { identity_id: other, cleared_reason: 'answered' },
    ]);
    expect((await phone.execute('readNeedsYou', { workspaceId: workspace }, other)).items).toEqual(
      [],
    );
  });

  it.each(['source-closed', 'superseded', 'answered', 'quote', 'section'] as const)(
    'retires a forwarded question on %s',
    async (event) => {
      const question = await sendMessage(db, {
        route: { from: { agent, place: thread }, to: { agent: person, place: dm } },
        text: 'Which surface?',
        ask: { question: 'Which surface?', options: ['Web', 'Phone'], recommended: 'Web' },
      });
      expect(await tasks()).toEqual([question.id]);
      expect((await agentOpenAsks(db, agent, chat)).text).toContain(question.id);
      if (event === 'source-closed')
        await db.query('UPDATE rooms SET archived_at=now() WHERE id=$1', [thread]);
      if (event === 'superseded')
        await db.query(
          `INSERT INTO messages(id,room_id,author_id,text,card,created_at)
      VALUES('new-report',$1,$2,'shipped',jsonb_build_object('reportStatus','done','reportToId',$3::text,'sourceRoomId',$4::text),now()+interval '1 second')`,
          [dm, agent, person, thread],
        );
      if (event === 'answered') {
        const choice = (
          await db.query<{ id: string; options: { optionId: string }[] }>(
            'SELECT id,options FROM room_choices WHERE message_id=$1',
            [question.id],
          )
        ).rows[0]!;
        await phone.execute(
          'answerChoice',
          { choiceId: choice.id, optionId: choice.options[0]!.optionId },
          person,
        );
      }
      if (event === 'quote') {
        await db.query(
          `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES('ordinary',$1,$2,'Unrelated',now()+interval '1 second')`,
          [dm, person],
        );
        expect(await tasks()).toEqual([question.id]);
        await db.query(
          `INSERT INTO messages(id,room_id,author_id,text,reply_to_message_id,created_at)
        VALUES('quoted',$1,$2,'Web',$3,now()+interval '2 seconds')`,
          [dm, person, question.id],
        );
      }
      if (event === 'section')
        await phone.execute('clearNeedsYouSection', { workspaceId: workspace }, person);
      expect(await retirement(question.id)).toEqual([
        {
          cleared_reason: event === 'quote' ? 'answered' : event === 'section' ? 'manual' : event,
          cleared: true,
        },
      ]);
      expect(await tasks()).toEqual([]);
      expect((await agentOpenAsks(db, agent, chat)).text).toBe('');
    },
  );

  it('tracks addressed standalone choices and preserves their answer reason', async () => {
    const question = await postRoomChoice(db, {
      roomId: dm,
      agentId: agent,
      requesterId: person,
      mode: 'question',
      prompt: 'Which surface?',
      options: [
        { label: 'Web' },
        { label: 'Phone' },
      ],
    });
    expect(await tasks()).toEqual([question.messageId]);
    const choice = (
      await db.query<{ options: { optionId: string }[] }>(
        'SELECT options FROM room_choices WHERE id=$1',
        [question.choiceId],
      )
    ).rows[0]!;
    await phone.execute(
      'answerChoice',
      { choiceId: question.choiceId, optionId: choice.options[0]!.optionId },
      person,
    );
    expect(await retirement(question.messageId)).toEqual([
      { cleared_reason: 'answered', cleared: true },
    ]);
    expect(await tasks()).toEqual([]);
  });
});

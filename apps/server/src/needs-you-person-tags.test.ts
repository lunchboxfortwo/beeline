import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { needsYouMarksSchema } from './needs-you-marks.js';
import { readNeedsYouOrder } from './needs-you.js';
import { PhoneService } from './phone-service.js';
import { postRoomChoice } from './room-choice.js';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
import { updateWorkItem } from './work-board.js';
import { askOwnerQuestion } from './work-questions.js';

const VIEWER = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333';
const GRANT = '55555555-5555-4555-8555-555555555555';

describe('Needs you human mention retirement', () => {
  let database: PgliteDatabase;
  let phone: PhoneService;
  let sequence = 0;
  async function post(roomId: string, authorId: string, text: string, ageMinutes = 10) {
    const id = (++sequence).toString(16).padStart(64, '0');
    await database.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
      VALUES($1,$2,$3,$4,now()-$5*interval '1 minute')`, [id, roomId, authorId, text, ageMinutes]);
    return id;
  }
  async function report(
    roomId: string,
    authorId: string,
    text: string,
    status: 'blocked' | 'needs-decision' = 'blocked',
    ageMinutes = 10,
  ) {
    const id = await post(roomId, authorId, text, ageMinutes);
    await database.query(`UPDATE messages SET card=$2::jsonb WHERE id=$1`, [
      id,
      JSON.stringify({ reportStatus: status, reportToId: VIEWER }),
    ]);
    return id;
  }
  const read = () => phone.execute('readNeedsYou', { workspaceId: WORKSPACE }, VIEWER);
  const count = async () => (await phone.execute('countNeedsYou', { workspaceId: WORKSPACE }, VIEWER)).count;

  beforeEach(async () => {
    sequence = 0;
    database = await migratedDatabase();
    await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Ada','ada'),($2,'human','Juniper','juniper'),($3,'agent','Hoots','hoots')`, [VIEWER, PEER, AGENT]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, VIEWER]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES
      ($1,$3,NULL,'Launch room'),($2,$3,$1,'release-ios-signing')`, [ROOM, CORNER, WORKSPACE]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,NULL,$4,'member'),
      ($1,$5,$2,'owner'),($1,$5,$3,'member'),($1,$5,$4,'member')`, [WORKSPACE, VIEWER, PEER, AGENT, ROOM]);
    phone = new PhoneService(database, 'https://server.example');
  });

  afterEach(() => database.close());

  it('Reproduction 1: excludes human-to-human mentions and questions while preserving reports, questions, and approvals', async () => {
    await post(ROOM, PEER, '@ada @hoots can you look at this?', 30);
    await post(ROOM, PEER, '@channel what do you think?', 29);
    await post(ROOM, PEER, '@ada please check the launch note.', 28);
    await post(CORNER, PEER, 'cost for leading companies to serve a token?', 27);
    await post(ROOM, AGENT, '@ada please check the launch note?', 26);
    await phone.execute('sendRoomMessage', {
      roomId: ROOM,
      messageId: 'd'.repeat(64),
      text: '@ada can you review this?',
    }, PEER);

    expect((await database.query('SELECT * FROM needs_you_marks')).rows).toEqual([]);
    expect((await read()).items).toEqual([]);
    expect(await count()).toBe(0);
    expect(await readNeedsYouOrder(database, WORKSPACE, VIEWER)).toEqual({ count: 0, order: [] });
    expect((await phone.liveNeedsYou(ROOM, VIEWER))?.count).toBe(0);

    const blocked = await report(CORNER, AGENT, 'Need a signing decision before build?', 'blocked', 20);
    const decision = await report(ROOM, AGENT, 'Ship the release tonight?', 'needs-decision', 19);
    const workQuestion = await askOwnerQuestion(
      database,
      { about: { kind: 'thread', roomId: CORNER }, question: 'Which surface?', freeText: true },
      AGENT,
    );
    const standaloneChoice = await postRoomChoice(database, {
      roomId: ROOM,
      agentId: AGENT,
      requesterId: VIEWER,
      mode: 'question',
      prompt: 'Promote next to latest?',
      options: [{ label: 'Promote' }, { label: 'Hold' }],
    });
    await database.query(
      `INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status)
       VALUES($1,$2,$3,'command','gh pr checks','Watch CI',$2,$4,'pending')`,
      [GRANT, AGENT, WORKSPACE, ROOM],
    );
    const grantCard = 'e'.repeat(64);
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
       VALUES($1,$2,$3,'Hoots asks Ada','card','grant-request',$4::jsonb)`,
      [
        grantCard,
        ROOM,
        AGENT,
        JSON.stringify({
          agent: { pubkey: AGENT, kind: 'agent', name: 'Hoots' },
          grants: [{ grantId: GRANT, kind: 'command', target: 'gh pr checks', reason: 'Watch CI', status: 'pending' }],
        }),
      ],
    );

    const { items } = await read();
    expect(items.map((item) => item.messageId).sort()).toEqual(
      [blocked, decision, workQuestion.messageId, standaloneChoice.messageId, grantCard].sort(),
    );
    expect(await count()).toBe(5);
  });

  it('retires open human-mention marks once on deploy without disturbing live reports, questions, or approvals', async () => {
    const humanMention = await post(ROOM, PEER, '@ada @hoots can you look at this?', 40);
    const humanQuestion = await post(ROOM, PEER, 'what do you think?', 39);
    const alreadyCleared = await post(ROOM, PEER, '@ada already dismissed', 38);
    const liveReport = await report(CORNER, AGENT, 'Blocked on signing key', 'blocked', 30);
    const activeQuestion = await askOwnerQuestion(
      database,
      { about: { kind: 'thread', roomId: CORNER }, question: 'Which track?', freeText: true },
      AGENT,
    );
    const dormantQuestion = await askOwnerQuestion(
      database,
      { about: { kind: 'thread', roomId: CORNER }, question: 'Which cohort?', freeText: true },
      AGENT,
    );
    await updateWorkItem(database, { id: dormantQuestion.messageId, roomId: CORNER, assigneeId: PEER }, VIEWER);
    const choiceQuestion = await postRoomChoice(database, {
      roomId: ROOM,
      agentId: AGENT,
      requesterId: VIEWER,
      mode: 'question',
      prompt: 'Run release proof?',
      options: [{ label: 'Yes' }, { label: 'No' }],
    });
    await database.query(
      `INSERT INTO agent_grants(id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status)
       VALUES($1,$2,$3,'command','gh pr checks','Watch CI',$2,$4,'pending')`,
      [GRANT, AGENT, WORKSPACE, ROOM],
    );
    const grantCard = 'f'.repeat(64);
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card)
       VALUES($1,$2,$3,'Hoots asks Ada','card','grant-request',$4::jsonb)`,
      [
        grantCard,
        ROOM,
        AGENT,
        JSON.stringify({
          agent: { pubkey: AGENT, kind: 'agent', name: 'Hoots' },
          grants: [{ grantId: GRANT, kind: 'command', target: 'gh pr checks', reason: 'Watch CI', status: 'pending' }],
        }),
      ],
    );

    // Simulate pre-deploy marks from the retired human-to-human mention branch
    // plus an already-dismissed mark and an open mark on an approval card.
    await database.query(
      `INSERT INTO needs_you_marks(identity_id,message_id,workspace_id,cleared_at,cleared_reason)
       VALUES($1,$2,$3,NULL,NULL),($1,$4,$3,NULL,NULL),($1,$5,$3,now()-interval '1 hour','manual'),($1,$6,$3,NULL,NULL)`,
      [VIEWER, humanMention, WORKSPACE, humanQuestion, alreadyCleared, grantCard],
    );
    await database.query("DELETE FROM workflow_backfills WHERE name='needs-you-retire-person-tags-v1'");

    await database.query(needsYouMarksSchema());

    const marks = (
      await database.query<{ message_id: string; cleared_reason: string | null; cleared: boolean }>(
        `SELECT message_id,cleared_reason,cleared_at IS NOT NULL cleared
         FROM needs_you_marks WHERE identity_id=$1 ORDER BY message_id`,
        [VIEWER],
      )
    ).rows;
    const byId = new Map(marks.map((row) => [row.message_id, row]));
    expect(byId.get(humanMention)).toEqual({ message_id: humanMention, cleared_reason: 'removed', cleared: true });
    expect(byId.get(humanQuestion)).toEqual({ message_id: humanQuestion, cleared_reason: 'removed', cleared: true });
    expect(byId.get(alreadyCleared)).toEqual({ message_id: alreadyCleared, cleared_reason: 'manual', cleared: true });
    expect(byId.get(liveReport)).toEqual({ message_id: liveReport, cleared_reason: null, cleared: false });
    expect(byId.get(activeQuestion.messageId)).toEqual({
      message_id: activeQuestion.messageId,
      cleared_reason: null,
      cleared: false,
    });
    expect(byId.get(dormantQuestion.messageId)).toEqual({
      message_id: dormantQuestion.messageId,
      cleared_reason: null,
      cleared: false,
    });
    expect(byId.get(choiceQuestion.messageId)).toEqual({
      message_id: choiceQuestion.messageId,
      cleared_reason: null,
      cleared: false,
    });
    expect(byId.get(grantCard)).toEqual({ message_id: grantCard, cleared_reason: null, cleared: false });

    expect((await read()).items.map((item) => item.messageId).sort()).toEqual(
      [liveReport, activeQuestion.messageId, choiceQuestion.messageId, grantCard].sort(),
    );
    expect(await count()).toBe(4);

    // Idempotent on re-run.
    const snapshot = (await database.query('SELECT * FROM needs_you_marks ORDER BY identity_id,message_id')).rows;
    await database.query(needsYouMarksSchema());
    expect((await database.query('SELECT * FROM needs_you_marks ORDER BY identity_id,message_id')).rows).toEqual(
      snapshot,
    );
  });

  it('backfills only open legacy reports, preserves seen clocks, and never backfills historical person tags', async () => {
    await database.query('ALTER TABLE messages DISABLE TRIGGER message_needs_you_marks');
    await database.query("DELETE FROM workflow_backfills WHERE name='needs-you-open-items-v1'");
    const retitled = await post(CORNER, AGENT, 'done: no longer a report', 60);
    const answered = await post(ROOM, AGENT, 'blocked: answered report', 50);
    await database.query(`UPDATE messages SET card=jsonb_build_object('reportStatus','blocked','reportToId',$1::text) WHERE id=$2`, [VIEWER, answered]);
    const reply = await post(ROOM, VIEWER, 'Resolved.', 40);
    await database.query('UPDATE messages SET reply_to_message_id=$2 WHERE id=$1', [reply, answered]);
    const open = await post(ROOM, AGENT, 'needs-decision: choose a route', 30);
    const seen = await post(CORNER, AGENT, 'blocked: a seen report', 20);
    // In the chat, so this newer report does not supersede the thread's open one.
    const dismissed = await post(ROOM, AGENT, 'blocked: a dismissed report', 10);
    await database.query(`UPDATE messages SET card=jsonb_build_object('reportStatus','blocked','reportToId',$1::text) WHERE id=ANY($2::text[])`, [VIEWER, [open, seen, dismissed]]);
    await post(ROOM, PEER, '@ada an old personal tag', 5);
    await database.query(`INSERT INTO needs_you_marks(identity_id,message_id,workspace_id,cleared_at)
      VALUES($1,$2,$3,NULL),($1,$4,$3,now()),($1,$5,$3,NULL),($1,$6,$3,NULL)`, [VIEWER, seen, WORKSPACE, dismissed, answered, retitled]);
    const clock = (await database.query('SELECT first_seen_at FROM needs_you_marks WHERE message_id=$1', [seen])).rows[0]?.first_seen_at;
    await database.query('ALTER TABLE messages ENABLE TRIGGER message_needs_you_marks');
    await database.query(needsYouMarksSchema());
    expect((await read()).items.map(item => item.messageId).sort()).toEqual([open, seen].sort());
    expect(await count()).toBe(2);
    expect((await readNeedsYouOrder(database, WORKSPACE, VIEWER)).order.sort()).toEqual([open, seen].sort());
    expect((await phone.liveNeedsYou(ROOM, VIEWER))?.count).toBe(2);
    expect((await database.query('SELECT first_seen_at FROM needs_you_marks WHERE message_id=$1', [seen])).rows[0]?.first_seen_at).toEqual(clock);
    const freshTag = await post(ROOM, PEER, '@ada a new tag after rollout', 1);
    await database.query(needsYouMarksSchema());
    expect(await count()).toBe(2);
    expect((await read()).items.some(item => item.messageId === freshTag)).toBe(false);
  });

  it('rolls the open record back with its message and clears a removed request', async () => {
    await expect(database.transaction(async db => {
      await db.query(
        `INSERT INTO messages(id,room_id,author_id,text,card) VALUES('rollback-report',$1,$2,'blocked: review',$3::jsonb)`,
        [ROOM, AGENT, JSON.stringify({ reportStatus: 'blocked', reportToId: VIEWER })],
      );
      expect((await db.query(`SELECT 1 FROM needs_you_marks WHERE message_id='rollback-report'`)).rowCount).toBe(1);
      throw new Error('roll back message');
    })).rejects.toThrow('roll back message');
    expect((await database.query(`SELECT 1 FROM needs_you_marks WHERE message_id='rollback-report'`)).rowCount).toBe(0);
    const id = await report(ROOM, AGENT, 'please check this.');
    await database.query('UPDATE messages SET deleted_at=now() WHERE id=$1', [id]);
    expect(await count()).toBe(0);
    expect((await database.query('SELECT cleared_at FROM needs_you_marks WHERE message_id=$1', [id])).rows[0]?.cleared_at).toBeInstanceOf(Date);
  });

  it('keeps an open report after unrelated conversation in its updated origin', async () => {
    const id = await post(ROOM, AGENT, 'blocked: choose a route', 20);
    await database.query(`UPDATE messages SET card=jsonb_build_object('reportStatus','blocked','reportToId',$1::text) WHERE id=$2`, [VIEWER, id]);
    await post(CORNER, VIEWER, 'Use the first route.', 5);
    expect(await count()).toBe(1);
    await database.query(`UPDATE messages SET card=card||jsonb_build_object('sourceRoomId',$1::text) WHERE id=$2`, [CORNER, id]);
    expect(await count()).toBe(1);
    const reply = await post(CORNER, VIEWER, 'Use the first route.', 1);
    await database.query('UPDATE messages SET reply_to_message_id=$2 WHERE id=$1', [reply, id]);
    expect(await count()).toBe(0);
  });
});

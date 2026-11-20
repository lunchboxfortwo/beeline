import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { needsYouMarksSchema } from './needs-you-marks.js';
import { readNeedsYouOrder } from './needs-you.js';
import { PhoneService } from './phone-service.js';
import { PgliteDatabase, migratedDatabase } from './test-support.js';

const VIEWER = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const CORNER = '33333333-3333-4333-8333-333333333333';

describe('person tags in Needs you', () => {
  let database: PgliteDatabase;
  let phone: PhoneService;
  let sequence = 0;
  async function post(roomId: string, authorId: string, text: string, ageMinutes = 10) {
    const id = (++sequence).toString(16).padStart(64, '0');
    await database.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
      VALUES($1,$2,$3,$4,now()-$5*interval '1 minute')`, [id, roomId, authorId, text, ageMinutes]);
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

  it('PERSON-TAG: lists and counts a person tagging the viewer, excludes agent and inexact tags, and clears on reply or dismissal', async () => {
    const tagged = await post(ROOM, PEER, '@ada please check the launch note.', 30);
    await post(ROOM, AGENT, '@ada please check the launch note.', 29);
    await post(ROOM, PEER, '@adam this is for someone else.', 28);
    await post(ROOM, PEER, '`@ada` is a handle example.', 27);
    await post(ROOM, PEER, '@channel please check the launch note.', 26);
    await post(ROOM, VIEWER, '@ada a note to myself.', 31);
    expect((await read()).items).toMatchObject([{ messageId: tagged, author: { name: 'Juniper', kind: 'human' } }]);
    expect(await count()).toBe(1);
    await post(ROOM, VIEWER, 'Reviewed the launch note.', 20);
    expect((await read()).items).toEqual([]);
    expect(await count()).toBe(0);
    const dismissed = await post(ROOM, PEER, '@ada please check the revised note.', 10);
    expect(await count()).toBe(1);
    await phone.execute('clearNeedsYou', { workspaceId: WORKSPACE, messageId: dismissed }, VIEWER);
    expect((await read()).items).toEqual([]);
    expect(await count()).toBe(0);
  });

  it('PERSON-TAG: shares the question rules: no expiry, section clear and count', async () => {
    const id = await post(CORNER, PEER, '@ada please review this corner.', 30 * 60);
    expect(await count()).toBe(1);
    expect((await read()).items.map(item => [item.messageId, item.expiresAt])).toEqual([[id, undefined]]);
    await post(ROOM, PEER, '@ada please check another note.');
    expect(await count()).toBe(2);
    await phone.execute('clearNeedsYouSection', { workspaceId: WORKSPACE }, VIEWER);
    expect((await read()).items).toEqual([]);
    expect(await count()).toBe(0);
  });

  it('commits the open item with a phone send and settles it with the viewer reply', async () => {
    const id = 'd'.repeat(64);
    await phone.execute('sendRoomMessage', { roomId: ROOM, messageId: id, text: '@ada please review.' }, PEER);
    expect((await database.query('SELECT first_seen_at,cleared_at FROM needs_you_marks WHERE message_id=$1', [id])).rows)
      .toEqual([{ first_seen_at: null, cleared_at: null }]);
    expect(await readNeedsYouOrder(database, WORKSPACE, VIEWER)).toEqual({ count: 1, order: [id] });
    expect((await phone.liveNeedsYou(ROOM, VIEWER))?.count).toBe(1);
    await phone.execute('sendRoomMessage', { roomId: ROOM, messageId: 'e'.repeat(64), text: 'Reviewed.' }, VIEWER);
    expect((await database.query('SELECT cleared_at FROM needs_you_marks WHERE message_id=$1', [id])).rows[0]?.cleared_at).toBeInstanceOf(Date);
    expect(await count()).toBe(0);
  });

  it('backfills only open legacy reports, preserves seen clocks, and never backfills historical person tags', async () => {
    await database.query('ALTER TABLE messages DISABLE TRIGGER message_needs_you_marks');
    await database.query("DELETE FROM workflow_backfills WHERE name='needs-you-open-items-v1'");
    const retitled = await post(CORNER, AGENT, 'done: no longer a report', 60);
    const answered = await post(ROOM, AGENT, 'blocked: answered report', 50);
    await database.query(`UPDATE messages SET card=jsonb_build_object('reportToId',$1::text) WHERE id=$2`, [VIEWER, answered]);
    await post(ROOM, VIEWER, 'Resolved.', 40);
    const open = await post(ROOM, AGENT, 'needs-decision: choose a route', 30);
    const seen = await post(CORNER, AGENT, 'blocked: a seen report', 20);
    // In the chat, so this newer report does not supersede the thread's open one.
    const dismissed = await post(ROOM, AGENT, 'blocked: a dismissed report', 10);
    await database.query(`UPDATE messages SET card=jsonb_build_object('reportToId',$1::text) WHERE id=ANY($2::text[])`, [VIEWER, [open, seen, dismissed]]);
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
    expect(await count()).toBe(3);
    expect((await read()).items.some(item => item.messageId === freshTag)).toBe(true);
  });

  it('rolls the open record back with its message and clears a removed request', async () => {
    await expect(database.transaction(async db => {
      await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('rollback-tag',$1,$2,'@ada review')`, [ROOM, PEER]);
      expect((await db.query(`SELECT 1 FROM needs_you_marks WHERE message_id='rollback-tag'`)).rowCount).toBe(1);
      throw new Error('roll back message');
    })).rejects.toThrow('roll back message');
    expect((await database.query(`SELECT 1 FROM needs_you_marks WHERE message_id='rollback-tag'`)).rowCount).toBe(0);
    const id = await post(ROOM, PEER, '@ada please check this.');
    await database.query('UPDATE messages SET deleted_at=now() WHERE id=$1', [id]);
    expect(await count()).toBe(0);
    expect((await database.query('SELECT cleared_at FROM needs_you_marks WHERE message_id=$1', [id])).rows[0]?.cleared_at).toBeInstanceOf(Date);
  });

  it('settles an open report when its recorded origin is updated to an answered corner', async () => {
    const id = await post(ROOM, AGENT, 'blocked: choose a route', 20);
    await database.query(`UPDATE messages SET card=jsonb_build_object('reportToId',$1::text) WHERE id=$2`, [VIEWER, id]);
    await post(CORNER, VIEWER, 'Use the first route.', 5);
    expect(await count()).toBe(1);
    await database.query(`UPDATE messages SET card=card||jsonb_build_object('sourceRoomId',$1::text) WHERE id=$2`, [CORNER, id]);
    expect(await count()).toBe(0);
  });

});

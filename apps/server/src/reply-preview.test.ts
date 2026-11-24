import { afterEach, expect, it } from 'vitest';
import { ROOM_VIEW_MESSAGE_LIMIT } from '@beeline/api-contract/phone';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';

// Reproduction R1: a reply on the newest page quotes a message that is older
// than the page. The read carries the original's author and first line.

const OWNER = 'a'.repeat(64), AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const OTHER_ROOM = '33333333-3333-4333-8333-333333333333';
const ORIGINAL = '1'.repeat(64), DELETED = '2'.repeat(64), FOREIGN = '3'.repeat(64);
const REPLY = '4'.repeat(64), DELETED_REPLY = '5'.repeat(64), FOREIGN_REPLY = '6'.repeat(64);
let db: PgliteDatabase | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

async function seed(): Promise<PgliteDatabase> {
  const database = db = await migratedDatabase();
  await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Sample Owner','sample.owner'),($2,'agent','Sample Agent','sample.agent')`, [OWNER, AGENT]);
  await database.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [AGENT, OWNER]);
  await database.query("INSERT INTO workspaces(id,name) VALUES($1,'Synthetic replies')", [WORKSPACE]);
  for (const room of [ROOM, OTHER_ROOM]) {
    await database.query("INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Samples',$3)",
      [room, WORKSPACE, OWNER]);
  }
  for (const member of [OWNER, AGENT]) await database.query(
    "INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')",
    [WORKSPACE, ROOM, member]);
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 12, minute));
  await database.query(`INSERT INTO messages(id,room_id,author_id,text,created_at,deleted_at) VALUES
    ($1,$4,$6,$7,$8,NULL),($2,$4,$6,'Removed original',$8,$8),($3,$5,$6,'Other room original',$8,NULL)`,
    [ORIGINAL, DELETED, FOREIGN, ROOM, OTHER_ROOM, AGENT, '\n  Deploy plan ready  \nSecond line', at(0)]);
  for (let index = 0; index < ROOM_VIEW_MESSAGE_LIMIT + 5; index += 1) {
    await database.query('INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,$4,$5)',
      [index.toString(16).padStart(64, 'c'), ROOM, OWNER, `Filler ${index}`, at(1 + index)]);
  }
  await database.query(`INSERT INTO messages(id,room_id,author_id,text,reply_to_message_id,root_message_id,created_at)
    VALUES($1,$4,$5,'Ship it',$6,$6,$9),($2,$4,$5,'About the removed one',$7,$7,$9),
      ($3,$4,$5,'About the other room',$8,$8,$9)`,
    [REPLY, DELETED_REPLY, FOREIGN_REPLY, ROOM, OWNER, ORIGINAL, DELETED, FOREIGN, at(59)]);
  return database;
}

it('a reply on the newest page carries the older original author and first line', async () => {
  const phone = new PhoneService(await seed(), 'https://example.invalid');
  const view = await phone.readRoom(ROOM, OWNER);
  expect(view?.messages.some((message) => message.id === ORIGINAL)).toBe(false);
  const reply = view?.messages.find((message) => message.id === REPLY);
  expect(reply?.reply?.eventId).toBe(ORIGINAL);
  expect(reply?.replyPreview).toEqual({
    author: expect.objectContaining({ pubkey: AGENT, kind: 'agent', name: 'Sample Agent' }),
    text: 'Deploy plan ready',
  });

  const history = await phone.readHistory(ROOM, OWNER);
  expect(history?.messages.find((message) => message.id === REPLY)?.replyPreview?.text)
    .toBe('Deploy plan ready');
});

it('a deleted or other-room original sends no preview', async () => {
  const phone = new PhoneService(await seed(), 'https://example.invalid');
  const view = await phone.readRoom(ROOM, OWNER);
  for (const id of [DELETED_REPLY, FOREIGN_REPLY]) {
    const message = view?.messages.find((candidate) => candidate.id === id);
    expect(message).toBeDefined();
    expect(message?.replyPreview).toBeUndefined();
  }
  expect(view?.messages.find((message) => !message.reply && message.replyPreview)).toBeUndefined();
});

it('an activity, wake card or schedule-run original that the transcript hides sends no preview', async () => {
  const database = await seed();
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 13, minute));
  const hidden = [
    ['7'.repeat(64), "'activity'", 'NULL', 'NULL'],
    ['8'.repeat(64), "'card'", "'grant-decision'", 'NULL'],
    ['9'.repeat(64), "'system'", 'NULL', `'{"kind":"schedule-ran"}'::jsonb`],
  ] as const;
  const replies: string[] = [];
  for (const [index, [id, presentation, cardType, systemEvent]] of hidden.entries()) {
    await database.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,system_event,created_at)
      VALUES($1,$2,$3,'Hidden original',${presentation},${cardType},${systemEvent},$4)`, [id, ROOM, AGENT, at(index)]);
    const reply = `d${index}`.padStart(64, 'e');
    replies.push(reply);
    await database.query(`INSERT INTO messages(id,room_id,author_id,text,reply_to_message_id,root_message_id,created_at)
      VALUES($1,$2,$3,'About the hidden one',$4,$4,$5)`, [reply, ROOM, OWNER, id, at(10 + index)]);
  }
  const phone = new PhoneService(database, 'https://example.invalid');
  for (const read of [() => phone.readRoom(ROOM, OWNER), () => phone.readHistory(ROOM, OWNER)]) {
    const messages = (await read())?.messages ?? [];
    for (const reply of replies) {
      const message = messages.find((candidate) => candidate.id === reply);
      expect(message).toBeDefined();
      expect(message?.replyPreview).toBeUndefined();
    }
  }
});

it('a visible card outside the newest page is quoted with its first line', async () => {
  const database = await seed();
  const CARD = 'a1'.padStart(64, 'f'), CARD_REPLY = 'a2'.padStart(64, 'f');
  await database.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,created_at)
    VALUES($1,$2,$3,'Pick a deploy window','card','choice','{}'::jsonb,$4)`,
    [CARD, ROOM, AGENT, new Date(Date.UTC(2026, 10, 20, 11, 0))]);
  await database.query(`INSERT INTO messages(id,room_id,author_id,text,reply_to_message_id,root_message_id,created_at)
    VALUES($1,$2,$3,'Tuesday works',$4,$4,$5)`, [CARD_REPLY, ROOM, OWNER, CARD, new Date(Date.UTC(2026, 10, 20, 14, 0))]);
  const phone = new PhoneService(database, 'https://example.invalid');
  for (const read of [() => phone.readRoom(ROOM, OWNER), () => phone.readHistory(ROOM, OWNER)]) {
    const messages = (await read())?.messages ?? [];
    expect(messages.some((message) => message.id === CARD)).toBe(false);
    expect(messages.find((message) => message.id === CARD_REPLY)?.replyPreview?.text).toBe('Pick a deploy window');
  }
});

it('a visible PR note and corner card outside the page are quoted; hidden ones are not', async () => {
  const database = await seed();
  const THREAD = '44444444-4444-4444-8444-444444444444';
  await database.query("INSERT INTO rooms(id,workspace_id,name,created_by,parent_id) VALUES($1,$2,'Thread',$3,$4)",
    [THREAD, WORKSPACE, OWNER, ROOM]);
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 10, minute));
  // [original id, card type, card, system event, visible in the Room transcript]
  const originals: Array<[string, string, string | null, string | null, boolean]> = [
    ['c1', 'github-corner-note', null, '{"verb":"merged"}', true],
    ['c2', 'daemon-fact', '{"type":"corner-open","cornerId":"55555555-5555-4555-8555-555555555555"}', null, true],
    ['c3', 'daemon-fact', `{"type":"corner-complete","cornerId":"${THREAD}"}`, null, false],
    ['c4', 'grant-decision', null, null, false],
  ];
  for (const [index, [id, cardType, card, systemEvent]] of originals.entries()) {
    await database.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,system_event,created_at)
      VALUES($1,$2,$3,$4,'card',$5,$6::jsonb,$7::jsonb,$8)`,
      [id.padStart(64, 'f'), ROOM, AGENT, `Card ${id}`, cardType, card, systemEvent, at(index)]);
    await database.query(`INSERT INTO messages(id,room_id,author_id,text,reply_to_message_id,root_message_id,created_at)
      VALUES($1,$2,$3,'About the card',$4,$4,$5)`,
      [`d${id}`.padStart(64, 'e'), ROOM, OWNER, id.padStart(64, 'f'), new Date(Date.UTC(2026, 10, 20, 15, index))]);
  }
  const phone = new PhoneService(database, 'https://example.invalid');
  for (const read of [() => phone.readRoom(ROOM, OWNER), () => phone.readHistory(ROOM, OWNER)]) {
    const messages = (await read())?.messages ?? [];
    for (const [id, , , , visible] of originals) {
      expect(messages.some((message) => message.id === id.padStart(64, 'f'))).toBe(false);
      const quoted = messages.find((message) => message.id === `d${id}`.padStart(64, 'e'));
      expect(quoted).toBeDefined();
      expect(quoted?.replyPreview?.text).toBe(visible ? `Card ${id}` : undefined);
    }
  }
});

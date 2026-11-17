import { afterEach, expect, it } from 'vitest';
import { uuid } from '@beeline/api-contract/phone';
import { modelText } from './message-origin.js';
import { postRoomChoice } from './room-choice.js';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';

const OWNER = 'a'.repeat(64), AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
let db: PgliteDatabase | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

it('creates standard UUIDs for idempotent choices and preserves new and legacy IDs on replay', async () => {
  const database = db = await migratedDatabase();
  await database.query(`INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Sample Owner','sample.owner'),($2,'agent','Sample Agent','sample.agent')`, [OWNER, AGENT]);
  await database.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [AGENT, OWNER]);
  await database.query("INSERT INTO workspaces(id,name) VALUES($1,'Synthetic choices')", [WORKSPACE]);
  await database.query("INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Samples',$3)", [ROOM, WORKSPACE, OWNER]);
  for (const member of [OWNER, AGENT]) await database.query(
    "INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')",
    [WORKSPACE, ROOM, member]);
  const create = (messageId: string) => database.transaction(tx => postRoomChoice(tx, {
    messageId, messageText: modelText('Choose a sample'), roomId: ROOM, agentId: AGENT,
    requesterId: OWNER, mode: 'question', prompt: 'Which sample?',
    options: [{ label: 'First', consequence: 'Use first' }, { label: 'Second', consequence: 'Use second' }],
  }));
  for (const digit of '0123456789abcdef') {
    const messageId = digit.repeat(64);
    const first = await create(messageId);
    expect(uuid(first.choiceId)).toBe(true);
    expect(first.choiceId[14]).toBe('4');
    expect((await create(messageId)).choiceId).toBe(first.choiceId);
    const legacy = first.choiceId.slice(0, 19) + 'f' + first.choiceId.slice(20);
    await database.query('UPDATE room_choices SET id=$2 WHERE id=$1', [first.choiceId, legacy]);
    await database.query("UPDATE messages SET card=jsonb_set(card,'{choiceId}',to_jsonb($2::text)) WHERE id=$1", [messageId, legacy]);
    expect((await create(messageId)).choiceId).toBe(legacy);
    expect((await database.query('SELECT card->>\'choiceId\' choice_id FROM messages WHERE id=$1', [messageId])).rows)
      .toEqual([{ choice_id: legacy }]);
    expect((await database.query('SELECT id FROM room_choices WHERE message_id=$1', [messageId])).rows)
      .toEqual([{ id: legacy }]);
  }
  const phone = new PhoneService(database, 'https://example.invalid');
  const parentId = '0'.repeat(64);
  const view = await phone.readRoom(ROOM, OWNER);
  expect(view?.messages.find(message => message.id === parentId)?.reference)
    .toEqual({ channelId: ROOM, eventId: parentId, rootId: parentId });
  const replyId = 'ab'.repeat(32);
  await phone.execute('sendRoomReply', {
    roomId: ROOM, messageId: replyId, parentMessageId: parentId, text: 'More sample details',
  }, OWNER);
  expect((await database.query('SELECT reply_to_message_id FROM messages WHERE id=$1', [replyId])).rows)
    .toEqual([{ reply_to_message_id: parentId }]);
});

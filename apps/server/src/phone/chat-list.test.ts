import { beforeEach, expect, it } from 'vitest';
import { PhoneService } from '../phone-service.js';
import { migratedDatabase, type PgliteDatabase } from '../test-support.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE = '99999999-9999-4999-8999-999999999999';
const JOINED = '22222222-2222-4222-8222-222222222222';
const LAUNCH = '33333333-3333-4333-8333-333333333333';
const PRIVATE = '44444444-4444-4444-8444-444444444444';
const ARCHIVED = '55555555-5555-4555-8555-555555555555';
const CORNER = '66666666-6666-4666-8666-666666666666';
const DIRECT = '77777777-7777-4777-8777-777777777777';
const LEFT = '88888888-8888-4888-8888-888888888888';
const ELSEWHERE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PERSON = 'a'.repeat(64);
const TEAMMATE = 'b'.repeat(64);

let database: PgliteDatabase;
let phone: PhoneService;

beforeEach(async () => {
  database = await migratedDatabase();
  phone = new PhoneService(database, 'https://server.usebeeline.app');
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES ($1,'human','Person','person'),($2,'human','Teammate','teammate')`,
    [PERSON, TEAMMATE],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive'),($2,'Elsewhere')`, [WORKSPACE, OTHER_WORKSPACE]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,name,parent_id,visibility,archived_at,direct_participants,created_by) VALUES
      ($1,$8,'joined',NULL,'public',NULL,NULL,$10),
      ($2,$8,'launch',NULL,'public',NULL,NULL,$10),
      ($3,$8,'secret',NULL,'invite-only',NULL,NULL,$10),
      ($4,$8,'old',NULL,'public',now(),NULL,$10),
      ($5,$8,'corner',$1,'public',NULL,NULL,$10),
      ($6,$8,'dm',NULL,'public',NULL,jsonb_build_array($10::text,$11::text),$10),
      ($7,$8,'left',NULL,'public',NULL,NULL,$10),
      ($9,$12,'elsewhere',NULL,'public',NULL,NULL,$10)`,
    [JOINED, LAUNCH, PRIVATE, ARCHIVED, CORNER, DIRECT, LEFT, WORKSPACE, ELSEWHERE, TEAMMATE, PERSON, OTHER_WORKSPACE],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
      ($1,NULL,$2,'member'),($1,NULL,$3,'owner'),
      ($1,$4,$2,'member'),($1,$4,$3,'owner'),
      ($1,$5,$3,'owner'),($1,$6,$3,'owner'),($1,$7,$3,'owner'),
      ($1,$8,$3,'owner')`,
    [WORKSPACE, PERSON, TEAMMATE, JOINED, LAUNCH, PRIVATE, ARCHIVED, LEFT],
  );
  // The person once joined #left and left it: a removed row is not a live join.
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role,removed_at) VALUES($1,$2,$3,'member',now())`,
    [WORKSPACE, LEFT, PERSON],
  );
});

it('lists the live top-level public chats the viewer has not joined, with live member counts', async () => {
  const view = await phone.readChats(WORKSPACE, PERSON);
  expect(view?.chats.map((chat) => chat.room.id)).toEqual([JOINED]);
  expect(view?.joinable).toEqual(expect.arrayContaining([
    { id: LAUNCH, name: 'launch', memberCount: 1 },
    { id: LEFT, name: 'left', memberCount: 1 },
  ]));
  expect(view?.joinable).toHaveLength(2);
});

it('drops a public chat from joinable once the viewer joins it', async () => {
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
    [WORKSPACE, LAUNCH, PERSON],
  );
  const view = await phone.readChats(WORKSPACE, PERSON);
  expect(view?.joinable?.map((chat) => chat.id)).toEqual([LEFT]);
  expect(view?.chats.map((chat) => chat.room.id).sort()).toEqual([JOINED, LAUNCH].sort());
});

it('Reproduction quiet-chat-badge: a thread message never marks its chat unread; the chat dot reflects chat messages only', async () => {
  const row = async () => (await phone.readChats(WORKSPACE, PERSON))?.chats.find((chat) => chat.room.id === JOINED);
  await phone.execute('sendRoomMessage', { roomId: CORNER, text: 'Thread news' }, TEAMMATE);
  expect((await row())?.unread).toBe(false);
  await phone.execute('sendRoomMessage', { roomId: JOINED, text: 'Chat news' }, TEAMMATE);
  expect((await row())?.unread).toBe(true);
});

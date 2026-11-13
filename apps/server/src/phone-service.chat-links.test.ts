import { beforeEach, describe, expect, it } from 'vitest';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { backfillChatSeq } from './chat-seq.js';

const VIEWER = 'a'.repeat(64);
const CANDY = 'b'.repeat(64);
const STRANGER = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const BEELINE = '22222222-2222-4222-8222-222222222221';
const TRIAGE = '22222222-2222-4222-8222-222222222222';
const SECRET = '22222222-2222-4222-8222-222222222223';
const SENDING = '22222222-2222-4222-8222-222222222224';
const SECRET_THREAD = '22222222-2222-4222-8222-222222222225';
const TRIAGE_FIX = '22222222-2222-4222-8222-222222222226';
const SECRET_FIX = '22222222-2222-4222-8222-222222222227';

let database: PgliteDatabase;
let phone: PhoneService;
let sequence = 0;
let clock = Date.parse('2026-11-12T08:00:00Z');

async function message(
  roomId: string,
  text: string,
  extra: { authorId?: string; presentation?: string } = {},
): Promise<{ id: string; chatSeq: number | null }> {
  sequence += 1;
  clock += 60_000;
  const id = sequence.toString(16).padStart(64, '0');
  const row = await database.query<{ chat_seq: number | null }>(
    `INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
     VALUES($1,$2,$3,$4,$5,$6) RETURNING chat_seq`,
    [id, roomId, extra.authorId ?? CANDY, text, extra.presentation ?? 'message', new Date(clock).toISOString()],
  );
  return { id, chatSeq: row.rows[0]!.chat_seq };
}

beforeEach(async () => {
  sequence = 0;
  database = await migratedDatabase();
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Ada','ada'),($2,'agent','Candy','candy'),($3,'human','Eve','eve')`,
    [VIEWER, CANDY, STRANGER],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name,parent_id) VALUES
      ($1,$9,$10,'beeline',NULL),($2,$9,$10,'issues-triage',NULL),($3,$9,$11,'secret',NULL),
      ($4,$9,$10,'sending-new-message',$1),($5,$9,$11,'notes',$3),
      ($6,$9,$10,'fix',$2),($7,$9,$11,'fix',$3),($8,$9,$10,'other-fix',$1)`,
    [BEELINE, TRIAGE, SECRET, SENDING, SECRET_THREAD, TRIAGE_FIX, SECRET_FIX,
      '22222222-2222-4222-8222-222222222228', WORKSPACE, VIEWER, STRANGER],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'member'),($1,$3,$2,'member'),($1,$4,$2,'member'),
       ($1,NULL,$5,'member'),($1,$3,$5,'member'),($1,$4,$5,'member'),($1,$6,$5,'member'),
       ($1,NULL,$7,'member'),($1,$6,$7,'member')`,
    [WORKSPACE, VIEWER, BEELINE, TRIAGE, CANDY, SECRET, STRANGER],
  );
  phone = new PhoneService(database, 'http://local.test');
});

describe('chat message numbers', () => {
  it('numbers messages across a Room and its threads in the order they are written', async () => {
    const first = await message(BEELINE, 'one');
    const inThread = await message(SENDING, 'two');
    await message(BEELINE, 'tool step', { presentation: 'activity' });
    const third = await message(BEELINE, 'three', { authorId: VIEWER });
    const otherChat = await message(TRIAGE, 'first in triage');

    expect([first.chatSeq, inThread.chatSeq, third.chatSeq]).toEqual([1, 2, 3]);
    expect(otherChat.chatSeq).toBe(1);
  });

  it('numbers history written before the trigger, and new messages continue after it', async () => {
    await database.query('ALTER TABLE messages DISABLE TRIGGER messages_chat_seq_trg');
    const old = [await message(BEELINE, 'a'), await message(SENDING, 'b'), await message(BEELINE, 'c')];
    await database.query('ALTER TABLE messages ENABLE TRIGGER messages_chat_seq_trg');
    const fresh = await message(BEELINE, 'd');

    expect(await backfillChatSeq(database)).toBe(3);
    const rows = await database.query<{ id: string; chat_seq: number }>(
      'SELECT id,chat_seq FROM messages ORDER BY created_at',
    );
    expect(rows.rows).toEqual([
      ...old.map((item, index) => ({ id: item.id, chat_seq: index + 1 })),
      { id: fresh.id, chat_seq: 4 },
    ]);
    expect(await backfillChatSeq(database)).toBe(0);
  });

  it('carries the number on the Room read so Copy link can name the message', async () => {
    await message(BEELINE, 'one');
    const second = await message(BEELINE, 'two');
    const room = await phone.readRoom(BEELINE, VIEWER);
    expect(room?.messages.find((item) => item.id === second.id)?.chatSeq).toBe(2);
  });
});

describe('resolveChatLinks', () => {
  it('opens a thread in this chat, and names the chat of a thread elsewhere', async () => {
    await message(SENDING, 'Send button stays grey after the first message on Android.');
    await message(TRIAGE_FIX, 'Fix is ready');
    const view = await phone.resolveChatLinks(BEELINE, ['↳sending-new-message', '↳Fix'], VIEWER);

    expect(view?.links).toEqual([
      {
        key: '↳sending-new-message', kind: 'thread', roomId: SENDING, parentRoomId: BEELINE,
        name: 'sending-new-message',
        preview: { author: 'Candy', createdAt: expect.any(Number), firstLine: 'Send button stays grey after the first message on Android.' },
      },
    ]);
    // `fix` is a thread in two other chats: no guess, so it stays plain text.

    const fromTriage = await phone.resolveChatLinks(TRIAGE, ['↳sending-new-message'], VIEWER);
    expect(fromTriage?.links[0]).toMatchObject({ kind: 'thread', roomId: SENDING, chatName: 'beeline' });
  });

  it('shows a thread in a chat the reader cannot open as private, and drops a token that matches nothing', async () => {
    const view = await phone.resolveChatLinks(BEELINE, ['↳notes', '↳no-such-thread', '↳other-fix'], VIEWER);
    expect(view?.links).toEqual([
      { key: '↳notes', kind: 'private' },
      expect.objectContaining({ key: '↳other-fix', kind: 'thread', roomId: '22222222-2222-4222-8222-222222222228' }),
    ]);
  });

  it('opens a message by author and number, in a thread or in another chat', async () => {
    await message(BEELINE, 'Is the send bug fixed?', { authorId: VIEWER });
    const report = await message(SENDING, 'Send button stays grey after the first message on Android.\nSecond line');
    const triage = await message(TRIAGE, 'Same cause as the draft state bug.');

    const view = await phone.resolveChatLinks(BEELINE, [`¶candy-${report.chatSeq}`], VIEWER);
    expect(view?.links).toEqual([
      {
        key: '¶candy-2', kind: 'message', messageId: report.id, roomId: SENDING, workspaceId: WORKSPACE,
        threadName: 'sending-new-message',
        preview: { author: 'Candy', createdAt: expect.any(Number), firstLine: 'Send button stays grey after the first message on Android.' },
      },
    ]);
    // ¶candy-1 in #beeline is Ada's message, not Candy's: the local chat holds
    // no match, and exactly one other chat does.
    expect(triage.chatSeq).toBe(1);
    const other = await phone.resolveChatLinks(BEELINE, ['¶Candy-1'], VIEWER);
    expect(other?.links).toEqual([expect.objectContaining({
      kind: 'message', messageId: triage.id, roomId: TRIAGE, chatName: 'issues-triage',
    })]);
  });

  it('prefers the chat the link was written in, keeps private messages private, and drops misses', async () => {
    const local = await message(BEELINE, 'local');
    await message(TRIAGE, 'elsewhere');
    await message(SECRET, 'hidden one', { authorId: STRANGER });
    await message(SECRET, 'hidden two', { authorId: STRANGER });

    const view = await phone.resolveChatLinks(BEELINE, ['¶candy-1', '¶eve-2', '¶candy-99', '¶ada-1'], VIEWER);
    expect(view?.links).toEqual([
      expect.objectContaining({ key: '¶candy-1', kind: 'message', messageId: local.id }),
      { key: '¶eve-2', kind: 'private' },
    ]);
  });

  it('refuses a reader who cannot open the chat the links were written in', async () => {
    expect(await phone.resolveChatLinks(SECRET, ['↳notes'], VIEWER)).toBeNull();
  });
});

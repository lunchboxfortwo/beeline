import { readAgentMessagePage } from '@beeline/api-contract/daemon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { searchInstitutionalHistory } from './institutional-history.js';
import { sendMessage } from './agent-messaging.js';
import { LiveHub } from './live.js';
import { HelperDaemonService } from './test-fixtures/helper-daemon.js';
import { insertCornerFacts, migratedDatabase, type PgliteDatabase } from './test-support.js';

const WS = '11111111-1111-4111-8111-111111111111';
const CHAT = '22222222-2222-4222-8222-222222222222';
const THREAD = '33333333-3333-4333-8333-333333333333';
const HUMAN = 'a'.repeat(64);
const SENDER = 'b'.repeat(64);
const RECIPIENT = 'c'.repeat(64);
const BYSTANDER = 'd'.repeat(64);

let db: PgliteDatabase;
let daemon: HelperDaemonService;

beforeAll(async () => {
  db = await migratedDatabase();
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Owner','owner'),
      ($2,'agent','Sender','sender'),
      ($3,'agent','Recipient','recipient'),
      ($4,'agent','Bystander','bystander')`,
    [HUMAN, SENDER, RECIPIENT, BYSTANDER],
  );
  await db.query(
    `INSERT INTO agents(agent_id,owner_id) VALUES($1,$4),($2,$4),($3,$4)`,
    [SENDER, RECIPIENT, BYSTANDER, HUMAN],
  );
  daemon = new HelperDaemonService(db, new LiveHub());
}, 30_000);

beforeEach(async () => {
  await db.query('DELETE FROM agent_commands');
  await db.query('DELETE FROM workspaces');
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Handoff parity')`, [WS]);
  await db.query(
    `INSERT INTO institutional_memory_workspace_rollouts(workspace_id,stage) VALUES($1,'live')`,
    [WS],
  );
  await db.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES
      ($1,$3,NULL,'alpha-chat',$4),($2,$3,$1,'handoff-thread',$4)`,
    [CHAT, THREAD, WS, HUMAN],
  );
  for (const member of [HUMAN, SENDER, RECIPIENT, BYSTANDER]) {
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
        ($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WS, member, CHAT],
    );
  }
  await insertCornerFacts(db, { cornerId: THREAD, ownerAgentId: SENDER });
});

afterAll(async () => db.close());

describe('private hand-off parity across list, search, and read', () => {
  it('agrees across list, search, and read for bystander vs participant callers without leaking author or text', async () => {
    const publicId = '1'.repeat(64);
    await db.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation)
       VALUES($1,$2,$3,'Public cobalt-lantern status note','message')`,
      [publicId, CHAT, HUMAN],
    );

    // Private hand-off card (normal agent-to-agent message) in the thread.
    const threadHandoff = await sendMessage(db, {
      type: 'normal',
      route: { from: { agent: SENDER, place: CHAT }, to: { agent: RECIPIENT, place: THREAD } },
      text: 'Confidential obsidian-falcon order payload',
    });

    // Private hand-off message (blocked report to agent commander) in the chat.
    const blockedHandoff = await sendMessage(db, {
      type: 'blocked',
      route: { from: { agent: SENDER, place: THREAD }, to: { agent: RECIPIENT, place: CHAT } },
      text: 'Confidential cobalt-lantern blocker secret',
    });

    // A public message replying to the private blocked hand-off must not leak parent author/text to bystanders.
    const replyToBlockedId = '2'.repeat(64);
    await db.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation,reply_to_message_id)
       VALUES($1,$2,$3,'Noted in chat','message',$4)`,
      [replyToBlockedId, CHAT, HUMAN, blockedHandoff.id],
    );

    // 1. Bystander caller: list shows only non-openable placeholders with no author/text/id,
    //    search omits the private hand-off, and read refuses with 403.
    const bystanderChatPage = await readAgentMessagePage({ roomId: CHAT, limit: 8 }, (input) =>
      daemon.execute('getRoomConversation', input, BYSTANDER),
    );
    const bystanderChatJson = JSON.stringify(bystanderChatPage);
    expect(bystanderChatJson).not.toContain('Confidential cobalt-lantern blocker secret');
    expect(bystanderChatJson).not.toContain(blockedHandoff.id!);
    expect(bystanderChatJson).not.toContain(SENDER);
    expect(bystanderChatPage.items).toContainEqual(
      expect.objectContaining({
        type: 'private-handoff',
        openable: false,
        body: '[private hand-off]',
      }),
    );
    const placeholder = bystanderChatPage.items.find((item) => item.type === 'private-handoff')!;
    expect(placeholder.id).toBeUndefined();
    expect(placeholder.messageId).toBeUndefined();
    expect(placeholder.authorId).toBeUndefined();
    expect(placeholder.authorHandle).toBeUndefined();
    expect(placeholder.cursor).toBeUndefined();
    expect(bystanderChatPage.items.find((item) => item.id === replyToBlockedId)?.repliesTo).toBeUndefined();

    const bystanderThreadPage = await readAgentMessagePage({ roomId: THREAD, limit: 8 }, (input) =>
      daemon.execute('getRoomConversation', input, BYSTANDER),
    );
    expect(JSON.stringify(bystanderThreadPage)).not.toContain('obsidian-falcon');
    expect(JSON.stringify(bystanderThreadPage)).not.toContain(threadHandoff.id!);
    expect(bystanderThreadPage.items).toEqual([
      expect.objectContaining({
        type: 'private-handoff',
        openable: false,
        body: '[private hand-off]',
      }),
    ]);

    const bystanderSearchByBody = await searchInstitutionalHistory(db, {
      agentId: BYSTANDER,
      roomId: CHAT,
      query: 'cobalt-lantern',
      limit: 10,
    });
    expect(bystanderSearchByBody.results.map((row) => row.messageId)).toEqual([publicId]);

    const bystanderSearchByRoom = await searchInstitutionalHistory(db, {
      agentId: BYSTANDER,
      roomId: CHAT,
      query: 'alpha-chat',
      limit: 10,
    });
    expect(bystanderSearchByRoom.results.map((row) => row.messageId)).not.toContain(blockedHandoff.id);

    await expect(
      daemon.execute('getRoomMessage', { roomId: CHAT, messageId: blockedHandoff.id! }, BYSTANDER),
    ).rejects.toThrow('message access denied: private hand-off');
    await expect(
      daemon.execute('getRoomMessage', { roomId: THREAD, messageId: threadHandoff.id! }, BYSTANDER),
    ).rejects.toThrow('message access denied: private hand-off');

    const bystanderReplyRead = await daemon.execute(
      'getRoomMessage',
      { roomId: CHAT, messageId: replyToBlockedId },
      BYSTANDER,
    );
    expect(bystanderReplyRead.repliesTo).toBeUndefined();

    // 2. Authorized participant callers (sender and recipient): list, search, and read all succeed.
    for (const participant of [SENDER, RECIPIENT]) {
      const chatPage = await readAgentMessagePage({ roomId: CHAT, limit: 8 }, (input) =>
        daemon.execute('getRoomConversation', input, participant),
      );
      expect(chatPage.items.find((item) => item.id === blockedHandoff.id)).toMatchObject({
        id: blockedHandoff.id,
        messageId: blockedHandoff.id,
        authorId: SENDER,
        body: 'Confidential cobalt-lantern blocker secret',
      });

      const threadPage = await readAgentMessagePage({ roomId: THREAD, limit: 8 }, (input) =>
        daemon.execute('getRoomConversation', input, participant),
      );
      expect(threadPage.items.find((item) => item.id === threadHandoff.id)).toMatchObject({
        id: threadHandoff.id,
        authorId: SENDER,
        body: 'Confidential obsidian-falcon order payload',
      });

      const search = await searchInstitutionalHistory(db, {
        agentId: participant,
        roomId: CHAT,
        query: 'cobalt-lantern',
        limit: 10,
      });
      expect(search.results.map((row) => row.messageId)).toContain(blockedHandoff.id);

      const readBlocked = await daemon.execute(
        'getRoomMessage',
        { roomId: CHAT, messageId: blockedHandoff.id! },
        participant,
      );
      expect(readBlocked.body).toBe('Confidential cobalt-lantern blocker secret');

      const readThread = await daemon.execute(
        'getRoomMessage',
        { roomId: THREAD, messageId: threadHandoff.id! },
        participant,
      );
      expect(readThread.body).toBe('Confidential obsidian-falcon order payload');
    }

    // 3. Corner restore state does not leak unreadable private hand-off text as lastMessage.
    const nested = await sendMessage(db, {
      type: 'blocked',
      route: { from: { agent: SENDER, place: THREAD }, to: { agent: RECIPIENT, place: THREAD } },
      text: 'Private nested blocker text',
    });
    const bystanderRestore = await daemon.execute('getCornerRestoreState', { cornerId: THREAD }, BYSTANDER);
    expect(JSON.stringify(bystanderRestore)).not.toContain('Private nested blocker text');
    expect(bystanderRestore.lastMessage).toBeUndefined();
    const recipientRestore = await daemon.execute('getCornerRestoreState', { cornerId: THREAD }, RECIPIENT);
    expect(recipientRestore.lastMessage?.excerpt).toBe('Private nested blocker text');
    expect(nested.id).toBeTruthy();

    // 4. Revoked membership: even the original sender loses access across list, search, and read.
    await db.query(
      `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
      [CHAT, SENDER],
    );
    await expect(
      daemon.execute('getRoomMessage', { roomId: CHAT, messageId: blockedHandoff.id! }, SENDER),
    ).rejects.toThrow();
    await expect(
      daemon.execute('getRoomConversation', { roomId: CHAT, limit: 8 }, SENDER),
    ).rejects.toThrow();
    await expect(
      searchInstitutionalHistory(db, { agentId: SENDER, roomId: CHAT, query: 'cobalt-lantern', limit: 10 }),
    ).rejects.toThrow();
  });
});

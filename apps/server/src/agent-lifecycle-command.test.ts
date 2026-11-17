import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { parseTaggedAgentLifecycleCommand, type CommandRow } from './agent-command.js';
import { beginAgentSignInCards } from './agent-sign-in.js';
import { announceAgentLifecycle } from './connection-presence.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { routeHumanMessage } from './test-fixtures/queue-routing.test-support.js';
import { startQueuedTurn } from './test-fixtures/queued-turn.test-support.js';
import { PgliteDatabase,migratedDatabase } from './test-support.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const OWNER = 'a'.repeat(64);
const MEMBER = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);

describe('tagged agent lifecycle commands', () => {
  let database: PgliteDatabase;
  let live: LiveHub;

  beforeEach(async () => {
    database = await migratedDatabase();
    live = new LiveHub();
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Owner','owner'),($2,'human','Member','member'),($3,'agent','Bee','bee')`,
      [OWNER, MEMBER, AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id,harness) VALUES($1,$2,'cursor')`, [AGENT, OWNER]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$3,'owner'),($1,NULL,$4,'member'),($1,NULL,$5,'member'),
       ($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member')`,
      [WORKSPACE, ROOM, OWNER, MEMBER, AGENT],
    );
    await announceAgentLifecycle(database, live, ROOM, AGENT, { lifecycleId: 'boot-1' });
  });

  afterEach(async () => database.close());

  async function send(id: string, author: string, text: string) {
    await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`, [
      id,
      ROOM,
      author,
      text,
    ]);
    await routeHumanMessage(database, id);
  }

  it('parses only an exact tagged command', () => {
    expect(parseTaggedAgentLifecycleCommand('@bee restart', 'bee')).toBe('restart');
    expect(parseTaggedAgentLifecycleCommand('@bee /restart', 'bee')).toBe('restart');
    expect(parseTaggedAgentLifecycleCommand(' @BEE /RESTART ', 'bee')).toBe('restart');
    expect(parseTaggedAgentLifecycleCommand(' @BEE STATUS ', 'bee')).toBe('status');
    expect(parseTaggedAgentLifecycleCommand('@bee /status', 'bee')).toBeUndefined();
    expect(parseTaggedAgentLifecycleCommand('@bee /restart please', 'bee')).toBeUndefined();
    expect(parseTaggedAgentLifecycleCommand('@bee restart please', 'bee')).toBeUndefined();
    expect(parseTaggedAgentLifecycleCommand('restart @bee', 'bee')).toBeUndefined();
    expect(parseTaggedAgentLifecycleCommand('@other restart', 'bee')).toBeUndefined();
    expect(parseTaggedAgentLifecycleCommand('@bee login', 'bee')).toBe('login');
    expect(parseTaggedAgentLifecycleCommand(' @Bee /LOGIN ', 'bee')).toBe('login');
    expect(parseTaggedAgentLifecycleCommand('@bee login now', 'bee')).toBeUndefined();
  });


  it.each(['restart', '/restart'])('routes @bee %s as one active restart control despite resends', async command => {
    const phone = new PhoneService(database, 'http://test');
    for (const id of ['1'.repeat(64), '1'.repeat(64), '2'.repeat(64)])
      await phone.execute('sendRoomMessage', { roomId: ROOM, messageId: id, text: `@bee ${command}` }, MEMBER);
    expect((await database.query('SELECT action,state,reason FROM agent_commands')).rows).toEqual([
      { action: 'restart', state: 'pending', reason: 'tagged_lifecycle_restart' },
    ]);
    expect((await database.query("SELECT 1 FROM messages WHERE presentation='system'")).rowCount).toBe(0);
  });

  it.each(['status', 'debug', 'help'])('leaves @bee %s as ordinary input without a retired System notice', async command => {
    await send('1'.repeat(64), MEMBER, `@bee ${command}`);
    expect((await database.query('SELECT action,message FROM agent_commands')).rows)
      .toEqual([{ action: 'input', message: expect.objectContaining({ body: `@bee ${command}` }) }]);
    expect((await database.query("SELECT 1 FROM messages WHERE presentation='system'")).rowCount).toBe(0);
  });

  it.each(['/login', 'login'])('commits a starting card for the owner’s %s that the sign-in starter picks up', async command => {
    const sourceId = '1'.repeat(64);
    await send(sourceId, OWNER, `@bee ${command}`);
    await send(sourceId, OWNER, `@bee ${command}`);
    expect((await database.query("SELECT card FROM messages WHERE card_type='agent-sign-in'")).rows)
      .toEqual([{ card: expect.objectContaining({ agentId: AGENT, ownerId: OWNER,
        harness: 'cursor', sourceMessageId: sourceId, status: 'starting' }) }]);
    expect((await database.query('SELECT 1 FROM agent_commands')).rowCount).toBe(0);
    await beginAgentSignInCards(database, live, ROOM, sourceId);
    // No helper is connected in this fixture: picking up the card settles that failure in place.
    expect((await database.query("SELECT card FROM messages WHERE card_type='agent-sign-in'")).rows)
      .toEqual([{ card: expect.objectContaining({ status: 'failed', attemptId: expect.any(String) }) }]);
  });

  it('uses the key setup action for an API-key harness', async () => {
    await database.query("UPDATE agents SET harness='pi' WHERE agent_id=$1", [AGENT]);
    await send('1'.repeat(64), OWNER, '@bee /login');
    expect((await database.query("SELECT card FROM messages WHERE card_type='agent-sign-in'")).rows)
      .toEqual([{ card: expect.objectContaining({ harness: 'pi', status: 'starting', action: 'Set key for its provider' }) }]);
    expect((await database.query('SELECT 1 FROM agent_commands')).rowCount).toBe(0);
  });

  it.each([MEMBER, OWNER])('consumes unavailable login without queueing it (%s)', async author => {
    if (author === OWNER) await database.query("UPDATE agents SET harness='custom' WHERE agent_id=$1", [AGENT]);
    await send('1'.repeat(64), author, '@bee /login');
    expect((await database.query('SELECT 1 FROM agent_commands')).rowCount).toBe(0);
    expect((await database.query("SELECT 1 FROM messages WHERE card_type='agent-sign-in'")).rowCount).toBe(0);
  });

  it('leaves non-exact commands as ordinary input', async () => {
    await send('1'.repeat(64), OWNER, '@bee /login please');
    expect((await database.query('SELECT action,message FROM agent_commands')).rows)
      .toEqual([{ action: 'input', message: expect.objectContaining({ body: '@bee /login please' }) }]);
  });

  it('retries the failed request with its original input and ancestry', async () => {
    await send('1'.repeat(64), MEMBER, '@bee original work');
    const failed = (await database.query<CommandRow>('SELECT * FROM agent_commands')).rows[0]!;
    await startQueuedTurn(database, ROOM, AGENT, failed.id);
    await database.query("UPDATE agent_turns SET status='failed' WHERE agent_id=$1", [AGENT]);
    await send('2'.repeat(64), MEMBER, '@bee retry');
    expect((await database.query("SELECT action,reason,parent_command_id,message FROM agent_commands WHERE source_message_id=$1", ['2'.repeat(64)])).rows)
      .toEqual([{ action: 'input', reason: 'tagged_lifecycle_retry', parent_command_id: failed.id,
        message: expect.objectContaining({ body: '@bee original work', authorId: MEMBER }) }]);
    expect((await database.query("SELECT 1 FROM messages WHERE presentation='system'")).rowCount).toBe(0);
  });

  it('consumes retry without a failed turn rather than queueing the command text', async () => {
    await send('1'.repeat(64), MEMBER, '@bee retry');
    expect((await database.query('SELECT 1 FROM agent_commands')).rowCount).toBe(0);
  });

  it('exact tagged Stop still cancels pending work without queueing control text', async () => {
    await send('1'.repeat(64), MEMBER, '@bee work');
    const item = (await database.query<{ id: string }>('SELECT id FROM agent_commands')).rows[0]!;
    await startQueuedTurn(database, ROOM, AGENT, item.id);
    await send('2'.repeat(64), MEMBER, '@bee stop');
    expect((await database.query('SELECT state FROM agent_commands WHERE id=$1', [item.id])).rows).toEqual([{ state: 'cancelled' }]);
    expect((await database.query('SELECT status FROM agent_turns')).rows).toEqual([{ status: 'cancelled' }]);
    expect((await database.query("SELECT 1 FROM agent_commands WHERE action='stop'")).rowCount).toBe(0);
  });
});

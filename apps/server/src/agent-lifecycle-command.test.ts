import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { createAgentCommand, parseTaggedAgentLifecycleCommand, type CommandRow } from './agent-command.js';
import { migratePendingAgentPlaceResets } from './agent-place-reset.js';
import { beginAgentSignInCards } from './agent-sign-in.js';
import { announceAgentLifecycle } from './connection-presence.js';
import { DaemonService } from './daemon-service.js';
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


  it.each(['restart', '/restart'])('commits @bee %s immediately and returns only the latest reset on an empty queue', async command => {
    const phone = new PhoneService(database, 'http://test');
    const daemon = new DaemonService(database, live);
    for (const id of ['1'.repeat(64), '1'.repeat(64), '2'.repeat(64)])
      await phone.execute('sendRoomMessage', { roomId: ROOM, messageId: id, text: `@bee ${command}` }, MEMBER);
    const { rows } = await database.query<{ id: string }>(
      'SELECT id,action,state,reason,restart_confirmed_at,completed_at FROM agent_commands ORDER BY inbox_sequence');
    expect(rows).toEqual([
      expect.objectContaining({ action: 'restart', state: 'complete', reason: 'tagged_lifecycle_restart',
        restart_confirmed_at: null, completed_at: expect.any(Date) }),
      expect.objectContaining({ action: 'restart', state: 'complete', reason: 'tagged_lifecycle_restart',
        restart_confirmed_at: null, completed_at: expect.any(Date) }),
    ]);
    expect(await daemon.execute('getAgentCommands', {}, AGENT)).toMatchObject({
      commands: [], resets: [{ roomId: ROOM, id: rows[1]!.id }],
    });
    expect((await database.query("SELECT 1 FROM messages WHERE presentation='system'")).rowCount).toBe(0);
  });

  it('completes a restart behind an unanswered tag and rejects the retired invocation before a fresh turn starts', async () => {
    const phone = new PhoneService(database, 'http://test');
    const daemon = new DaemonService(database, live);
    await phone.execute('sendRoomMessage', { roomId: ROOM, text: '@bee Please answer' }, MEMBER);
    const [tag] = (await daemon.execute('getAgentCommands', {}, AGENT)).commands;
    const address = { roomId: ROOM, requestId: tag!.turnRequestId };
    const old = { id: 'old', requestId: address.requestId };
    await daemon.execute('startAgentTurn', { ...address, invocationId: old.id, resetId: null }, AGENT);
    const thought = { agentId: AGENT, roomId: ROOM, turnId: address.requestId, invocation: old, text: 'Old thought' };
    await daemon.execute('postAgentThought', thought, AGENT);
    const thoughts = () => database.query("SELECT 1 FROM live_outputs WHERE agent_id=$1 AND room_id=$2 AND kind='thought'", [AGENT, ROOM]);
    expect((await thoughts()).rowCount).toBe(1);
    const requested = await phone.execute('sendRoomMessage', { roomId: ROOM, text: '@bee /restart' }, MEMBER);
    expect(requested.pendingAgentCommands).toEqual([]);
    const page = await daemon.execute('getAgentCommands', {}, AGENT);
    expect(page.commands.map(command => command.id)).toEqual([tag!.id]);
    expect(page.resets).toEqual([{ roomId: ROOM, id: expect.any(String) }]);
    const resetId = page.resets![0]!.id;
    expect((await database.query('SELECT state,restart_confirmed_at FROM agent_commands WHERE id=$1', [resetId])).rows)
      .toEqual([{ state: 'complete', restart_confirmed_at: null }]);
    await expect(daemon.execute('startAgentTurn', { ...address, invocationId: old.id, resetId: null }, AGENT))
      .rejects.toThrow();
    await daemon.execute('postAgentThought', thought, AGENT);
    expect((await thoughts()).rowCount).toBe(0);
    expect(await daemon.execute('postRoomMessage', { ...address, invocation: old, text: 'Obsolete', harnessEnded: true }, AGENT))
      .toMatchObject({ answered: false });
    expect((await daemon.execute('getAgentCommands', {}, AGENT)).commands.map(command => command.id)).toEqual([tag!.id]);

    const fresh = { id: 'fresh', requestId: address.requestId };
    await daemon.execute('startAgentTurn', { ...address, invocationId: fresh.id, resetId }, AGENT);
    await daemon.execute('postRoomMessage', { ...address, invocation: fresh, text: 'Fresh answer', harnessEnded: true }, AGENT);
    expect((await daemon.execute('getAgentCommands', {}, AGENT)).commands).toEqual([]);
    expect((await database.query('SELECT restart_confirmed_at FROM agent_commands WHERE id=$1', [resetId])).rows)
      .toEqual([{ restart_confirmed_at: expect.any(Date) }]);
    expect((await database.query('SELECT text FROM messages WHERE author_id=$1 AND room_id=$2', [AGENT, ROOM])).rows)
      .toEqual([{ text: 'Fresh answer' }]);
  });

  it('completes a pending restart left by an older server without consuming its tag', async () => {
    await send('1'.repeat(64), MEMBER, '@bee Please answer');
    const legacy = await createAgentCommand(database, {
      roomId: ROOM, agentId: AGENT, sourceMessageId: null, action: 'restart', reason: 'tagged_lifecycle_restart',
    });
    const daemon = new DaemonService(database, live);
    await migratePendingAgentPlaceResets(database);
    await migratePendingAgentPlaceResets(database);
    expect(await daemon.execute('getAgentCommands', {}, AGENT)).toMatchObject({
      commands: [{ action: 'input', sourceMessageId: '1'.repeat(64) }],
      resets: [{ roomId: ROOM, id: legacy!.id }],
    });
    expect((await database.query('SELECT state FROM agent_commands WHERE id=$1', [legacy!.id])).rows)
      .toEqual([{ state: 'complete' }]);
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

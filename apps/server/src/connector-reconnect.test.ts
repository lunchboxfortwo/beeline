import {
  describe, expect, it, fixtureScope1, opaque, createAgentCommand, pendingMcpWakes, ROOM, USER, AGENT,
} from './test-support-rooms-mcp.test-support.js';
import { randomBytes } from 'node:crypto';
import { CONNECTOR_RECONNECT_RETIRED } from './rooms-mcp-delivery.js';
import { retireStuckConnectorCommands } from './migrations/stuck-connector-commands.js';

/** The owner's no-timer rule: a connector's reconnect retires what was queued before it went offline. */
describe('CONNECTOR-RECONNECT: event-driven retirement on the agent-command queue', () => {
  const scope = fixtureScope1();
  const data = (result: any) => JSON.parse(result.content[0].text).data;
  // A member with no delivery binding is online exactly while it has an inbound webhook.
  const online = (client: any) => client.callTool({ name: 'set_webhook', arguments: { url: `https://hooks.example/${opaque()}` } });
  const offline = (client: any) => client.callTool({ name: 'set_webhook', arguments: { url: '' } });
  const connector = async () => {
    const connected = await scope.connected();
    const handle = data(await connected.client.callTool({ name: 'list_chats', arguments: {} })).you.handle as string;
    await online(connected.client);
    return { ...connected, handle };
  };
  const tag = async (handle: string, text: string) => {
    const sent = await scope.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} ${text}` }, USER);
    await scope.db.backgroundWork.drain();
    return sent.messageId as string;
  };
  const commandFor = async (member: string, source: string) => (await scope.db.query<{ id: string; state: string; cancellation_reason: string | null; turn_request_id: string }>(
    'SELECT id,state,cancellation_reason,turn_request_id FROM agent_commands WHERE agent_id=$1 AND source_message_id=$2', [member, source])).rows;
  const owed = async (member: string, message: string) => (await scope.db.query(
    'SELECT 1 FROM rooms_mcp_mentions WHERE member_id=$1 AND message_id=$2 AND cleared_at IS NULL', [member, message])).rowCount;
  const roomMessages = async () => Number((await scope.db.query<{ n: string }>('SELECT count(*) n FROM messages')).rows[0]!.n);
  const commandCount = async () => Number((await scope.db.query<{ n: string }>('SELECT count(*) n FROM agent_commands')).rows[0]!.n);
  /** A committed answer under the command's request: the connector already claimed it. */
  const answer = (member: string, request: string) => scope.db.query(
    'INSERT INTO messages(id,room_id,author_id,text,request_id) VALUES($1,$2,$3,$4,$5)',
    [randomBytes(32).toString('hex'), ROOM, member, 'on it', request]);

  it('connector-pending-1: a tag sent while offline shows only the offline line, and the reconnect retires it without running it', async () => {
    const { client, member, handle } = await connector();
    const before = await tag(handle, 'queued while connected');
    const [queued] = await commandFor(member, before);
    expect(queued?.state).toBe('pending');

    await offline(client);
    expect((await scope.db.query('SELECT disconnected_at FROM rooms_mcp_members WHERE member_id=$1', [member])).rows[0]!.disconnected_at).not.toBeNull();
    const during = await tag(handle, 'are you there?');
    expect((await commandFor(member, during))[0]?.state).toBe('pending');
    const lines = (await scope.phone.readRoom(ROOM, USER))?.messages
      .filter(message => message.author.pubkey === member && message.presentation === 'system').map(message => message.text);
    expect(lines).toEqual([`@${handle} is offline · connect again`]);

    // Work queued after the connector was last seen offline is not retired by the reconnect.
    const order = (await createAgentCommand(scope.db, {
      roomId: ROOM, agentId: member, sourceMessageId: null, reason: 'order',
      privatePayload: { kind: 'order', authorId: USER, fromRoomId: ROOM, text: 'after the disconnect' },
    }))!;
    const messages = await roomMessages(), commands = await commandCount();

    await online(client);
    await scope.db.backgroundWork.drain();
    for (const source of [before, during])
      expect(await commandFor(member, source)).toEqual([expect.objectContaining({ state: 'cancelled', cancellation_reason: CONNECTOR_RECONNECT_RETIRED })]);
    expect((await pendingMcpWakes(scope.db, member)).map(wake => wake.id)).toEqual([order.id]);
    expect(await owed(member, before)).toBe(0);
    expect(await owed(member, during)).toBe(0);
    const caughtUp = data(await client.callTool({ name: 'list_mentions', arguments: {} }));
    expect(caughtUp.mentions).toEqual([]);
    expect(caughtUp.wakes.map((wake: { id: string }) => wake.id)).toEqual([order.id]);
    // Nothing is posted and nobody is woken.
    expect(await roomMessages()).toBe(messages);
    expect(await commandCount()).toBe(commands);
  });

  it('keeps work queued while connected and work the connector already claimed', async () => {
    const { client, member, handle } = await connector();
    const claimedSource = await tag(handle, 'claimed before the disconnect');
    const [claimed] = await commandFor(member, claimedSource);
    await answer(member, claimed!.turn_request_id);
    const connectedSource = await tag(handle, 'queued while connected');

    // A delivery change while still connected is not a reconnect.
    await online(client);
    expect((await commandFor(member, connectedSource))[0]?.state).toBe('pending');

    await offline(client);
    await online(client);
    expect((await commandFor(member, claimedSource))[0]?.state).toBe('pending');
    expect((await commandFor(member, connectedSource))[0]).toMatchObject({ state: 'cancelled', cancellation_reason: CONNECTOR_RECONNECT_RETIRED });
  });

  it('retires the old stuck connector commands once, silently, and leaves other agents alone', async () => {
    const { member, handle } = await connector();
    const stale = await tag(handle, 'stuck since 14 Nov');
    const claimedSource = await tag(handle, 'stuck but claimed');
    const recent = await tag(handle, 'queued after the cutoff');
    const [claimed] = await commandFor(member, claimedSource);
    await answer(member, claimed!.turn_request_id);
    const helper = (await createAgentCommand(scope.db, {
      roomId: ROOM, agentId: AGENT, sourceMessageId: null, reason: 'order',
      privatePayload: { kind: 'order', authorId: USER, fromRoomId: ROOM, text: 'non-connector work' },
    }))!;
    await scope.db.query("UPDATE agent_commands SET created_at='2026-11-14T13:48:23Z' WHERE id=ANY($1::text[])",
      [[...(await commandFor(member, stale)), claimed!].map(command => command.id).concat(helper.id)]);
    await scope.db.query("UPDATE rooms_mcp_mentions SET created_at='2026-11-14T13:48:23Z' WHERE member_id=$1 AND message_id=ANY($2::text[])",
      [member, [stale, claimedSource]]);
    const messages = await roomMessages(), commands = await commandCount();

    const first = await retireStuckConnectorCommands(scope.db);
    expect(first.commands).toBeGreaterThanOrEqual(1);
    expect(first.tags).toBeGreaterThanOrEqual(1);
    expect((await commandFor(member, stale))[0]).toMatchObject({ state: 'cancelled', cancellation_reason: CONNECTOR_RECONNECT_RETIRED });
    expect(await owed(member, stale)).toBe(0);
    expect((await commandFor(member, claimedSource))[0]?.state).toBe('pending');
    expect((await commandFor(member, recent))[0]?.state).toBe('pending');
    expect(await owed(member, recent)).toBe(1);
    expect((await scope.db.query('SELECT state FROM agent_commands WHERE id=$1', [helper.id])).rows[0]!.state).toBe('pending');
    expect(await roomMessages()).toBe(messages);
    expect(await commandCount()).toBe(commands);

    // Safe to run twice: the fixed cutoff finds nothing new.
    expect(await retireStuckConnectorCommands(scope.db)).toEqual({ commands: 0, tags: 0 });
  });
});

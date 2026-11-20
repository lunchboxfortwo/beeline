import {
  describe,
  expect,
  it,
  vi,
  deliverMcpMemberWebhooks,
  fixtureScope1,
  opaque,
  createAgentCommand,
  pendingMcpWakes,
  ROOM,
  USER,
  OTHER,
  WORKSPACE,
  AGENT,
} from './test-support-rooms-mcp.test-support.js';
import { randomBytes } from 'node:crypto';
import { CONNECTOR_RECONNECT_RETIRED } from './rooms-mcp-delivery.js';
import { deliverMcpEvents } from './rooms-mcp-events.js';
import { retireStuckConnectorCommands } from './migrations/stuck-connector-commands.js';

/** The owner's no-timer rule: a connector's reconnect retires what was queued before it went offline. */
describe('CONNECTOR-RECONNECT: event-driven retirement on the agent-command queue', () => {
  const scope = fixtureScope1();
  const data = (result: any) => JSON.parse(result.content[0].text).data;
  // A member with no delivery binding is online exactly while it has an inbound webhook.
  const online = (client: any) =>
    client.callTool({
      name: 'set_webhook',
      arguments: { url: `https://hooks.example/${opaque()}` },
    });
  const offline = (client: any) => client.callTool({ name: 'set_webhook', arguments: { url: '' } });
  const connector = async () => {
    const connected = await scope.connected();
    const handle = data(await connected.client.callTool({ name: 'list_chats', arguments: {} })).you
      .handle as string;
    await online(connected.client);
    return { ...connected, handle };
  };
  const tag = async (handle: string, text: string) => {
    const sent = await scope.phone.execute(
      'sendRoomMessage',
      { roomId: ROOM, text: `@${handle} ${text}` },
      USER,
    );
    await scope.db.backgroundWork.drain();
    return sent.messageId as string;
  };
  const commandFor = async (member: string, source: string) =>
    (
      await scope.db.query<{
        id: string;
        state: string;
        cancellation_reason: string | null;
        turn_request_id: string;
      }>(
        'SELECT id,state,cancellation_reason,turn_request_id FROM agent_commands WHERE agent_id=$1 AND source_message_id=$2',
        [member, source],
      )
    ).rows;
  const owed = async (member: string, message: string) =>
    (
      await scope.db.query(
        'SELECT 1 FROM rooms_mcp_mentions WHERE member_id=$1 AND message_id=$2 AND cleared_at IS NULL',
        [member, message],
      )
    ).rowCount;
  const roomMessages = async () =>
    Number((await scope.db.query<{ n: string }>('SELECT count(*) n FROM messages')).rows[0]!.n);
  const commandCount = async () =>
    Number(
      (await scope.db.query<{ n: string }>('SELECT count(*) n FROM agent_commands')).rows[0]!.n,
    );
  /** A committed answer under the command's request: the connector already claimed it. */
  const answer = (member: string, request: string) =>
    scope.db.query(
      'INSERT INTO messages(id,room_id,author_id,text,request_id) VALUES($1,$2,$3,$4,$5)',
      [randomBytes(32).toString('hex'), ROOM, member, 'on it', request],
    );

  it.each(['webhook', 'events'])('accepts distinct %s orders sharing a tag source', async (mechanism) => {
    const fixture = mechanism === 'webhook' ? await connector() : await scope.eventFixture();
    const { client, member } = fixture;
    if ('params' in fixture) await scope.eventCall(fixture.token, 'events/subscribe', fixture.params);
    const handle = data(await client.callTool({ name: 'list_chats', arguments: {} })).you.handle;
    const source = await tag(handle, 'public request');
    const drain = mechanism === 'webhook' ? deliverMcpMemberWebhooks : deliverMcpEvents;
    const accepted: string[] = [];
    const transport = async (_url: string, init: { body: string }) => {
      accepted.push(init.body);
      return new Response(null, { status: 204 });
    };
    await drain(scope.db, transport);
    // The queue contract gives a private order its own identity and payload,
    // even when its provenance names an already delivered public message.
    const order = await createAgentCommand(scope.db, {
      roomId: ROOM, agentId: member, sourceMessageId: source, reason: 'order',
      privatePayload: { kind: 'order', authorId: USER, fromRoomId: ROOM, text: 'separate private assignment' },
    });
    expect(await pendingMcpWakes(scope.db, member)).toContainEqual(expect.objectContaining({ id: order!.id }));
    const before = accepted.length;
    await drain(scope.db, transport);
    expect(accepted.slice(before)).toHaveLength(1);
    expect(accepted[before]).toContain('separate private assignment');
    expect(await pendingMcpWakes(scope.db, member)).toEqual([]);
    expect((await scope.db.query('SELECT state FROM agent_commands WHERE id=$1', [order!.id])).rows)
      .toEqual([{ state: 'pending' }]);
  });

  it('connector-pending-1: a tag sent while offline shows only the offline line, and the reconnect retires it without running it', async () => {
    const { client, member, handle } = await connector();
    const before = await tag(handle, 'queued while connected');
    const [queued] = await commandFor(member, before);
    expect(queued?.state).toBe('pending');

    await offline(client);
    expect(
      (
        await scope.db.query('SELECT disconnected_at FROM rooms_mcp_members WHERE member_id=$1', [
          member,
        ])
      ).rows[0]!.disconnected_at,
    ).not.toBeNull();
    const during = await tag(handle, 'are you there?');
    expect((await commandFor(member, during))[0]?.state).toBe('pending');
    const lines = (await scope.phone.readRoom(ROOM, USER))?.messages
      .filter((message) => message.author.pubkey === member && message.presentation === 'system')
      .map((message) => message.text);
    expect(lines).toEqual([`@${handle} is offline · connect again`]);

    // Work queued after the connector was last seen offline is not retired by the reconnect.
    const order = (await createAgentCommand(scope.db, {
      roomId: ROOM,
      agentId: member,
      sourceMessageId: null,
      reason: 'order',
      privatePayload: {
        kind: 'order',
        authorId: USER,
        fromRoomId: ROOM,
        text: 'after the disconnect',
      },
    }))!;
    const messages = await roomMessages(),
      commands = await commandCount();

    await online(client);
    await scope.db.backgroundWork.drain();
    for (const source of [before, during])
      expect(await commandFor(member, source)).toEqual([
        expect.objectContaining({
          state: 'cancelled',
          cancellation_reason: CONNECTOR_RECONNECT_RETIRED,
        }),
      ]);
    expect((await pendingMcpWakes(scope.db, member)).map((wake) => wake.id)).toEqual([order.id]);
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
    expect((await commandFor(member, connectedSource))[0]).toMatchObject({
      state: 'cancelled',
      cancellation_reason: CONNECTOR_RECONNECT_RETIRED,
    });
  });

  it.each(['webhook', 'events', 'unsubscribe'])(
    'keeps %s-accepted commands pending without replaying them after reconnect',
    async (mechanism) => {
      const fixture = mechanism !== 'webhook' ? await scope.eventFixture() : await connector();
      const { client, member } = fixture;
      const handle = data(await client.callTool({ name: 'list_chats', arguments: {} })).you
        .handle as string;
      if ('params' in fixture)
        expect(
          (await scope.eventCall(fixture.token, 'events/subscribe', fixture.params)).error,
        ).toBeUndefined();
      const source = await tag(handle, 'accepted before disconnect');
      const [command] = await commandFor(member, source);
      expect(command?.state).toBe('pending');
      const delivered: string[] = [];
      const accept = async (_url: string, init: { body: string }) => {
        delivered.push(init.body);
        return new Response(null, { status: 204 });
      };
      if (mechanism !== 'webhook') await deliverMcpEvents(scope.db, accept);
      else await deliverMcpMemberWebhooks(scope.db, accept);
      expect(delivered.some((body) => body.includes(source) || body.includes(command!.id))).toBe(
        true,
      );

      if ('params' in fixture) {
        if (mechanism === 'unsubscribe') {
          const { secret: _, ...delivery } = fixture.params.delivery;
          expect(
            (
              await scope.eventCall(fixture.token, 'events/unsubscribe', {
                name: 'mention',
                arguments: {},
                delivery,
              })
            ).error,
          ).toBeUndefined();
          expect(await pendingMcpWakes(scope.db, member)).toEqual([]);
        } else {
          await scope.db.query(
            "UPDATE rooms_mcp_event_subscriptions SET expires_at=now()-interval '1 second' WHERE member_id=$1",
            [member],
          );
        }
        expect(
          (await scope.eventCall(fixture.token, 'events/subscribe', fixture.params)).error,
        ).toBeUndefined();
      } else {
        await offline(client);
        await online(client);
      }

      expect((await commandFor(member, source))[0]).toMatchObject({
        state: 'pending',
        cancellation_reason: null,
      });
      expect(await pendingMcpWakes(scope.db, member)).toEqual([]);
      const caughtUp = data(await client.callTool({ name: 'list_mentions', arguments: {} }));
      expect(caughtUp.wakes).toEqual([]);
      expect(caughtUp.mentions).toEqual([]);
      const repeated: string[] = [];
      const observe = async (_url: string, init: { body: string }) => {
        repeated.push(init.body);
        return new Response(null, { status: 204 });
      };
      await deliverMcpEvents(scope.db, observe);
      await deliverMcpMemberWebhooks(scope.db, observe);
      expect(repeated.some((body) => body.includes(source) || body.includes(command!.id))).toBe(
        false,
      );
      const fresh = await tag(handle, 'new input after reconnect');
      const [freshCommand] = await commandFor(member, fresh);
      expect((await pendingMcpWakes(scope.db, member)).map((wake) => wake.id)).toEqual([
        freshCommand!.id,
      ]);
    },
  );

  it.each(['webhook', 'events'])(
    'preserves a %s dispatch while reconnect and historical retirement run before HTTP returns',
    async (mechanism) => {
      const fixture = mechanism === 'events' ? await scope.eventFixture() : await connector();
      const { client, member } = fixture;
      const handle = data(await client.callTool({ name: 'list_chats', arguments: {} })).you
        .handle as string;
      if ('params' in fixture)
        expect(
          (await scope.eventCall(fixture.token, 'events/subscribe', fixture.params)).error,
        ).toBeUndefined();
      const source = await tag(handle, 'dispatch already started');
      const [command] = await commandFor(member, source);
      await scope.db.query(
        "UPDATE agent_commands SET created_at='2026-11-14T13:48:23Z' WHERE id=$1",
        [command!.id],
      );
      let observed = false;
      let transportFailure: unknown;
      const transport = async (_url: string, init: { body: string }) => {
        try {
          if (!observed && (init.body.includes(source) || init.body.includes(command!.id))) {
            observed = true;
            expect(await pendingMcpWakes(scope.db, member)).toEqual([]);
            if ('params' in fixture) {
              const { secret: _, ...delivery } = fixture.params.delivery;
              expect(
                (
                  await scope.eventCall(fixture.token, 'events/unsubscribe', {
                    name: 'mention',
                    arguments: {},
                    delivery,
                  })
                ).error,
              ).toBeUndefined();
              expect(
                (await scope.eventCall(fixture.token, 'events/subscribe', fixture.params)).error,
              ).toBeUndefined();
            } else {
              await offline(client);
              await online(client);
            }
            await retireStuckConnectorCommands(scope.db);
            expect((await commandFor(member, source))[0]).toMatchObject({
              state: 'pending',
              cancellation_reason: null,
            });
            expect(await pendingMcpWakes(scope.db, member)).toEqual([]);
          }
          return new Response(null, { status: 204 });
        } catch (error) {
          transportFailure = error;
          throw error;
        }
      };
      if (mechanism === 'events') await deliverMcpEvents(scope.db, transport);
      else await deliverMcpMemberWebhooks(scope.db, transport);
      expect(transportFailure).toBeUndefined();
      expect(observed).toBe(true);
      expect((await commandFor(member, source))[0]).toMatchObject({
        state: 'pending',
        cancellation_reason: null,
      });
    },
  );

  it.each(['webhook', 'events'])('retires a failed %s dispatch on reconnect', async (mechanism) => {
    const fixture = mechanism === 'events' ? await scope.eventFixture() : await connector();
    const { client, member } = fixture;
    const handle = data(await client.callTool({ name: 'list_chats', arguments: {} })).you
      .handle as string;
    if ('params' in fixture)
      expect(
        (await scope.eventCall(fixture.token, 'events/subscribe', fixture.params)).error,
      ).toBeUndefined();
    const source = await tag(handle, 'dispatch will fail');
    const [command] = await commandFor(member, source);
    const attempts: string[] = [];
    const fail = async (_url: string, init: { body: string }) => {
      attempts.push(init.body);
      return new Response(null, { status: 503 });
    };
    if (mechanism === 'events') await deliverMcpEvents(scope.db, fail);
    else await deliverMcpMemberWebhooks(scope.db, fail);
    expect(attempts.some((body) => body.includes(source) || body.includes(command!.id))).toBe(true);
    if ('params' in fixture) {
      const { secret: _, ...delivery } = fixture.params.delivery;
      await scope.eventCall(fixture.token, 'events/unsubscribe', {
        name: 'mention',
        arguments: {},
        delivery,
      });
      await scope.eventCall(fixture.token, 'events/subscribe', fixture.params);
    } else {
      await offline(client);
      await online(client);
    }
    expect((await commandFor(member, source))[0]).toMatchObject({
      state: 'cancelled',
      cancellation_reason: CONNECTOR_RECONNECT_RETIRED,
    });
    expect(await owed(member, source)).toBe(0);
  });

  it('retires expired event backlog when a webhook restores an unobserved offline route', async () => {
    const { client, member, token, params } = await scope.eventFixture();
    const handle = data(await client.callTool({ name: 'list_chats', arguments: {} })).you
      .handle as string;
    const subscription = await scope.eventCall(token, 'events/subscribe', params);
    expect(subscription.error).toBeUndefined();
    const stale = await tag(handle, 'waiting on the expired event route');
    expect(
      (
        await scope.db.query('SELECT disconnected_at FROM rooms_mcp_members WHERE member_id=$1', [
          member,
        ])
      ).rows[0]!.disconnected_at,
    ).toBeNull();
    await scope.db.query(
      "UPDATE rooms_mcp_event_subscriptions SET expires_at=now()-interval '1 second' WHERE id=$1",
      [subscription.result.id],
    );

    expect((await online(client)).isError).not.toBe(true);

    expect((await commandFor(member, stale))[0]).toMatchObject({
      state: 'cancelled',
      cancellation_reason: CONNECTOR_RECONNECT_RETIRED,
    });
    expect(await owed(member, stale)).toBe(0);
    expect(await pendingMcpWakes(scope.db, member)).toEqual([]);
    const fresh = await tag(handle, 'new work on the webhook route');
    expect((await commandFor(member, fresh))[0]?.state).toBe('pending');
  });

  it('a rejected sender cannot move the cutoff past an owner order', async () => {
    const { client, member, handle } = await connector();
    await scope.db.query(
      `UPDATE agents SET access_policy='{"type":"creator"}'::jsonb WHERE agent_id=$1`,
      [member],
    );
    await scope.db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')
      ON CONFLICT (room_id,identity_id) WHERE room_id IS NOT NULL DO NOTHING`,
      [WORKSPACE, ROOM, OTHER],
    );
    await offline(client);
    const marker = async () =>
      (
        await scope.db.query<{ cutoff: string }>(
          'SELECT disconnected_at::text cutoff FROM rooms_mcp_members WHERE member_id=$1',
          [member],
        )
      ).rows[0]!.cutoff;
    const before = await marker();
    const order = (await createAgentCommand(scope.db, {
      roomId: ROOM,
      agentId: member,
      sourceMessageId: null,
      reason: 'order',
      privatePayload: {
        kind: 'order',
        authorId: USER,
        fromRoomId: ROOM,
        text: 'owner order after disconnect',
      },
    }))!;

    const rejected = await scope.phone.execute(
      'sendRoomMessage',
      { roomId: ROOM, text: `@${handle} rejected tag` },
      OTHER,
    );
    await scope.db.backgroundWork.drain();

    expect(await commandFor(member, rejected.messageId)).toEqual([]);
    expect(await marker()).toBe(before);
    await online(client);
    expect((await pendingMcpWakes(scope.db, member)).map((wake) => wake.id)).toEqual([order.id]);
  });

  it.each([
    ['reconnect', 'search'],
    ['historical', 'search'],
    ['reconnect', 'message'],
  ])(
    'preserves an explicitly bound command during %s retirement after %s',
    async (retirement, tool) => {
      const { client, member, handle } = await connector();
      const claimedSource = await tag(handle, 'use a tool for this command');
      const untouchedSource = await tag(handle, 'unclaimed work');
      const [claimed] = await commandFor(member, claimedSource);
      const result = await client.callTool({
        name: tool,
        arguments:
          tool === 'search'
            ? { address: ROOM, scope: 'history', query: 'command', commandId: claimed!.id }
            : {
                to: { agent: AGENT, place: ROOM },
                text: 'working on the command',
                commandId: claimed!.id,
              },
      });
      expect(result.isError).not.toBe(true);
      expect((await commandFor(member, claimedSource))[0]?.state).toBe('pending');

      if (retirement === 'historical') {
        await scope.db.query(
          "UPDATE agent_commands SET created_at='2026-11-14T13:48:23Z' WHERE agent_id=$1",
          [member],
        );
        await retireStuckConnectorCommands(scope.db);
      } else {
        await offline(client);
        await online(client);
      }

      expect((await commandFor(member, claimedSource))[0]).toMatchObject({
        state: 'pending',
        cancellation_reason: null,
      });
      expect((await commandFor(member, untouchedSource))[0]).toMatchObject({
        state: 'cancelled',
        cancellation_reason: CONNECTOR_RECONNECT_RETIRED,
      });
    },
  );

  it('retires a tag at the exact microsecond cutoff and preserves work after it', async () => {
    const { client, member, handle } = await connector();
    const atCutoff = await tag(handle, 'queued at the disconnect');
    const afterCutoff = await tag(handle, 'queued after the disconnect');
    await offline(client);
    await scope.db.query(
      "UPDATE rooms_mcp_members SET disconnected_at='2026-11-20T20:10:00.123456Z' WHERE member_id=$1",
      [member],
    );
    await scope.db.query(
      "UPDATE agent_commands SET created_at='2026-11-20T20:10:00.123456Z' WHERE agent_id=$1 AND source_message_id=$2",
      [member, atCutoff],
    );
    await scope.db.query(
      "UPDATE agent_commands SET created_at='2026-11-20T20:10:00.123457Z' WHERE agent_id=$1 AND source_message_id=$2",
      [member, afterCutoff],
    );

    await online(client);

    expect((await commandFor(member, atCutoff))[0]).toMatchObject({
      state: 'cancelled',
      cancellation_reason: CONNECTOR_RECONNECT_RETIRED,
    });
    expect(await owed(member, atCutoff)).toBe(0);
    expect((await commandFor(member, afterCutoff))[0]?.state).toBe('pending');
    expect(await owed(member, afterCutoff)).toBe(1);
  });

  it.each([false, true])(
    'retires backlog on expired subscription renewal with delivery binding=%s',
    async (bound) => {
      const { client, member, token, params } = await scope.eventFixture();
      const handle = data(await client.callTool({ name: 'list_chats', arguments: {} })).you
        .handle as string;
      const subscribed = await scope.eventCall(token, 'events/subscribe', params);
      expect(subscribed.error).toBeUndefined();
      if (bound) {
        const setup = await client.callTool({
          name: 'setup_delivery',
          arguments: {
            mechanism: 'events',
            host: 'ChatGPT',
            surface: 'Work',
            conversation: 'reconnect-thread',
          },
        });
        expect(setup.isError).not.toBe(true);
      }
      const stale = await tag(handle, 'queued before subscription expired');
      expect((await commandFor(member, stale))[0]?.state).toBe('pending');
      expect(
        (
          await scope.db.query('SELECT disconnected_at FROM rooms_mcp_members WHERE member_id=$1', [
            member,
          ])
        ).rows[0]!.disconnected_at,
      ).toBeNull();
      await scope.db.query(
        "UPDATE rooms_mcp_event_subscriptions SET expires_at=now()-interval '1 second' WHERE id=$1",
        [subscribed.result.id],
      );

      const committed: Array<{ state: string; active: boolean }> = [];
      const transaction = scope.db.transaction.bind(scope.db);
      const observe = vi.spyOn(scope.db, 'transaction').mockImplementation(async (work) => {
        const result = await transaction(work);
        committed.push(
          ...(
            await scope.db.query<{ state: string; active: boolean }>(
              `SELECT command.state,(subscription.expires_at IS NULL OR subscription.expires_at>now()) active
         FROM agent_commands command CROSS JOIN rooms_mcp_event_subscriptions subscription
         WHERE command.agent_id=$1 AND command.source_message_id=$2 AND subscription.id=$3`,
              [member, stale, subscribed.result.id],
            )
          ).rows,
        );
        return result;
      });
      try {
        const renewed = await scope.eventCall(token, 'events/subscribe', params);
        expect(renewed.error).toBeUndefined();
      } finally {
        observe.mockRestore();
      }
      expect(committed.length).toBeGreaterThan(0);
      expect(committed.filter((row) => row.active && row.state === 'pending')).toEqual([]);
      expect((await commandFor(member, stale))[0]).toMatchObject({
        state: 'cancelled',
        cancellation_reason: CONNECTOR_RECONNECT_RETIRED,
      });
      expect(await owed(member, stale)).toBe(0);
      const caughtUp = data(await client.callTool({ name: 'list_mentions', arguments: {} }));
      expect(caughtUp.mentions).toEqual([]);
      expect(caughtUp.wakes).toEqual([]);
      const fresh = await tag(handle, 'queued after renewal');
      expect((await commandFor(member, fresh))[0]?.state).toBe('pending');
      expect(await owed(member, fresh)).toBe(1);
    },
  );

  it('retires the old stuck connector commands once, silently, and leaves other agents alone', async () => {
    const { member, handle } = await connector();
    const stale = await tag(handle, 'stuck since 14 Nov');
    const claimedSource = await tag(handle, 'stuck but claimed');
    const recent = await tag(handle, 'queued after the cutoff');
    const [claimed] = await commandFor(member, claimedSource);
    await answer(member, claimed!.turn_request_id);
    const helper = (await createAgentCommand(scope.db, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: null,
      reason: 'order',
      privatePayload: {
        kind: 'order',
        authorId: USER,
        fromRoomId: ROOM,
        text: 'non-connector work',
      },
    }))!;
    await scope.db.query(
      "UPDATE agent_commands SET created_at='2026-11-14T13:48:23Z' WHERE id=ANY($1::text[])",
      [
        [...(await commandFor(member, stale)), claimed!]
          .map((command) => command.id)
          .concat(helper.id),
      ],
    );
    await scope.db.query(
      "UPDATE rooms_mcp_mentions SET created_at='2026-11-14T13:48:23Z' WHERE member_id=$1 AND message_id=ANY($2::text[])",
      [member, [stale, claimedSource]],
    );
    const messages = await roomMessages(),
      commands = await commandCount();

    const first = await retireStuckConnectorCommands(scope.db);
    expect(first.commands).toBeGreaterThanOrEqual(1);
    expect(first.tags).toBeGreaterThanOrEqual(1);
    expect((await commandFor(member, stale))[0]).toMatchObject({
      state: 'cancelled',
      cancellation_reason: CONNECTOR_RECONNECT_RETIRED,
    });
    expect(await owed(member, stale)).toBe(0);
    expect((await commandFor(member, claimedSource))[0]?.state).toBe('pending');
    expect((await commandFor(member, recent))[0]?.state).toBe('pending');
    expect(await owed(member, recent)).toBe(1);
    expect(
      (await scope.db.query('SELECT state FROM agent_commands WHERE id=$1', [helper.id])).rows[0]!
        .state,
    ).toBe('pending');
    expect(await roomMessages()).toBe(messages);
    expect(await commandCount()).toBe(commands);

    // Safe to run twice: the fixed cutoff finds nothing new.
    expect(await retireStuckConnectorCommands(scope.db)).toEqual({ commands: 0, tags: 0 });
  });
});

import { LOCAL_RECEIVER_RECOVERY } from '@beeline/api-contract/phone';
import {
  describe,
  expect,
  it,
  fixtureScope1,
  deliverMcpMemberWebhooks,
  ROOM,
  USER,
  WORKSPACE,
  createAgentCommand,
  randomBytes,
  pendingMcpWakes,
} from './test-support-rooms-mcp.test-support.js';

describe('JOIN-DELIVERY: OAuth is membership, host receipts prove delivery', () => {
  const scope = fixtureScope1();
  const value = (result: any) => JSON.parse(result.content[0].text).data;
  it('muse-wake-1: tags and DMs post only the allowed offline notice for a member with no inbound route', async () => {
    for (const host of ['Codex', 'Antigravity', 'Unattached local', 'Failed local']) {
      const { client, member } = await scope.connected();
      await scope.db.query('UPDATE rooms_mcp_members SET model_label=$2 WHERE member_id=$1', [
        member,
        host,
      ]);
      await client.callTool({ name: 'set_profile', arguments: { name: host } });
      const rooms = value(await client.callTool({ name: 'list_chats', arguments: {} }));
      expect(rooms.you.id).toBe(member);
      expect(rooms.delivery.state).toBe('setup_unfinished');
      expect(rooms.setup).toContain('setup_delivery');
      if (host.endsWith('local')) {
        await client.callTool({ name: 'setup_delivery', arguments: {
          mechanism: 'local', host, surface: 'CLI', conversation: 'unattached-thread', installed: true,
        } });
      }
      if (host === 'Failed local') {
        const binding = value(await client.callTool({ name: 'list_chats', arguments: {} }));
        const failed = value(await client.callTool({ name: 'delivery_failed', arguments: {
          generation: binding.delivery.generation, reason: 'local_receiver_setup_failed',
        } }));
        expect(failed.next).toBe('The local Beeline receiver failed to start. Run npx -y usebeeline@latest join again in the same coding session. If it still fails, check that this computer can create and run its local receiver. Opening the join website cannot repair a local receiver failure.');
        expect(value(await client.callTool({ name: 'list_chats', arguments: {} })).setup).toContain(LOCAL_RECEIVER_RECOVERY);
      }
      const tagged = await scope.phone.execute(
        'sendRoomMessage',
        { roomId: ROOM, text: `@${rooms.you.handle} are you there?` },
        USER,
      );
      await scope.db.backgroundWork.drain();
      expect(JSON.stringify(await scope.phone.readRoom(ROOM, USER))).toContain(
        'is offline · connect again',
      );
      expect((await scope.db.query("SELECT text FROM messages WHERE room_id=$1 AND presentation='system' AND author_id=$2", [ROOM, member])).rows)
        .toEqual([{ text: `@${rooms.you.handle} is offline · connect again` }]);
      expect((await scope.db.query('SELECT machine_id FROM agents WHERE agent_id=$1', [member])).rows[0]!.machine_id).toBeNull();
      expect((await scope.db.query('SELECT 1 FROM rooms_mcp_mentions WHERE member_id=$1 AND message_id=$2', [member, tagged.messageId])).rowCount).toBe(1);
      const dm = await scope.phone.execute(
        'resolveDirectMessage',
        { workspaceId: WORKSPACE, participantId: member },
        USER,
      );
      const sent = await scope.phone.execute(
        'sendRoomMessage',
        { roomId: dm.id, text: '你在嘛' },
        USER,
      );
      await scope.db.backgroundWork.drain();
      expect(sent.externalAgentDelivery).toEqual([
        expect.objectContaining({ memberId: member, state: host === 'Failed local' ? 'failed' : 'setup_unfinished' }),
      ]);
      expect(JSON.stringify(await scope.phone.readRoom(dm.id, USER))).toContain(
        'is offline · connect again',
      );
      expect(
        (
          await scope.db.query(
            'SELECT 1 FROM rooms_mcp_mentions WHERE member_id=$1 AND message_id=$2 AND cleared_at IS NULL',
            [member, sent.messageId],
          )
        ).rowCount,
      ).toBe(1);
    }
  });
});

describe('JOIN-DELIVERY transport and credential proofs', () => {
  const scope = fixtureScope1();
  const data = (result: any) => JSON.parse(result.content[0].text).data;
  const setup = (client: any, mechanism: string, conversation = 'thread-one') =>
    client.callTool({
      name: 'setup_delivery',
      arguments: {
        mechanism,
        host: 'actual host',
        surface: 'test host',
        conversation,
        installed: true,
      },
    });
  const state = async (client: any) =>
    data(await client.callTool({ name: 'list_chats', arguments: {} })).delivery;

  it('1: the local continuation redeems once and preserves the OAuth member, owner and access', async () => {
    const { client, member, token, grant } = await scope.connected();
    const count = (
      await scope.db.query('SELECT member_id FROM rooms_mcp_members WHERE client_id=$1', [
        grant.clientId,
      ])
    ).rowCount;
    const continuation = data(
      await client.callTool({
        name: 'setup_delivery',
        arguments: {
          mechanism: 'local',
          host: 'Codex',
          surface: 'CLI',
          conversation: 'codex-thread',
        },
      }),
    );
    expect(continuation.command).toContain('join --attach ');
    const secret = continuation.command.match(/--attach ([A-Za-z0-9_-]+)/)[1];
    const attached = await scope.post('/mcp/oauth/delivery-attach', { secret });
    expect(attached.status).toBe(200);
    const tokens = (await attached.json()) as { access_token: string; clientId: string };
    expect(tokens.clientId).toBe(grant.clientId);
    expect((await scope.post('/mcp/oauth/delivery-attach', { secret })).status).toBe(400);
    const rooms = await scope.eventCall(tokens.access_token, 'tools/call', {
      name: 'list_chats',
      arguments: {},
    });
    expect(JSON.parse(rooms.result.content[0].text).data.you.id).toBe(member);
    expect(
      (
        await scope.db.query('SELECT member_id FROM rooms_mcp_members WHERE client_id=$1', [
          grant.clientId,
        ])
      ).rowCount,
    ).toBe(count);
    expect(await state(client)).toMatchObject({ state: 'setup_unfinished' });
    // The original host's connection remains usable; attach is not another membership or consent.
    expect(
      (await scope.eventCall(token, 'tools/call', { name: 'list_chats', arguments: {} })).result
        .isError,
    ).not.toBe(true);
  });

  it('4: a callback HTTP success is not a host receipt; mention, DM and private order use one path', async () => {
    const fixture = await scope.eventFixture();
    const { client, member, token, params } = fixture;
    await scope.eventCall(token, 'events/subscribe', params);
    await client.callTool({
      name: 'set_webhook',
      arguments: { url: 'https://hooks.example/legacy-grok', secret: 'Bearer grok-existing-token' },
    });
    const binding = data(await setup(client, 'webhook')).delivery;
    expect(binding.state).toBe('setup_unfinished');
    const posts: any[] = [];
    const transport = async (
      _url: string,
      init: { body: string; headers: Record<string, string> },
    ) => {
      posts.push(JSON.parse(init.body));
      expect(init.headers.authorization).toBe('Bearer grok-existing-token');
      return new Response(null, { status: 204 });
    };
    expect(await deliverMcpMemberWebhooks(scope.db, transport)).toBe(1);
    expect(await state(client)).toMatchObject({ state: 'setup_unfinished' });
    const receipt = posts[0].receipt;
    expect(receipt).toMatchObject({ generation: binding.generation, conversation: 'thread-one' });
    expect(
      JSON.stringify(data(await client.callTool({ name: 'list_mentions', arguments: {} }))),
    ).not.toContain(receipt.nonce);
    expect(
      JSON.stringify(data(await client.callTool({ name: 'list_chats', arguments: {} }))),
    ).not.toContain(receipt.nonce);
    const other = await scope.connected();
    expect(
      (await other.client.callTool({ name: 'confirm_delivery', arguments: receipt })).isError,
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: 'confirm_delivery',
          arguments: { ...receipt, conversation: 'wrong-thread' },
        })
      ).isError,
    ).toBe(true);
    expect(
      data(await client.callTool({ name: 'confirm_delivery', arguments: receipt })).delivery.state,
    ).toBe('proved_ready');
    expect(
      data(await client.callTool({ name: 'confirm_delivery', arguments: receipt })).delivery.state,
    ).toBe('proved_ready');
    expect(await deliverMcpMemberWebhooks(scope.db, transport)).toBe(0);
    const handle = (
      await scope.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [
        member,
      ])
    ).rows[0]!.handle;
    const mention = await scope.phone.execute(
      'sendRoomMessage',
      { roomId: ROOM, text: `@${handle} answer the chat` },
      USER,
    );
    const dm = (await scope.phone.execute(
      'resolveDirectMessage',
      { workspaceId: WORKSPACE, participantId: member },
      USER,
    )) as { id: string };
    const direct = await scope.phone.execute(
      'sendRoomMessage',
      { roomId: dm.id, text: 'Jane-shaped untagged DM' },
      USER,
    );
    const order = await createAgentCommand(scope.db, {
      roomId: ROOM,
      agentId: member,
      sourceMessageId: mention.messageId,
      reason: 'order',
      privatePayload: { kind: 'order', authorId: USER, fromRoomId: ROOM, text: 'private assignment' },
    });
    expect(order).toBeDefined();
    expect(await deliverMcpMemberWebhooks(scope.db, transport)).toBe(3);
    expect(
      posts
        .slice(1)
        .map((p) => p.messageId ?? p.commandId)
        .sort(),
    ).toEqual([mention.messageId, direct.messageId, order!.id].sort());
    expect(
      (
        await scope.db.query(
          'SELECT 1 FROM rooms_mcp_event_deliveries e JOIN rooms_mcp_event_subscriptions s ON s.id=e.subscription_id WHERE s.member_id=$1',
          [member],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (await scope.db.query("SELECT 1 WHERE beeline_mcp_delivery_owner($1,'local')", [member]))
        .rowCount,
    ).toBe(0);
    expect((direct as any).externalAgentDelivery).toEqual([
      expect.objectContaining({ memberId: member, state: 'proved_ready', mechanism: 'webhook' }),
    ]);
  });

  it('6: credential rotation, expiry, revocation and actual replacement failure never inherit readiness', async () => {
    const { client, member, token, params } = await scope.eventFixture();
    await scope.eventCall(token, 'events/subscribe', params);
    const first = data(await setup(client, 'events')).delivery;
    let probe: any;
    await deliverMcpMemberWebhooks(scope.db, async (_url, init) => {
      probe = JSON.parse(init.body);
      return new Response(null, { status: 204 });
    });
    const receipt = JSON.parse(probe.data.text.match(/with (\{.*\})\./)[1]);
    expect(
      data(await client.callTool({ name: 'confirm_delivery', arguments: receipt })).delivery.state,
    ).toBe('proved_ready');
    const changed = {
      ...params,
      delivery: { ...params.delivery, secret: 'whsec_' + randomBytes(32).toString('base64') },
    };
    scope.eventTransport = async (_url, init) =>
      Response.json({ challenge: JSON.parse(init.body).challenge });
    await scope.eventCall(token, 'events/subscribe', changed);
    expect(await state(client)).toMatchObject({ state: 'setup_unfinished', offline: false });
    const second = data(await setup(client, 'events')).delivery;
    expect(second.generation).not.toBe(first.generation);
    expect((await client.callTool({ name: 'confirm_delivery', arguments: receipt })).isError).toBe(
      true,
    );
    await deliverMcpMemberWebhooks(scope.db, async () => new Response(null, { status: 503 }));
    expect(await state(client)).toMatchObject({
      state: 'failed',
      failure: 'event_delivery_failed',
    });
    await setup(client, 'events');
    await scope.db.query(
      "UPDATE rooms_mcp_event_subscriptions SET expires_at=now()-interval '1 second' WHERE member_id=$1",
      [member],
    );
    expect(await state(client)).toMatchObject({ state: 'setup_unfinished' });
    await scope.db.query(
      'UPDATE rooms_mcp_connections SET revoked_at=now() WHERE client_id=(SELECT client_id FROM rooms_mcp_members WHERE member_id=$1)',
      [member],
    );
    expect(
      (
        await scope.post(
          '/mcp',
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'list_chats', arguments: {} },
          },
          { authorization: 'Bearer ' + token },
        )
      ).status,
    ).toBe(401);
  });
});

// Local probes use the same durable member stream, never the generic list_mentions read.
import { localDeliveryProbe } from './rooms-mcp-delivery.js';
import { serveMcpMemberStream } from './rooms-mcp-stream.js';
import { tokenHash } from './auth.js';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';

describe('JOIN-DELIVERY local selected-path proof', () => {
  const scope = fixtureScope1();
  it.each(['before', 'after'])('legacy-offline: setup %s stream open proves delivery without reconnecting', async (setupOrder) => {
    const { client, token, member, grant } = await scope.connected();
    const data = (result: any) => JSON.parse(result.content[0].text).data;
    const principal = {
      hash: tokenHash(token),
      client_id: grant.clientId,
      identity_id: USER,
      member_id: member,
      scope: 'rooms:read rooms:write',
    };
    const args = {
      mechanism: 'local',
      host: 'Codex',
      surface: 'CLI',
      conversation: 'exact-host-thread',
      installed: true,
    };
    let binding = setupOrder === 'before' ? data(
      await client.callTool({ name: 'setup_delivery', arguments: args }),
    ).delivery : undefined;
    expect(data(await client.callTool({ name: 'list_mentions', arguments: {} })).wakes).toEqual([]);
    class Reply extends EventEmitter {
      destroyed = false;
      writableEnded = false;
      writableLength = 0;
      frames: any[] = [];
      writeHead() {}
      flushHeaders() {}
      write(raw: string) {
        this.frames.push(JSON.parse(raw));
        this.emit('frame');
        return true;
      }
      end() {
        this.writableEnded = true;
        this.emit('close');
      }
    }
    const reply = new Reply();
    try {
      await serveMcpMemberStream(
        scope.db,
        principal,
        reply as unknown as ServerResponse,
        { mentionCursor: '0' },
        async (db, after) => {
          const mentions = (
            await db.query<{ id: string; room_id: string; text: string; deliveryCursor: string }>(
              `SELECT m.id,m.room_id,m.text,n.seq::text "deliveryCursor"
            FROM rooms_mcp_mentions n JOIN messages m ON m.id=n.message_id
            WHERE n.member_id=$1 AND n.seq>$2::bigint AND n.cleared_at IS NULL ORDER BY n.seq`,
              [member, after],
            )
          ).rows;
          return {
            mentions,
            wakes: [
              ...(await pendingMcpWakes(db, member)),
              ...(await localDeliveryProbe(db, member)),
            ],
            nextCursor: mentions.at(-1)?.deliveryCursor ?? after,
            more: false,
          };
        },
      );
      const waitFor = (id: string) =>
        new Promise<void>((resolve) => {
          const inspect = () => {
            if (reply.frames.some((frame) => frame.deliveryId === id)) {
              reply.off('frame', inspect);
              resolve();
            }
          };
          reply.on('frame', inspect);
          inspect();
        });
      if (setupOrder === 'after') {
        expect(reply.frames.some(frame => frame.wakes?.length)).toBe(false);
        binding = data(await client.callTool({ name: 'setup_delivery', arguments: args })).delivery;
        await waitFor(`wake:${binding.generation}`);
      }
      expect(binding.state).toBe('setup_unfinished');
      const probeFrame = reply.frames.find(frame => frame.wakes?.[0]?.kind === 'join_probe');
      expect(probeFrame).toBeDefined();
      expect(
        data(await client.callTool({ name: 'list_chats', arguments: {} })).delivery.state,
      ).toBe('setup_unfinished');
      // Legacy timestamps must no longer expire authentication or delivery proof.
      await scope.db.query("UPDATE rooms_mcp_tokens SET expires_at=now()-interval '2 hours',window_at=now()-interval '3 hours' WHERE hash=$1", [principal.hash]);
      const receipt = probeFrame.wakes[0].receipt;
      expect(receipt).toMatchObject({
        generation: binding.generation,
        conversation: 'exact-host-thread',
      });
      expect(
        data(await client.callTool({ name: 'confirm_delivery', arguments: receipt })).delivery
          .state,
      ).toBe('proved_ready');
      const view = await scope.phone.readRoom(ROOM, USER);
      expect(view?.members.find((m) => m.identity.pubkey === member)?.delivery?.state).toBe(
        'proved_ready',
      );

      const handle = data(await client.callTool({ name: 'list_chats', arguments: {} })).you.handle;
      const tagged = await scope.phone.execute(
        'sendRoomMessage',
        { roomId: ROOM, text: `@${handle} local mention` },
        USER,
      );
      await waitFor(`mention:${tagged.messageId}:0`);
      await scope.db.backgroundWork.drain();
  expect((await scope.phone.readRoom(ROOM, USER))?.messages.filter(m => m.author.pubkey === member && m.presentation === 'system')).toEqual([]);
      // A replacement conversation on the same live stream must also be confirmable.
      const replacement = data(await client.callTool({ name: 'setup_delivery', arguments: { ...args, conversation: 'next-host-thread' } })).delivery;
      await waitFor(`wake:${replacement.generation}`);
      const nextReceipt = reply.frames.find(frame => frame.deliveryId === `wake:${replacement.generation}`).wakes[0].receipt;
      expect(data(await client.callTool({ name: 'confirm_delivery', arguments: nextReceipt })).delivery.state).toBe('proved_ready');

      const dm = await scope.phone.execute(
        'resolveDirectMessage',
        { workspaceId: WORKSPACE, participantId: member },
        USER,
      );
      const direct = await scope.phone.execute(
        'sendRoomMessage',
        { roomId: dm.id, text: 'local untagged DM' },
        USER,
      );
      await waitFor(`mention:${direct.messageId}:0`);
      const order = await createAgentCommand(scope.db, {
        roomId: ROOM,
        agentId: member,
        sourceMessageId: tagged.messageId,
        reason: 'order',
        privatePayload: { kind: 'order', authorId: USER, fromRoomId: ROOM, text: 'local private assignment' },
      });
      await waitFor(`wake:${order!.id}`);
      expect(
        await deliverMcpMemberWebhooks(scope.db, async () => {
          throw new Error('parallel transport must stay quiet');
        }),
      ).toBe(0);
    } finally {
      reply.end();
    }
    // Closing the actual stream retains the ordinary offline notice.
    const handle = (await scope.db.query<{handle:string}>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    await scope.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} genuinely offline` }, USER);
    expect((await scope.phone.readRoom(ROOM, USER))?.messages.filter(m => m.author.pubkey === member && m.presentation === 'system').map(m => m.text)).toEqual([`@${handle} is offline · connect again`]);
  });
});

// Connection lifetime is distinct from access-token expiry and from HTTP acceptance.
describe('JOIN-DELIVERY persistent Events lifecycle', () => {
  const scope = fixtureScope1();
  const data = (result: any) => JSON.parse(result.content[0].text).data;
  it('honors null and long TTLs, ends a gone route once, and proves its authenticated reconnection automatically', async () => {
    const { client, token, member, params } = await scope.eventFixture();
    const subscribed = await scope.eventCall(token, 'events/subscribe', { ...params, ttlMs: null });
    expect(subscribed.result.refreshBefore).toBeNull();
    const saved = (
      await scope.db.query<{ expires_at: Date | null }>(
        'SELECT expires_at FROM rooms_mcp_event_subscriptions WHERE id=$1',
        [subscribed.result.id],
      )
    ).rows[0]!;
    expect(saved.expires_at).toBeNull();
    const longer = await scope.eventCall(token, 'events/subscribe', {
      ...params,
      ttlMs: 7 * 24 * 60 * 60 * 1000,
    });
    expect(Date.parse(longer.result.refreshBefore) - Date.now()).toBeGreaterThan(
      6 * 24 * 60 * 60 * 1000,
    );
    await scope.eventCall(token, 'events/subscribe', { ...params, ttlMs: null });
    const first = data(
      await client.callTool({
        name: 'setup_delivery',
        arguments: {
          mechanism: 'events',
          host: 'ChatGPT',
          surface: 'Work',
          conversation: 'work-thread',
        },
      }),
    ).delivery;
    let firstReceipt: any;
    await deliverMcpMemberWebhooks(scope.db, async (_url, init) => {
      firstReceipt = JSON.parse(JSON.parse(init.body).data.text.match(/with (\{.*\})\./)[1]);
      return new Response(null, { status: 204 });
    });
    expect(
      data(await client.callTool({ name: 'confirm_delivery', arguments: firstReceipt })).delivery,
    ).toMatchObject({ state: 'proved_ready', offline: false });
    const handle = (await scope.db.query<{handle:string}>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    await scope.phone.execute(
      'sendRoomMessage',
      { roomId: ROOM, text: `@${handle} host has gone` },
      USER,
    );
    let attempts = 0;
    await deliverMcpMemberWebhooks(scope.db, async () => {
      attempts++;
      return new Response(null, { status: 410 });
    });
    expect(attempts).toBe(1);
    expect(
      data(await client.callTool({ name: 'list_chats', arguments: {} })).delivery,
    ).toMatchObject({ state: 'failed', offline: true, failure: 'event_subscription_gone' });
    await scope.phone.execute(
      'sendRoomMessage',
      { roomId: ROOM, text: `@${handle} keep this owed` },
      USER,
    );
    expect(
      await deliverMcpMemberWebhooks(scope.db, async () => {
        attempts++;
        return new Response(null, { status: 204 });
      }),
    ).toBe(0);
    expect(attempts).toBe(1);
    // Real host resubscription is the recovery event; there is no renewal clock or replay of either message.
    await scope.eventCall(token, 'events/subscribe', { ...params, ttlMs: null });
    const recovered = data(await client.callTool({ name: 'list_chats', arguments: {} })).delivery;
    expect(recovered).toMatchObject({ state: 'setup_unfinished', offline: false });
    expect(recovered.generation).not.toBe(first.generation);
    expect(
      (await client.callTool({ name: 'confirm_delivery', arguments: firstReceipt })).isError,
    ).toBe(true);
    let receipt: any;
    expect(
      await deliverMcpMemberWebhooks(scope.db, async (_url, init) => {
        receipt = JSON.parse(JSON.parse(init.body).data.text.match(/with (\{.*\})\./)[1]);
        return new Response(null, { status: 204 });
      }),
    ).toBe(1);
    expect(
      data(await client.callTool({ name: 'confirm_delivery', arguments: receipt })).delivery,
    ).toMatchObject({ state: 'proved_ready', offline: false });
    expect(
      (
        await scope.db.query(
          'SELECT 1 FROM rooms_mcp_mentions WHERE member_id=$1 AND cleared_at IS NULL',
          [member],
        )
      ).rowCount,
    ).toBe(2);
  });
});

describe('JOIN-DELIVERY on-demand hosts are not reported offline', () => {
  const scope = fixtureScope1();
  it('a member that declared on-demand delivery gets no offline notice when a person tags it', async () => {
    const { client, member } = await scope.connected();
    await client.callTool({ name: 'setup_delivery', arguments: { mechanism: 'on_demand', host: 'Meta Muse', surface: 'Muse app', conversation: 'routine', installed: true } });
    const handle = (await scope.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    await scope.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} are you there?` }, USER);
    await scope.db.backgroundWork.drain();
    expect((await scope.db.query("SELECT text FROM messages WHERE room_id=$1 AND presentation='system' AND author_id=$2", [ROOM, member])).rows).toEqual([]);
    expect((await scope.db.query('SELECT 1 FROM rooms_mcp_mentions WHERE member_id=$1 AND cleared_at IS NULL', [member])).rowCount).toBe(1);
  });
});

import { startQueuedTurn } from '../test-fixtures/queued-turn.test-support.js';

import { describe, expect, it, vi } from 'vitest';
import { PostgresLiveListener } from '../postgres-live.js';
import { PgliteListenClient } from '../test-support-postgres-live.test-support.js';
import { claimAgentConnection } from '../connection-presence.js';
import WebSocket from 'ws';
import { PhoneService } from '.././phone-service.js';
import { type RoomView } from '@beeline/api-contract/phone';
import { monolithFixture, HUMAN, AGENT, WORKSPACE, ROOM, next } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: messages-live', () => {
const fixture = monolithFixture();

async function onlineHelper() {
  await fixture.database.query(`INSERT INTO live_server_instances(instance_id) VALUES('live-integration')`);
  await claimAgentConnection(fixture.database, fixture.live, AGENT, {}, {
    connectionId: 'live-integration', instanceId: 'live-integration',
  });
}


  it('toggles a fixed reaction and projects its identity roster for the viewer', async () => {
    await onlineHelper();
    const messageId = '9'.repeat(64);
    expect(
      (await fixture.operation('sendRoomMessage', { roomId: ROOM, messageId, text: 'React here' })).status,
    ).toBe(200);
    const reactionReceipt = await fixture.operation('reactToMessage', { roomId: ROOM, messageId, emoji: '👍' });
    expect(reactionReceipt.status).toBe(200);
    expect((await reactionReceipt.json()).reactions).toEqual([
      expect.objectContaining({ emoji: '👍', count: 1, reacted: true }),
    ]);

    const reacted = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`, 'GET')).json()) as RoomView;
    expect(reacted.messages.find((message) => message.id === messageId)?.reactions).toEqual([
      {
        emoji: '👍',
        count: 1,
        reacted: true,
        members: [{ pubkey: HUMAN, kind: 'human', name: 'Owner', handle: 'owner' }],
      },
    ]);

    await fixture.database.query(`UPDATE messages SET reactions=$2::jsonb WHERE id=$1`, [
      messageId,
      JSON.stringify({ '👍': [HUMAN, AGENT] }),
    ]);
    const multiple = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`, 'GET')).json()) as RoomView;
    expect(multiple.messages.find((message) => message.id === messageId)?.reactions).toEqual([
      {
        emoji: '👍',
        count: 2,
        reacted: true,
        members: [
          { pubkey: HUMAN, kind: 'human', name: 'Owner', handle: 'owner' },
          { pubkey: AGENT, kind: 'agent', name: 'Bee', handle: 'bee' },
        ],
      },
    ]);
    expect((await fixture.phone.readHistory(ROOM, HUMAN))?.messages.at(-1)?.reactions).toEqual(
      multiple.messages.find((message) => message.id === messageId)?.reactions,
    );
    await fixture.database.query(`UPDATE messages SET reactions=$2::jsonb WHERE id=$1`, [
      messageId,
      JSON.stringify({ '👍': [HUMAN] }),
    ]);

    expect(
      (await fixture.operation('reactToMessage', { roomId: ROOM, messageId, emoji: '👍' })).status,
    ).toBe(200);
    const cleared = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`, 'GET')).json()) as RoomView;
    expect(cleared.messages.find((message) => message.id === messageId)?.reactions).toBeUndefined();
  });


  it('proves queued intake, reply publication and committed phone deltas', async () => {
    await onlineHelper();
    const listener = new PostgresLiveListener(fixture.database, fixture.live,
      () => new PgliteListenClient(fixture.database));
    void listener.run();
    await vi.waitFor(() => expect(listener.projectionHealth().connected).toBe(true));
    const socket = new WebSocket(`${fixture.origin.replace('http', 'ws')}/v1/phone/live`, [`bearer.${fixture.accessToken}`]);
    try {
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      const subscribed = next(socket, 'subscribed');
      socket.send(JSON.stringify({ type: 'subscribe', roomId: ROOM }));
      await subscribed;
      const sent = await fixture.operation('sendRoomMessage', {
        roomId: ROOM, messageId: 'c'.repeat(64), text: '@bee What is your soul?',
      });
      expect(sent.status).toBe(200);
      const { messageId } = await sent.json() as { messageId: string };
      const room = await fixture.phone.readRoom(ROOM, HUMAN);
      expect(room?.messages).toContainEqual(expect.objectContaining({ id: messageId, text: '@bee What is your soul?' }));
      const queued = await fixture.daemonOperation('getAgentCommands', { roomId: ROOM });
      const item = (await queued.json()).commands.find((command: {sourceMessageId: string}) => command.sourceMessageId === messageId);
      expect(item).toBeDefined();
      expect((await fixture.daemonOperation('startAgentTurn', { roomId: ROOM, requestId: item.id })).status).toBe(200);
      const delivered = next(socket, 'message-delta');
      const steps = [{ kind: 'tool', title: 'Bash', operation: 'execute', status: 'exit 0' }];
      const reply = await fixture.daemonOperation('postRoomMessage', {
        roomId: ROOM, requestId: item.id, text: 'I am Terra.', steps,
      });
      expect(reply.status).toBe(200);
      expect(await delivered).toMatchObject({ type: 'message-delta', roomId: ROOM,
        message: { requestId: item.id, text: 'I am Terra.' } });
      await fixture.database.backgroundWork.drain();
      const answered = await fixture.phone.readRoom(ROOM, HUMAN);
      expect(answered?.messages).toContainEqual(expect.objectContaining({ requestId: item.id, text: 'I am Terra.', activity: steps }));
      expect((await fixture.database.query('SELECT state FROM agent_commands WHERE id=$1', [item.id])).rows).toEqual([{ state: 'complete' }]);
    } finally {
      socket.close();
      await listener.stop();
    }
  });


  it('never reports unread for the viewer’s own latest message', async () => {
    await onlineHelper();
    const sent = await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: 'c'.repeat(64),
      text: 'My own note',
    });
    expect(sent.status).toBe(200);
    const readChats = async () =>
      (
        (await (await fixture.request(`/v1/phone/workspaces/${WORKSPACE}/chats`)).json()) as {
          chats: Array<{ room: { id: string }; unread: boolean }>;
        }
      ).chats.find((chat) => chat.room.id === ROOM)!;
    expect((await readChats()).unread).toBe(false);

    await fixture.daemonOperation('postRoomMessage', {
      roomId: ROOM,
      requestId: 'd'.repeat(64),
      text: 'Agent reply',
    });
    expect((await readChats()).unread).toBe(true);

    const agentMessage = (
      (await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json()) as {
        messages: Array<{ id: string; text: string }>;
      }
    ).messages.find((message) => message.text === 'Agent reply');
    expect(
      (await fixture.request(`/v1/phone/rooms/${ROOM}/read`, 'POST', { messageId: agentMessage!.id }))
        .status,
    ).toBe(204);
    expect((await readChats()).unread).toBe(false);
  });


  it('treats concurrent retries of the same message write as one successful send', async () => {
    const payload = {
      roomId: ROOM,
      messageId: 'd'.repeat(64),
      text: '@bee Send this once',
      mentions: [AGENT],
    };

    const [foreground, outbox] = await Promise.all([
      fixture.request('/v1/phone/operations/sendRoomMessage', 'POST', payload),
      fixture.request('/v1/phone/operations/sendRoomMessage', 'POST', payload),
    ]);

    expect([foreground.status, outbox.status]).toEqual([200, 200]);
    expect(await foreground.json()).toMatchObject({
      messageId: payload.messageId,
      activeSteerAgentIds: [],
      message: { id: payload.messageId, text: payload.text },
    });
    expect(await outbox.json()).toMatchObject({ messageId: payload.messageId, activeSteerAgentIds: [],
      message: { id: payload.messageId, text: payload.text } });
    const stored = await fixture.database.query<{ count: string }>(
      `SELECT count(*)::text FROM messages WHERE id=$1`,
      [payload.messageId],
    );
    expect(stored.rows[0]?.count).toBe('1');

    const conflicting = await fixture.request('/v1/phone/operations/sendRoomMessage', 'POST', {
      ...payload,
      text: 'Different payload',
    });
    expect(conflicting.status).toBe(200);
    expect((await conflicting.json()).messageId).not.toBe(payload.messageId);
  });
});

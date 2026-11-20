import { describe, expect, it } from 'vitest';
import { readRoomView } from '@beeline/api-contract/phone';
import { sendMessage } from './agent-messaging.js';
import { PhoneService } from './phone-service.js';
import { A, B, C, H, CHAT, THREAD, OTHER, db, daemon, queued } from './messaging.test-support.js';

describe('addressed agent message transcript pills', () => {
  it.each([CHAT, THREAD])('publishes the existing pill in destination %s without another wake', async place => {
    const sent = await daemon.execute('message', {
      roomId: OTHER, to: { agent: B, place }, text: 'Please review the phone layout',
      ask: { question: 'Ready?', options: ['Yes', 'No'] },
    }, A);
    expect(await queued()).toEqual([[B, place]]);
    const phone = new PhoneService(db, 'http://local.test');
    const view = readRoomView(await phone.readRoom(place, H));
    const message = view!.messages.find(row => row.id === sent.id)!;
    expect(message).toMatchObject({ author: { pubkey: A }, agentCommand: {
      kind: 'message', recipient: { id: B, name: 'Jellybean', handle: 'jellybean', kind: 'agent' },
      text: 'Please review the phone layout',
    } });
    expect((await phone.readRoom(OTHER, H))!.messages.some(row => row.id === sent.id)).toBe(false);
    const item = (await db.query<{ source_message_id: null; private_payload: unknown }>(
      'SELECT source_message_id,private_payload FROM agent_commands WHERE id=$1', [sent.id])).rows[0]!;
    expect(item.source_message_id).toBeNull();
    expect(item.private_payload).toMatchObject({ messageAsk: { question: 'Ready?' }, route: {
      from: { agent: A, place: OTHER }, to: { agent: B, place },
    } });
    // The same parent-Room authority covers threads and top-level chat reads.
    await db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [CHAT, H]);
    expect(await phone.readRoom(place, H)).toBeNull();
    expect(await phone.readRoom(place, 'f'.repeat(64))).toBeNull();
  });

  it('records replies at their frozen destination and does not wake observers', async () => {
    const sent = await daemon.execute('message', { roomId: OTHER, to: { agent: B, place: THREAD }, text: 'Review this' }, A);
    await daemon.execute('reply', { id: sent.id, roomId: THREAD, text: 'The layout is ready' }, B);
    expect(await queued()).toEqual([[A, OTHER]]);
    const phone = new PhoneService(db, 'http://local.test');
    const reply = (await phone.readRoom(OTHER, H))!.messages.find(row => row.agentCommand?.kind === 'reply')!;
    expect(reply).toMatchObject({ author: { pubkey: B }, agentCommand: {
      kind: 'reply', text: 'The layout is ready', recipient: { id: A, kind: 'agent' },
    } });
    expect((await phone.readRoom(CHAT, H))!.messages.some(row => row.id === sent.id || row.id === reply.id)).toBe(false);
    expect((await db.query('SELECT 1 FROM agent_commands WHERE agent_id=$1', [C])).rowCount).toBe(0);
  });

  it('replayed sends retain one command and one pill; refused sends leave neither', async () => {
    const input = { id: 'e'.repeat(64), route: { from: { agent: A, place: OTHER }, to: { agent: B, place: THREAD } }, text: 'Review this' };
    await sendMessage(db, input);
    await sendMessage(db, input);
    expect(await queued()).toEqual([[B, THREAD]]);
    expect((await db.query('SELECT id FROM messages WHERE id=$1', [input.id])).rows).toEqual([{ id: input.id }]);
    await expect(sendMessage(db, { ...input, id: 'f'.repeat(64), route: { ...input.route, to: { agent: 'missing', place: THREAD } } })).rejects.toThrow();
    expect((await db.query('SELECT 1 FROM messages WHERE id=$1', ['f'.repeat(64)])).rowCount).toBe(0);
  });
});

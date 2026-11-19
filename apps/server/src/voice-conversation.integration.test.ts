import { startQueuedCommand } from './test-fixtures/queued-turn.test-support.js';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { phoneFetch } from '../../../packages/test-helpers/helpers/phone-operation.js';
import { TokenAuth } from './auth.js';
import { migrate } from './database.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
import type { DaemonApiClient } from '../../body/src/daemon-api-client.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import { HelperDaemonService } from './test-fixtures/helper-daemon.js';
import { readAgentCommands } from './agent-command.js';
import { VoiceService } from './voice-service.js';
import type { VoiceRoomRuntime } from './voice-room-runtime.js';

// Only the external RTC/provider boundaries are stand-ins. Membership, phone
// socket dispatch, runtime startup, command ownership and reply writes are real.
const rtc = vi.hoisted(() => ({ room: undefined as any, audio: undefined as any }));
vi.mock('@livekit/rtc-node', () => ({
  Room: class extends EventEmitter {
    remoteParticipants = new Map();
    localParticipant = { publishTrack: vi.fn(), publishData: vi.fn() };
    constructor() { super(); rtc.room = this; }
    async connect() {} async disconnect() {}
  },
  RoomEvent: { TrackSubscribed: 'track', TrackUnsubscribed: 'untrack', ParticipantConnected: 'joined',
    ParticipantDisconnected: 'left', DataReceived: 'data', Disconnected: 'closed' },
  AudioStream: class {},
  AudioSource: class {
    clearQueue = vi.fn(); captureFrame = vi.fn(async () => {}); waitForPlayout = vi.fn(async () => {});
    constructor() { rtc.audio = this; } async close() {}
  },
  LocalAudioTrack: { createAudioTrack: vi.fn() }, TrackPublishOptions: class {},
  TrackSource: { SOURCE_MICROPHONE: 1 }, TrackKind: { KIND_AUDIO: 1 },
  AudioFrame: class { constructor(readonly data: Int16Array) {} },
}));
vi.mock('livekit-server-sdk', async original => ({
  ...await original<typeof import('livekit-server-sdk')>(),
  RoomServiceClient: class { async removeParticipant() {} async deleteRoom() {} },
}));

it('starts an agent DM call over the phone socket, speaks a reply, and speaks a real helper command result', async () => {
  const db = new PgliteDatabase();
  const live = new LiveHub();
  const human = 'a'.repeat(64), agent = 'b'.repeat(64);
  const workspaceId = '11111111-1111-4111-8111-111111111111', roomId = '22222222-2222-4222-8222-222222222222';
  const synthesize = vi.fn(async function* (_text: string, _voice: string, _signal: AbortSignal) { yield new Uint8Array([200, 1, 200, 1]); });
  let order = false;
  const voice = new VoiceService(db, live, { url: 'ws://rtc', apiKey: 'devkey', apiSecret: 'secret',
    speech: { synthesize }, stt: vi.fn(), brain: { answer: async (_agent, _history, onText) => {
      const text = order ? 'I’ll check it now.' : 'Hello. I can hear you.';
      onText(text); return { text, order };
    } } });
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Caller','caller'),($2,'agent','Ruby','ruby')`, [human, agent]);
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, human]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Voice conversation proof')`, [workspaceId]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES($1,$2,'Ruby DM',$3)`, [roomId, workspaceId, JSON.stringify([human, agent])]);
  for (const id of [human, agent]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [workspaceId, id, roomId]);
  const auth = new TokenAuth(db, async token => ({ subject: token, login: token, name: token }));
  await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login)
    VALUES('github','voice-local-fixture',$1,'https://github.com','beeline','voice-local-fixture')`, [human]);
  const { accessToken } = await auth.exchangeGitHubOidc('voice-local-fixture');
  const daemon = new HelperDaemonService(db, live);
  const phone = new PhoneService(db, 'http://proof');
  const server = createBeelineServer({ database: db, auth, phone, daemon, live, voice, mediaMaximumBytes: 1024 });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/phone/voice/${roomId}/join`;
  let callId: string | undefined;
  try {
    const response = await phoneFetch(url, { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } });
    expect(response.status).toBe(200);
    const joined = await response.json() as { call: { id: string } };
    callId = joined.call.id;
    const runtime = await (voice as unknown as { runtimes: Map<string, Promise<VoiceRoomRuntime>> }).runtimes.get(callId)!;
    expect(runtime).toBeDefined();
    rtc.room.remoteParticipants.set(human, { identity: human });
    await runtime.utterance(human, 'Ruby hello there');
    expect((await phone.readRoom(roomId, human))!.messages.some(message => message.author.pubkey === agent && message.text === 'Hello. I can hear you.')).toBe(true);
    expect(synthesize).toHaveBeenCalled();
    expect(rtc.audio.captureFrame).toHaveBeenCalled();

    order = true;
    await runtime.utterance(human, 'Ruby check the latest build');
    const command = (await readAgentCommands(db, agent, roomId)).commands[0]!;
    expect(command).toBeDefined();
    await startQueuedCommand(daemon, { roomId, commandId: command.id }, agent);
    const beforeReport = synthesize.mock.calls.length;
    const framesBeforeReport = rtc.audio.captureFrame.mock.calls.length;
    await daemon.execute('postRoomMessage', { roomId, requestId: command.turnRequestId, text: 'The build is passing.' }, agent);
    await runtime.refresh();
    await vi.waitFor(() => expect(synthesize.mock.calls.length).toBeGreaterThan(beforeReport));
    expect(synthesize.mock.calls.some(args => args[0] === 'The build is passing.')).toBe(true);
    await vi.waitFor(() => expect(rtc.audio.captureFrame.mock.calls.length).toBeGreaterThan(framesBeforeReport));
    const reports = await db.query('SELECT spoken_message_id FROM voice_orders WHERE call_id=$1', [callId]);
    expect(reports.rows[0]?.spoken_message_id).toBeTruthy();
  } finally {
    if (callId) await voice.leave(callId, human);
    await voice.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.close();
  }
}, 30_000);

it.each(['helper', 'missing', 'on_demand', 'webhook'] as const)(
  'VOICE-EXTERNAL-QUEUE: a %s delivery queue only suppresses conversation when it can receive live work',
  async delivery => {
    const db = await migratedDatabase();
    const live = new LiveHub();
    const human = 'c'.repeat(64), agent = 'd'.repeat(64);
    const workspace = '33333333-3333-4333-8333-333333333333';
    const room = '44444444-4444-4444-8444-444444444444';
    const answer = vi.fn(async () => ({ text: 'I am here. What do you need?', order: false }));
    const synthesize = vi.fn(async function* (_text: string) { yield new Uint8Array([200, 1, 200, 1]); });
    const voice = new VoiceService(db, live, { url: 'ws://rtc', apiKey: 'devkey', apiSecret: 'secret',
      speech: { synthesize }, stt: vi.fn(), brain: { answer } });
    let callId: string | undefined;
    try {
      await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES
        ($1,'human','Caller','caller'),($2,'agent','Grok Bot','grok_bot')`, [human, agent]);
      await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agent, human]);
      await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Voice external queue proof')", [workspace]);
      await db.query("INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES($1,$2,'Grok Bot DM',$3)", [room, workspace, JSON.stringify([human, agent])]);
      for (const id of [human, agent]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [workspace, id, room]);
      if (delivery !== 'helper') {
        await db.query(`INSERT INTO rooms_mcp_clients(id,name,redirects) VALUES('voice-client','Grok Bot','[]')`);
        await db.query(`INSERT INTO rooms_mcp_connections(client_id,identity_id,scope)
          VALUES('voice-client',$1,'rooms:read rooms:write')`, [human]);
        await db.query(`INSERT INTO rooms_mcp_members(client_id,owner_id,member_id,model_label,callback_url)
          VALUES('voice-client',$1,$2,'Grok Bot',$3)`,
        [human, agent, delivery === 'webhook' ? 'https://receiver.example/wake' : null]);
        if (delivery === 'on_demand') await db.query(`INSERT INTO rooms_mcp_delivery
          (member_id,generation,mechanism,host,surface,conversation,nonce_hash,probe)
          VALUES($1,'voice-generation','on_demand','Grok','chat','voice-test','unused','{}')`, [agent]);
      }
      const joined = await voice.join(room, human); callId = joined.call.id;
      const runtime = await (voice as unknown as { runtimes: Map<string, Promise<VoiceRoomRuntime>> }).runtimes.get(callId)!;
      rtc.room.remoteParticipants.set(human, { identity: human });
      answer.mockResolvedValueOnce({ text: '', order: true });
      await runtime.utterance(human, 'Grok Bot check the latest build');
      const initial = (await db.query<{ id: string }>(`SELECT id FROM agent_commands
        WHERE room_id=$1 AND agent_id=$2 AND reason='voice_order'`, [room, agent])).rows[0]!;
      expect(initial).toBeDefined();

      // An unclaimed external request must not turn all later conversation
      // into silent handoffs to a host with no inbound delivery mechanism.
      await runtime.utterance(human, "Grok Bot what's your name?");
      const liveDelivery = delivery === 'helper' || delivery === 'webhook';
      expect(answer).toHaveBeenCalledTimes(liveDelivery ? 1 : 2);
      if (liveDelivery) expect(synthesize.mock.calls.map(call => call[0]))
        .toEqual(['Checking. I’ll tell you when I have it.']);
      else {
        expect(synthesize).toHaveBeenCalledWith('I am here. What do you need?', expect.any(String), expect.any(AbortSignal));
        expect(rtc.audio.captureFrame).toHaveBeenCalled();
        const phone = new PhoneService(db, 'http://proof');
        expect((await phone.readRoom(room, human))!.messages.some(message =>
          message.author.pubkey === agent && message.text === 'I am here. What do you need?')).toBe(true);
      }
      // Voice conversation never drops or pretends to answer the real work.
      expect((await db.query('SELECT state FROM agent_commands WHERE id=$1', [initial.id])).rows)
        .toEqual([{ state: 'pending' }]);
      expect((await db.query('SELECT source_message_id FROM voice_orders WHERE call_id=$1', [callId])).rows)
        .toHaveLength(liveDelivery ? 2 : 1);
    } finally {
      if (callId) await voice.leave(callId, human);
      await voice.close(); await db.close();
    }
  }, 30_000,
);

import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { phoneFetch } from '../../../tests/helpers/phone-operation.js';
import { TokenAuth } from './auth.js';
import { migrate } from './database.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { createBeelineServer } from './server.js';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
import { CommandExecutionContext, runServerCommandIntake } from '../../body/src/server-command-intake.js';
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

it('starts over the phone socket, speaks a reply, and speaks a real helper command result', async () => {
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
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [roomId, workspaceId]);
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
    const command = (await readAgentCommands(db, roomId, agent)).commands[0]!;
    expect(command).toBeDefined();
    await daemon.execute('claimAgentCommand', { roomId, commandId: command.id, generationId: 'voice-proof-generation' }, agent);
    const beforeReport = synthesize.mock.calls.length;
    const framesBeforeReport = rtc.audio.captureFrame.mock.calls.length;
    await daemon.execute('postRoomMessage', { roomId, requestId: command.turnRequestId, generationId: 'voice-proof-generation', text: 'The build is passing.' }, agent);
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

it.each(['queued', 'running'] as const)('batches five voice chunks behind a %s DM turn without per-chunk acknowledgements', async state => {
  const db = await migratedDatabase(), live = new LiveHub();
  const human = 'c'.repeat(64), agent = 'd'.repeat(64);
  const workspaceId = '33333333-3333-4333-8333-333333333333';
  const phone = new PhoneService(db, 'http://proof'), daemon = new HelperDaemonService(db, live);
  const answer = vi.fn(async () => ({ text: "Checking. I’ll tell you when I have it.", order: true }));
  const synthesize = vi.fn(async function* (_text: string) { yield new Uint8Array([200, 1, 200, 1]); });
  const voice = new VoiceService(db, live, { url: 'ws://rtc', apiKey: 'devkey', apiSecret: 'secret',
    speech: { synthesize }, stt: vi.fn(), brain: { answer } });
  const scratch = await mkdtemp(join(tmpdir(), 'beeline-voice-batch-'));
  const context = new CommandExecutionContext(scratch), abort = new AbortController();
  const invocations: AgentCommand[][] = [], prompts: AgentCommand[] = [], errors: unknown[] = [];
  let finishFirst!: () => void;
  const first = new Promise<void>(resolve => { finishFirst = resolve; });
  let push: ((commands: readonly AgentCommand[]) => void) | undefined;
  const api = {
    execute: (name: string, input: Record<string, unknown>) => daemon.execute(name as never, input as never, agent),
    liveSubscribe: (_room: unknown, _cursor: unknown, _items: unknown, _state: unknown, _presence: unknown, onCommands: typeof push) => {
      push = onCommands; return () => {};
    },
  } as unknown as DaemonApiClient;
  const intake = () => runServerCommandIntake({ api, roomId, agentId: agent, context, signal: abort.signal,
    stop: () => {}, onError: error => errors.push(error), run: async command => {
      invocations.push([...context.commands]); prompts.push(command);
      if (state === 'running' && invocations.length === 1) await first;
      else {
        await daemon.execute('postRoomMessage', { roomId, requestId: command.turnRequestId,
          generationId: context.generationId, text: 'Answer to the latest question, with earlier context.' }, agent);
        abort.abort();
      }
    } });
  let roomId = '', callId: string | undefined, running: Promise<void> | undefined;
  try {
    await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Caller','caller'),($2,'agent','Ruby','ruby')`, [human, agent]);
    await db.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [agent, human]);
    await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Voice batch proof')", [workspaceId]);
    for (const id of [human, agent]) await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [workspaceId, id]);
    roomId = (await phone.execute('resolveDirectMessage', { workspaceId, participantId: agent }, human)).id;
    await phone.execute('sendRoomMessage', { roomId, text: '@ruby Initial task' }, human);
    const joined = await voice.join(roomId, human); callId = joined.call.id;
    const runtime = await (voice as unknown as { runtimes: Map<string, Promise<VoiceRoomRuntime>> }).runtimes.get(callId)!;
    rtc.room.remoteParticipants.set(human, { identity: human });
    if (state === 'running') {
      running = intake();
      await vi.waitFor(() => expect(invocations).toHaveLength(1));
    }
    const chunks = ['a little background noise', 'hold on', 'Why did you get', 'let me finish', 'What caused the build failure?'];
    for (const [index, chunk] of chunks.entries()) {
      await runtime.prepareEager(human, { event: 'EagerEndOfTurn', turn_index: index, sequence_id: index, transcript: chunk });
      await runtime.utterance(human, chunk);
      push?.((await daemon.execute('getAgentCommands', { roomId }, agent)).commands);
    }
    if (state === 'queued') running = intake();
    finishFirst();
    await running;
    expect(invocations).toHaveLength(state === 'running' ? 2 : 1);
    const batch = invocations.at(-1)!;
    expect(batch).toHaveLength(state === 'running' ? 5 : 6);
    for (const chunk of chunks) expect(batch.some(command => command.source.body.includes(chunk))).toBe(true);
    expect(prompts.at(-1)?.source.body).toContain(chunks.at(-1));
    expect((await daemon.execute('getAgentCommands', { roomId }, agent)).commands).toEqual([]);
    expect(errors).toEqual([]);
    expect(answer).not.toHaveBeenCalled();
    expect(prompts.at(-1)?.source.body).not.toContain('Answer this request in this turn');
    expect((await db.query(`SELECT text FROM messages WHERE room_id=$1 AND author_id=$2 AND text LIKE 'Checking.%'`, [roomId, agent])).rows).toEqual([]);
    // Only the single current answer is spoken, never five intake acknowledgements.
    await runtime.refresh();
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledOnce());
    expect(synthesize.mock.calls[0]?.[0]).toBe('Answer to the latest question, with earlier context.');
  } finally {
    abort.abort(); finishFirst(); await running;
    if (callId) await voice.leave(callId, human);
    await voice.close(); await db.close(); await rm(scratch, { recursive: true, force: true });
  }
}, 30_000);

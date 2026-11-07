import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FlyMachines } from './fly-machines.js';
import { FreeAgentService, freeAgentConfigFromEnv } from './free-agents.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { HelperDaemonService } from './test-fixtures/helper-daemon.js';
import { DaemonService } from './daemon-service.js';
import { claimAgentConnection } from './connection-presence.js';
import {
  MODEL_AGENT,
  MODEL_OWNER,
  MODEL_ROOM,
  MODEL_WORKSPACE,
  ownedModelFixture,
} from './test-fixtures/owned-model.js';
import { selectComposerAckPresentation } from '../../mobile/sources/buzz/room-indicators.js';
import { readRoomView } from '@beeline/api-contract/phone';

let fixture: Awaited<ReturnType<typeof ownedModelFixture>>, phone: PhoneService, live: LiveHub;
const image = 'new-release';
beforeEach(async () => {
  fixture = await ownedModelFixture();
  live = new LiveHub();
  phone = new PhoneService(fixture.db, 'https://synthetic.test');
  await fixture.db.query(`UPDATE agent_connections SET released_at=clock_timestamp()`);
  await fixture.db.query(
    `UPDATE agent_commands SET state='complete',completed_at=clock_timestamp()`,
  );
  await fixture.db.query(`UPDATE identities SET name='Beebee',handle='beebee' WHERE id=$1`, [
    MODEL_AGENT,
  ]);
  await fixture.db.query(
    `UPDATE free_agents SET state='sleeping',fly_machine_id='m1' WHERE agent_id=$1`,
    [MODEL_AGENT],
  );
  await fixture.db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$3,'owner'),($1,$2,$3,'owner')`,
    [MODEL_WORKSPACE, MODEL_ROOM, MODEL_OWNER],
  );
});
afterEach(async () => {
  vi.useRealTimers();
  await fixture.db.close();
});
const config = () =>
  freeAgentConfigFromEnv(
    { BEELINE_FREE_AGENT_SEAL_KEY: 'synthetic', FLY_FREE_AGENT_IMAGE: image },
    'https://synthetic.test',
  )!;
const send = (text: string) =>
  phone.execute('sendRoomMessage', { roomId: MODEL_ROOM, text: `@beebee ${text}` }, MODEL_OWNER);

it.each(['before', 'after'] as const)('connected helper retains owned-model authority when negotiation is %s runtime catch-up', async timing => {
  const first = await send('original first message'), second = await send('original second message');
  const daemon = new DaemonService(fixture.db, live);
  daemon.setOwnedModel({ credentials: fixture.credentials, ready: () => true });
  const source = { connectionId: 'current-image-helper', epoch: await claimAgentConnection(
    fixture.db, live, MODEL_AGENT, {}, { connectionId: 'current-image-helper', instanceId: 'synthetic-server' }) };
  const provider = new FlyMachines('synthetic', 'proof', async () => Response.json({
    id: 'm1', state: 'started', instance_id: 'current', config: { image },
  }));
  const service = new FreeAgentService(fixture.db, config(), provider, async () => ({ exchangeToken: 'synthetic' }));
  const negotiate = () => daemon.negotiateOwnedModel(MODEL_AGENT, source, true);
  const selectedBefore = timing === 'before' ? await negotiate() : undefined;
  // Registration and listener catch-up both admit this acquisition while the
  // original messages are still pending. A serving helper must remain ready.
  await service.resumePendingWork();
  const selected = selectedBefore ?? await negotiate();
  const pending = await daemon.execute('getAgentCommands', { roomId: MODEL_ROOM }, MODEL_AGENT);
  const generationId = 'original-messages';
  const claimed = await daemon.execute('claimAgentTurn', {
    roomId: MODEL_ROOM, commandId: pending.commands[0]!.id, generationId,
  }, MODEL_AGENT, source, selected.capability);
  expect(claimed.commands.map(command => command.source.id)).toEqual([first.messageId, second.messageId]);
  expect(claimed.modelCredential).toMatchObject({ v: 1 });
  const actor = await fixture.credentials.authenticate(fixture.db, claimed.modelCredential!.token);
  expect(actor.binding).toMatchObject({ connectionId: source.connectionId, connectionEpoch: source.epoch, generationId });
  await daemon.execute('postRoomMessage', {
    roomId: MODEL_ROOM, requestId: claimed.commands[0]!.turnRequestId!, generationId,
    text: 'Both original messages answered.',
  }, MODEL_AGENT);
  await daemon.execute('releaseAgentTurn', { roomId: MODEL_ROOM, generationId }, MODEL_AGENT, source);
  expect((await fixture.db.query('SELECT state FROM free_agents WHERE agent_id=$1', [MODEL_AGENT])).rows)
    .toEqual([{ state: 'running' }]);
  expect((await fixture.db.query('SELECT state FROM agent_commands WHERE source_message_id=ANY($1::text[])',
    [[first.messageId, second.messageId]])).rows).toEqual([{ state: 'complete' }, { state: 'complete' }]);
  expect((await phone.readRoom(MODEL_ROOM, MODEL_OWNER))?.messages.some(message => message.text === 'Both original messages answered.')).toBe(true);
});

it('Klor: a lost update reply after 34.293s still answers both original queued messages, outside execution', async () => {
  let state = 'stopped',
    version = 'old',
    currentImage = 'old';
  let finishPreparation!: () => void;
  const requests: string[] = [];
  const request = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname.split('/machines/m1')[1]!;
    requests.push(`${init?.method} ${path}`);
    if (init?.method === 'GET' && !path)
      return Response.json({
        id: 'm1',
        state,
        instance_id: version,
        config: { image: currentImage, rootfs: { persist: 'always' } },
      });
    if (init?.method === 'POST' && !path) {
      const update = JSON.parse(String(init.body));
      currentImage = update.config.image;
      version = 'replacement';
      state = 'replacing';
      finishPreparation = () => {
        state = update.skip_launch ? 'stopped' : 'started';
      };
      if (update.skip_launch) return Response.json({ instance_id: version });
      throw new TypeError('synthetic lost accepted update reply');
    }
    if (path.startsWith('/wait')) return new Response('{}', { status: 408 });
    if (path === '/start') {
      state = 'started';
      return Response.json({});
    }
    throw new Error('Unexpected provider action');
  });
  const service = new FreeAgentService(
    fixture.db,
    config(),
    new FlyMachines('synthetic', 'proof', request),
    async () => ({ exchangeToken: 'synthetic' }),
  );
  const first = await send('continue original first'),
    second = await send('continue original second');
  expect(await service.wake(MODEL_AGENT)).toBe(true);
  const view = (await phone.readRoom(MODEL_ROOM, MODEL_OWNER))!;
  expect(view.pendingAgentCommands).toHaveLength(1);
  const pending = readRoomView(view)!.pendingAgentCommands![0];
  expect(pending.runtimePhase?.phase).toBe('updating');
  const active = view.latestAgentTurns?.find(turn => turn.status === 'working');
  const presentation = selectComposerAckPresentation({
    activeTurnPubkey: active?.agentPubkey,
    activeTurnRequestId: active?.requestId,
    activeTurnGenerationId: active?.generationId,
    activeTurnStartedAt: active?.startedAt ?? active?.createdAt,
    isCorner: false,
    now: Date.now(),
    viewerPubkey: MODEL_OWNER,
    viewerCanSend: true,
    pendingAgentCommands: [pending],
    conversationIdentities: new Map(
      view.members.map((member) => [member.identity.pubkey, member.identity]),
    ),
  });
  expect(presentation?.label).toBe('Beebee · updating — downloading the new release…');
  const reserved = selectComposerAckPresentation({isCorner:false,now:Date.now(),pendingAgentCommands:[pending],
    activeTurnPubkey:MODEL_AGENT,activeTurnGenerationId:'pending:'+pending.requestId,activeTurnStartedAt:pending.createdAt,
    conversationIdentities:new Map(view.members.map(member=>[member.identity.pubkey,member.identity]))});
  expect(reserved?.label).toBe(presentation?.label);
  expect(reserved).not.toHaveProperty('startedAt');
  expect(presentation).not.toHaveProperty('startedAt');
  expect(presentation).not.toHaveProperty('turnKey');
  expect(presentation?.stop).toEqual({ agentPubkey: MODEL_AGENT, requestId: pending.requestId });
  const queued = (
    await fixture.db.query(
      `SELECT source_message_id,claimed_at FROM agent_commands WHERE state='pending' ORDER BY created_at`,
    )
  ).rows;
  expect(queued.map((row) => row.source_message_id)).toEqual([first.messageId, second.messageId]);
  expect(queued.every((row) => row.claimed_at === null)).toBe(true);
  // Only the stand-in provider advances its preparation clock. No production wait owns launch.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 34_293);
  finishPreparation();
  expect(state).toBe('started');
  expect(requests).toEqual(['GET ', 'GET ', 'POST ', 'GET ']);
  const daemon = new HelperDaemonService(fixture.db, live);
  // Authenticated connection and normal intake own pickup, not a third message.
  const commands = await daemon.execute('getAgentCommands', { roomId: MODEL_ROOM }, MODEL_AGENT);
  const claimed = await daemon.execute(
    'claimAgentTurn',
    { roomId: MODEL_ROOM, commandId: commands.commands[0]!.id, generationId: 'original-answer' },
    MODEL_AGENT,
  );
  expect(claimed.commands.map((command) => command.source.id)).toEqual([
    first.messageId,
    second.messageId,
  ]);
  const clocks = await fixture.db.query(`SELECT
    extract(epoch FROM (turn.started_at-command.created_at)) preparation_seconds,
    extract(epoch FROM (turn.started_at-command.claimed_at)) execution_seconds
    FROM agent_commands command JOIN agent_turns turn ON turn.room_id=command.room_id
      AND turn.agent_id=command.agent_id AND turn.request_id=command.turn_request_id
    WHERE command.source_message_id=ANY($1::text[])`, [[first.messageId,second.messageId]]);
  expect(clocks.rows).toHaveLength(2);
  for(const clock of clocks.rows) {
    expect(Number(clock.preparation_seconds)).toBeGreaterThanOrEqual(34);
    expect(Number(clock.execution_seconds)).toBe(0);
  }
  const requestId = claimed.commands[0]!.turnRequestId!;
  await daemon.execute(
    'postRoomMessage',
    {
      roomId: MODEL_ROOM,
      requestId,
      generationId: 'original-answer',
      text: 'Both original requests answered.',
    },
    MODEL_AGENT,
  );
  for (const command of claimed.commands)
    await daemon.execute(
      'postAgentTurnReceipt',
      {
        roomId: MODEL_ROOM,
        requestId: command.turnRequestId!,
        generationId: 'original-answer',
        status: 'complete',
      },
      MODEL_AGENT,
    );
  expect(
    (
      await fixture.db.query(
        `SELECT state FROM agent_commands WHERE source_message_id=ANY($1::text[])`,
        [[first.messageId, second.messageId]],
      )
    ).rows,
  ).toEqual([{ state: 'complete' }, { state: 'complete' }]);
  expect(
    (await phone.readRoom(MODEL_ROOM, MODEL_OWNER))?.messages.some(
      (message) => message.text === 'Both original requests answered.',
    ),
  ).toBe(true);
});

it('a new human message wakes a stale waking row whose stopped Machine needs an image update', async () => {
  await fixture.db.query(
    `UPDATE free_agents SET state='waking',wake_requested_at=clock_timestamp()-interval '2 hours'`,
  );
  const message = await send('new human message after an incomplete release wake');
  let state = 'stopped', currentImage = 'old';
  const requests: string[] = [];
  const provider = new FlyMachines('synthetic', 'proof', async (url, init) => {
    const path = new URL(String(url)).pathname.split('/machines/m1')[1]!;
    requests.push(`${init?.method} ${path}`);
    if (!path && init?.method === 'GET')
      return Response.json({ id: 'm1', state, instance_id: 'old', config: { image: currentImage } });
    if (!path && init?.method === 'POST') {
      currentImage = JSON.parse(String(init.body)).config.image;
      state = 'replacing';
      return Response.json({ instance_id: 'replacement', state });
    }
    if (path === '/wait') { state = 'stopped'; return Response.json({ state }); }
    if (path === '/start') { state = 'started'; return Response.json({}); }
    throw new Error(`Unexpected Fly call ${path}`);
  });
  const service = new FreeAgentService(fixture.db, config(), provider, async () => ({
    exchangeToken: 'synthetic',
  }));
  await service.resumePendingWork();
  expect(state).toBe('started');
  expect(currentImage).toBe(image);
  expect(requests.filter((request) => request.startsWith('POST'))).toEqual(['POST ', 'POST /start']);
  expect((await fixture.db.query('SELECT state FROM agent_commands WHERE source_message_id=$1', [message.messageId])).rows)
    .toEqual([{ state: 'pending' }]);
});

it('a definite provider failure retains work with a truthful saved-message phase and clears its owner', async () => {
  const original = await send('keep me');
  let reads = 0;
  const provider = new FlyMachines('synthetic', 'proof', async () => {
    reads++;
    throw new TypeError('provider unavailable');
  });
  const service = new FreeAgentService(fixture.db, config(), provider, async () => ({
    exchangeToken: 'synthetic',
  }));
  expect(await service.wake(MODEL_AGENT)).toBe(false);
  expect(reads).toBe(2);
  const view = (await phone.readRoom(MODEL_ROOM, MODEL_OWNER))!;
  const presentation = selectComposerAckPresentation({
    isCorner: false,
    now: Date.now(),
    pendingAgentCommands: view.pendingAgentCommands,
  });
  expect(presentation?.label).toContain("couldn't start. Your message is saved.");
  expect(presentation?.live).toBe(false);
  expect((await fixture.db.query('SELECT runtime_owner,state FROM free_agents')).rows).toEqual([
    { runtime_owner: null, state: 'stopped' },
  ]);
  expect(
    (
      await fixture.db.query('SELECT state FROM agent_commands WHERE source_message_id=$1', [
        original.messageId,
      ])
    ).rows,
  ).toEqual([{ state: 'pending' }]);
});

it('adopts an accepted create after its reply is lost without rotating bootstrap or destroying files', async () => {
  await fixture.db.query(`UPDATE free_agents SET fly_machine_id=NULL,state='provisioning'`);
  await send('my original files');
  let machine:
    | {
        id: string;
        state: string;
        instance_id: string;
        config: Record<string, unknown> & { image: string };
      }
    | undefined;
  let bootstrapHash: string | undefined;
  const mutations: string[] = [];
  const provider = new FlyMachines('synthetic', 'proof', async (url, init) => {
    const path = new URL(String(url)).pathname.split('/machines')[1]!;
    if (init?.method === 'GET') return Response.json(machine ? [machine] : []);
    mutations.push(`${init?.method} ${path}`);
    if (init?.method === 'POST' && !path) {
      const spec = JSON.parse(String(init.body));
      machine = {
        id: 'adopted',
        state: 'starting',
        instance_id: 'created-once',
        config: spec.config,
      };
      bootstrapHash = (
        await fixture.db.query<{ bootstrap_hash: string }>('SELECT bootstrap_hash FROM free_agents')
      ).rows[0]!.bootstrap_hash;
      throw new TypeError('synthetic accepted create with lost reply');
    }
    throw new Error('A lost create does not authorize another mutation');
  });
  const service = new FreeAgentService(fixture.db, config(), provider, async () => ({
    exchangeToken: 'synthetic',
  }));
  expect(await service.provision(MODEL_AGENT)).toBe(true);
  expect(mutations).toEqual(['POST ']);
  expect(machine?.config.rootfs).toEqual({ persist: 'always' });
  expect(
    (await fixture.db.query('SELECT fly_machine_id,bootstrap_hash,runtime_owner FROM free_agents'))
      .rows[0],
  ).toEqual({ fly_machine_id: 'adopted', bootstrap_hash: bootstrapHash, runtime_owner: null });
});

it('Stop during release preparation withdraws the original command even if launch finishes later', async () => {
  await send('withdraw this request');
  const pending = (await phone.readRoom(MODEL_ROOM, MODEL_OWNER))!.pendingAgentCommands![0]!;
  let finish!: (value: Response) => void;
  let accepted = false;
  const completion = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const provider = new FlyMachines('synthetic', 'proof', async (_url, init) => {
    if (init?.method === 'GET')
      return Response.json({
        id: 'm1',
        state: 'stopped',
        instance_id: 'old',
        config: { image: 'old' },
      });
    accepted = true;
    return completion;
  });
  const service = new FreeAgentService(fixture.db, config(), provider, async () => ({
    exchangeToken: 'synthetic',
  }));
  const acquisition = service.wake(MODEL_AGENT);
  await vi.waitFor(() => expect(accepted).toBe(true));
  await phone.execute(
    'cancelAgentTurn',
    { roomId: MODEL_ROOM, requestId: pending.requestId, agentId: MODEL_AGENT },
    MODEL_OWNER,
  );
  finish(Response.json({ id: 'm1', instance_id: 'released', state: 'starting' }));
  await acquisition;
  expect((await phone.readRoom(MODEL_ROOM, MODEL_OWNER))!.pendingAgentCommands).toEqual([]);
  const daemon = new HelperDaemonService(fixture.db, live);
  expect(
    (await daemon.execute('getAgentCommands', { roomId: MODEL_ROOM }, MODEL_AGENT)).commands.filter(
      (command) => command.action === 'input',
    ),
  ).toEqual([]);
  expect(
    (
      await fixture.db.query(
        `SELECT state FROM agent_commands WHERE turn_request_id=$1 AND action='input'`,
        [pending.requestId],
      )
    ).rows.every((row) => row.state !== 'claimed' && row.state !== 'pending'),
  ).toBe(true);
});

it('duplicate wake events share ownership and an old completion cannot overwrite helper readiness', async () => {
  await send('original work');
  let accepted = false,
    finish!: (value: Response) => void;
  const completion = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  let mutations = 0;
  const provider = new FlyMachines('synthetic', 'proof', async (_url, init) => {
    if (init?.method === 'GET')
      return Response.json({
        id: 'm1',
        state: 'stopped',
        instance_id: 'old',
        config: { image: 'old' },
      });
    mutations++;
    accepted = true;
    return completion;
  });
  const service = new FreeAgentService(fixture.db, config(), provider, async () => ({
    exchangeToken: 'synthetic',
  }));
  const acquisition = service.wake(MODEL_AGENT);
  await vi.waitFor(() => expect(accepted).toBe(true));
  expect(await service.wake(MODEL_AGENT)).toBe(false);
  expect(mutations).toBe(1);
  const daemon = new HelperDaemonService(fixture.db, live);
  const commands = await daemon.execute('getAgentCommands', { roomId: MODEL_ROOM }, MODEL_AGENT);
  await daemon.execute(
    'claimAgentTurn',
    { roomId: MODEL_ROOM, commandId: commands.commands[0]!.id, generationId: 'ready' },
    MODEL_AGENT,
  );
  finish(Response.json({ id: 'm1', instance_id: 'release', state: 'started' }));
  await acquisition;
  expect(
    (
      await fixture.db.query<{ runtime_phase: { phase: string } }>(
        'SELECT runtime_phase FROM free_agents',
      )
    ).rows[0]!.runtime_phase.phase,
  ).toBe('preparing');
  expect(mutations).toBe(1);
});

it('does not lose a committed wake delivered after the previous acquisition’s no-work read', async () => {
  let readFinished!: () => void, release!: () => void;
  const observed = new Promise<void>(resolve => { readFinished = resolve; });
  const drain = new Promise<void>(resolve => { release = resolve; });
  let pause = true;
  const db: import('./database.js').SqlDatabase = {
    query: (sql, values) => fixture.db.query(sql, values),
    transaction: async work => {
      const result = await fixture.db.transaction(work);
      if (pause) { pause = false; readFinished(); await drain; }
      return result;
    },
  };
  let started = 0;
  const provider = new FlyMachines('synthetic','proof',async (url,init) => {
    if(init?.method === 'POST') { started++; return Response.json({}); }
    return Response.json({id:'m1',state:started ? 'started' : 'suspended',instance_id:'current',config:{image}});
  });
  const service = new FreeAgentService(db,config(),provider,async()=>({exchangeToken:'synthetic'}));
  service.kick(MODEL_AGENT);
  await observed;
  await send('committed during the prior completion');
  service.kick(MODEL_AGENT);
  release();
  await vi.waitFor(() => expect(started).toBe(1));
});

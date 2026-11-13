import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FlyMachines } from './fly-machines.js';
import { FreeAgentService, freeAgentConfigFromEnv, tokenHash } from './free-agents.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { claimAgentConnection, releaseAgentConnection } from './connection-presence.js';
import {
  MODEL_AGENT,
  MODEL_OWNER,
  MODEL_ROOM,
  MODEL_WORKSPACE,
  ownedModelFixture,
} from './test-fixtures/owned-model.js';
import { selectComposerAckPresentation } from '../../mobile/sources/buzz/room-indicators.js';

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
  const provider = new FlyMachines('synthetic', 'proof', async (url) => Response.json(String(url).endsWith('/machines') ? [] : {
    id: 'm1', state: 'started', instance_id: 'current', config: { image },
  }));
  const service = new FreeAgentService(fixture.db, config(), provider, async () => ({ exchangeToken: 'synthetic' }));
  const negotiate = () => daemon.negotiateOwnedModel(MODEL_AGENT, true);
  const selectedBefore = timing === 'before' ? await negotiate() : undefined;
  // Registration and listener catch-up both admit this acquisition while the
  // original messages are still pending. A serving helper must remain ready.
  await service.reconcileAll();
  const selected = selectedBefore ?? await negotiate();
  const pending = await daemon.execute('getAgentCommands', { roomId: MODEL_ROOM }, MODEL_AGENT);
  const generationId = 'original-messages';
  const claimed = await daemon.execute('claimAgentTurn', { roomId: MODEL_ROOM, commandId: pending.commands[0]!.id }, MODEL_AGENT, source, selected.capability);
  const workingRoom = (await phone.readRoom(MODEL_ROOM, MODEL_OWNER))!;
  const working = workingRoom.latestAgentTurns.find(turn => turn.status === 'working')!;
  expect(workingRoom.pendingAgentCommands).toEqual([]);
  const workingAck = selectComposerAckPresentation({ isCorner: false, now: Date.now(),
    activeTurnPubkey: working.agentPubkey, activeTurnRequestId: working.requestId,
    pendingAgentCommands: first.pendingAgentCommands,
    conversationIdentities: new Map([[MODEL_AGENT, { pubkey: MODEL_AGENT, kind: 'agent', name: 'Beebee' }]]) });
  expect(workingAck?.label).not.toContain('starting');
  expect(workingAck).not.toBeNull();
  expect(claimed.commands.map(command => command.source.id)).toEqual([first.messageId, second.messageId]);
  expect(claimed.modelCredential).toMatchObject({ v: 1 });
  const actor = await fixture.credentials.authenticate(fixture.db, claimed.modelCredential!.token);
  expect(actor.binding).toMatchObject({ connectionId: null, connectionEpoch: null });
  await daemon.execute('postRoomMessage', { roomId: MODEL_ROOM, requestId: claimed.commands[0]!.turnRequestId!, text: 'Both original messages answered.' }, MODEL_AGENT);
  await daemon.execute('releaseAgentTurn', { roomId: MODEL_ROOM }, MODEL_AGENT, source);
  expect((await fixture.db.query('SELECT state FROM free_agents WHERE agent_id=$1', [MODEL_AGENT])).rows)
    .toEqual([{ state: 'sleeping' }]);
  expect((await fixture.db.query('SELECT state FROM agent_commands WHERE source_message_id=ANY($1::text[])',
    [[first.messageId, second.messageId]])).rows).toEqual([{ state: 'complete' }, { state: 'complete' }]);
  expect((await phone.readRoom(MODEL_ROOM, MODEL_OWNER))?.messages.some(message => message.text === 'Both original messages answered.')).toBe(true);
});


function lab(initial = 'stopped', oldImage = 'old-release') {
  let state=initial, currentImage=oldImage, version='original';
  const calls:string[]=[];
  const hooks:{update?:()=>Promise<void>;suspend?:()=>Promise<void>;failUpdate?:boolean}={};
  const machine=()=>({id:'m1',state,instance_id:version,config:{image:currentImage,rootfs:{persist:'always'}}});
  const provider=new FlyMachines('synthetic','lab',async(url,init)=>{
    const address=new URL(String(url)),path=address.pathname.split('/machines')[1]!;
    if(init?.method==='GET'&&path==='/m1')return Response.json(machine());
    if(init?.method==='GET'&&path==='')return Response.json([machine()]);
    calls.push(`${init?.method} ${path}`);
    if(init?.method==='POST'&&path==='/m1'){
      await hooks.update?.();if(hooks.failUpdate)return new Response('unavailable',{status:500});
      const update=JSON.parse(String(init.body));expect(update.current_version).toBe(version);
      expect(update.config.rootfs).toEqual({persist:'always'});
      currentImage=update.config.image;version='replacement';state='replacing';return Response.json(machine());
    }
    if(path==='/m1/wait'){expect(address.searchParams.get('instance_id')).toBe(version);state=address.searchParams.get('state')!;}
    else if(path==='/m1/start'){expect(['stopped','suspended','created']).toContain(state);state='started';}
    else if(path==='/m1/suspend'){await hooks.suspend?.();state='suspended';}
    else throw new Error(`Unexpected Fly call ${path}`);
    return Response.json({});
  });
  const service=(owner='synthetic-server')=>new FreeAgentService(fixture.db,config(),provider,async()=>({exchangeToken:'synthetic'}),undefined,owner);
  return {calls,hooks,service,state:()=>state};
}

it.each(['stopped','suspended','created'])('confirms a replaced %s machine then explicitly starts it once',async initial=>{
  const runtime=lab(initial);await send('saved message');
  await Promise.all([runtime.service().reconcile(MODEL_AGENT),runtime.service().reconcile(MODEL_AGENT)]);
  expect(runtime.calls).toEqual(['POST /m1','GET /m1/wait','POST /m1/start']);expect(runtime.state()).toBe('started');
  expect((await fixture.db.query(`SELECT state,runtime_owner FROM free_agents`)).rows).toEqual([{state:'sleeping',runtime_owner:null}]);
  expect((await fixture.db.query(`SELECT 1 FROM agent_commands WHERE state='pending'`)).rowCount).toBe(1);
});

it('visits old-image idle mappings independently of retired state without provisioning idle identities',async()=>{
  const runtime=lab();await runtime.service().reconcileAll();expect(runtime.state()).toBe('started');
  runtime.calls.length=0;await fixture.db.query(`UPDATE free_agents SET fly_machine_id=NULL`);
  await runtime.service().reconcileAll();expect(runtime.calls).toEqual([]);
});

it('registration and release never erase in-flight operation ownership',async()=>{
  const runtime=lab();let unblock!:()=>void;
  const wait=new Promise<void>(resolve=>{unblock=resolve;});runtime.hooks.update=()=>wait;
  await send('during preparation');const operation=runtime.service().reconcile(MODEL_AGENT);
  await vi.waitFor(()=>expect(runtime.calls).toContain('POST /m1'));
  const owner=(await fixture.db.query(`SELECT runtime_owner,runtime_operation_id FROM free_agents`)).rows;
  await claimAgentConnection(fixture.db,live,MODEL_AGENT,{}, {connectionId:'replacement',instanceId:'synthetic-server'});
  await releaseAgentConnection(fixture.db,live,MODEL_AGENT,'replacement');
  expect((await fixture.db.query(`SELECT runtime_owner,runtime_operation_id FROM free_agents`)).rows).toEqual(owner);
  await runtime.service().reconcile(MODEL_AGENT);unblock();await operation;
  expect(runtime.calls.filter(call=>call==='POST /m1')).toHaveLength(1);
});

it('hands a peer work committed during suspension and resumes the completed snapshot',async()=>{
  const runtime=lab('started',image);const service=runtime.service(),peer=runtime.service();
  await claimAgentConnection(fixture.db,live,MODEL_AGENT,{}, {connectionId:'serving',instanceId:'synthetic-server'});
  const off=await fixture.db.client.listen('beeline_live_v1',payload=>{
    const event=JSON.parse(payload);if(event.table==='free_agents'&&event.agentId)peer.kick(event.agentId);
  });
  runtime.hooks.suspend=async()=>{await send('while suspending');await peer.reconcile(MODEL_AGENT);};
  await service.reconcile(MODEL_AGENT);
  await vi.waitFor(()=>expect(runtime.state()).toBe('started'));
  expect(runtime.calls).toEqual(['POST /m1/suspend','GET /m1/wait','POST /m1/start']);
  await off();await peer.reconcile(MODEL_AGENT);
});

it('provider failure preserves pending work and never replays the unknown mutation',async()=>{
  const runtime=lab();runtime.hooks.failUpdate=true;await send('saved');
  await expect(runtime.service().reconcile(MODEL_AGENT)).rejects.toThrow('HTTP 500');
  expect(runtime.calls).toEqual(['POST /m1']);
  expect((await fixture.db.query(`SELECT 1 FROM agent_commands WHERE state='pending'`)).rowCount).toBe(1);
  expect((await fixture.db.query(`SELECT runtime_owner FROM free_agents`)).rows).toEqual([{runtime_owner:null}]);
});

it('full read and send receipt show the accepted pending command without a synthetic working turn',async()=>{
  const receipt=await send('before boot');const room=(await phone.readRoom(MODEL_ROOM,MODEL_OWNER))!;
  expect(room.pendingAgentCommands).toEqual(receipt.pendingAgentCommands);
  expect((await fixture.db.query(`SELECT 1 FROM agent_turns WHERE status='working'`)).rowCount).toBe(0);
  const pending=room.pendingAgentCommands![0]!;
  const ack=selectComposerAckPresentation({isCorner:false,now:Date.now(),viewerPubkey:MODEL_OWNER,viewerCanSend:true,
    pendingAgentCommands:room.pendingAgentCommands,conversationIdentities:new Map([[MODEL_AGENT,{pubkey:MODEL_AGENT,kind:'agent',name:'Beebee'}]])});
  expect(pending.runtimePhase).toBeUndefined();
  expect(ack).toBeNull();
});

it('adopts a lost create result using the original bootstrap without replaying create',async()=>{
  await fixture.db.query('UPDATE free_agents SET fly_machine_id=NULL');await send('first boot');
  let created:import('./fly-machines.js').FreeAgentMachineSpec|undefined;let creates=0;
  const machine=()=>created?{id:'created',state:'started',instance_id:'v1',config:{image,env:created.env}}:undefined;
  const provider:import('./fly-machines.js').FreeAgentMachines={
    async list(){return[];},async find(){return machine();},async read(){return machine();},
    async create(spec){creates++;created=spec;throw new TypeError('create reply lost');},
    async update(){throw new Error('must not update');},async start(){throw new Error('must not start');},
    async suspend(){throw new Error('must not suspend');},async waitFor(){},async destroy(){throw new Error('must not destroy');},reconnect(){return this;},
  };
  const service=new FreeAgentService(fixture.db,config(),provider,async()=>({exchangeToken:'fixture'}));
  await expect(service.reconcile(MODEL_AGENT)).rejects.toThrow('create reply lost');
  await service.reconcile(MODEL_AGENT);
  expect(creates).toBe(1);
  expect((await fixture.db.query('SELECT fly_machine_id,bootstrap_hash FROM free_agents')).rows)
    .toEqual([{fly_machine_id:'created',bootstrap_hash:tokenHash(created!.env.BEELINE_FREE_AGENT_BOOTSTRAP!)}]);
});

it('Stop during image preparation withdraws the pending command without a synthetic working turn',async()=>{
  const runtime=lab();let unblock!:()=>void;
  const wait=new Promise<void>(resolve=>{unblock=resolve;});runtime.hooks.update=()=>wait;
  const receipt=await send('please stop');const service=runtime.service();const operation=service.reconcile(MODEL_AGENT);
  await vi.waitFor(()=>expect(runtime.calls).toContain('POST /m1'));
  await phone.execute('cancelAgentTurn',{roomId:MODEL_ROOM,agentId:MODEL_AGENT,requestId:receipt.pendingAgentCommands![0]!.requestId},MODEL_OWNER);
  unblock();await operation;
  expect((await phone.readRoom(MODEL_ROOM,MODEL_OWNER))!.pendingAgentCommands).toEqual([]);
  expect((await fixture.db.query("SELECT state FROM agent_commands WHERE source_message_id=$1",[receipt.messageId])).rows).toEqual([{state:'cancelled'}]);
});

it('removal during create retains the tombstone, refuses bootstrap and cleans only that machine',async()=>{
  await fixture.db.query('UPDATE free_agents SET fly_machine_id=NULL');await send('during create');
  let unblock!:()=>void;const wait=new Promise<void>(resolve=>{unblock=resolve;});let started=false,exists=false;
  let bootstrap='';const destroyed:string[]=[];
  const machine=()=>exists?{id:'retired-machine',state:'started',instance_id:'v1',config:{image}}:undefined;
  const provider:import('./fly-machines.js').FreeAgentMachines={
    async list(){return[];},async find(){return machine();},async read(){return machine();},
    async create(spec){bootstrap=spec.env.BEELINE_FREE_AGENT_BOOTSTRAP!;started=true;await wait;exists=true;return{id:'retired-machine'};},
    async update(){throw new Error('must not update');},async start(){throw new Error('must not start');},
    async suspend(){throw new Error('must not suspend');},async waitFor(){},async destroy(id){destroyed.push(id);exists=false;},reconnect(){return this;},
  };
  const service=new FreeAgentService(fixture.db,config(),provider,async()=>({exchangeToken:'fixture'}));
  const operation=service.reconcile(MODEL_AGENT);await vi.waitFor(()=>expect(started).toBe(true));
  await phone.execute('removeAgent',{workspaceId:MODEL_WORKSPACE,agentId:MODEL_AGENT},MODEL_OWNER);
  unblock();await operation;await service.cleanupRemoved(MODEL_AGENT);
  expect(await service.bootstrap(bootstrap)).toBeUndefined();expect(destroyed).toEqual(['retired-machine']);
  expect((await fixture.db.query('SELECT fly_machine_id,removal_cleaned_at FROM free_agents')).rows)
    .toEqual([{fly_machine_id:null,removal_cleaned_at:expect.any(Date)}]);
});

it('resumes a snapshot with claimed work on its old image before replacing that image',async()=>{
  const runtime=lab('suspended');
  await fixture.db.query("UPDATE agent_commands SET state='claimed' WHERE id='synthetic-command'");
  await runtime.service().reconcile(MODEL_AGENT);
  expect(runtime.calls).toEqual(['POST /m1/start']);expect(runtime.state()).toBe('started');
});

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlyMachines } from './fly-machines.js';
import { FreeAgentService, freeAgentConfigFromEnv } from './free-agents.js';
import { LiveHub } from './live.js';
import { claimAgentConnection } from './connection-presence.js';
import { DaemonService } from './daemon-service.js';
import { migratedDatabase, type PgliteDatabase } from './test-support.js';

const OWNER = 'a'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const IMAGE = `registry.fly.io/beeline-free-agents:release@sha256:${'b'.repeat(64)}`;

describe('release refresh and committed free-agent sleep events', () => {
  let db: PgliteDatabase;
  let live: LiveHub;
  let service: FreeAgentService;
  let off: () => void;
  let failStart: string | undefined;
  let beforeUpdate: (() => Promise<void>) | undefined;
  const fleet = new Map<string, { state: string; instance_id: string; config: {
    image: string; env: { keep: string }; rootfs: { persist: string };
  } }>();
  const calls: string[] = [];
  const logs: string[] = [];
  const agentId = (n: number) => n.toString(16).padStart(64, '0');

  beforeEach(async () => {
    db = await migratedDatabase();
    live = new LiveHub();
    fleet.clear(); calls.length = 0; logs.length = 0; failStart = undefined; beforeUpdate = undefined;
    const request = vi.fn<typeof fetch>(async (url, init) => {
      if (new URL(String(url)).pathname.endsWith('/machines')) return Response.json([...fleet].map(([id,machine])=>({id,...machine})));
      const match = new URL(String(url)).pathname.match(/\/machines\/(m\d+)(.*)/)!;
      const [, id, path] = match;
      const machine = fleet.get(id!)!;
      calls.push(`${init?.method} ${id}${path}`);
      if (!path && init?.method === 'GET') return Response.json({id,...machine});
      if (!path && init?.method === 'POST') {
        await beforeUpdate?.();
        const update = JSON.parse(String(init.body));
        expect(update.current_version).toBe(machine.instance_id);
        expect(update.skip_launch).toBe(false);
        machine.config = update.config;
        machine.instance_id += '-updated';
        machine.state = machine.state === 'started' ? 'started' : 'stopped';
        return Response.json({id,...machine});
      }
      if (path === '/stop') machine.state = 'stopped';
      else if (path === '/wait') machine.state = new URL(String(url)).searchParams.get('state')!;
      else if (path === '/suspend') machine.state = 'suspended';
      else if (path === '/start') {
        if (id === failStart) return new Response('start refused', { status: 500 });
        machine.state = 'started';
      } else throw new Error(`Unexpected Fly call ${url}`);
      return Response.json({});
    });
    service = new FreeAgentService(db, freeAgentConfigFromEnv({
      BEELINE_FREE_AGENT_SEAL_KEY: 'test', FLY_FREE_AGENT_IMAGE: IMAGE,
    }, 'https://server.test')!, new FlyMachines('test', 'proof', request), async () => {
      throw new Error('refresh must not provision or bootstrap');
    }, line => logs.push(line));
    off = () => {};
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`, [OWNER]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Refresh')`, [WORKSPACE]);
    await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name,visibility)
      VALUES($1,$2,$3,'General','public')`, [ROOM, WORKSPACE, OWNER]);
  });
  afterEach(async () => { off(); await db.close(); });

  async function seed(n: number, state = 'sleeping', flyState = 'suspended', removed = false, machine = true) {
    const agent = agentId(n);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Starter')`, [agent]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, OWNER]);
    await db.query(`WITH member AS (INSERT INTO memberships(workspace_id,identity_id,role) SELECT $3,$1,'member' WHERE NOT EXISTS(SELECT 1 FROM memberships WHERE workspace_id=$3 AND identity_id=$1 AND room_id IS NULL)) INSERT INTO free_agents(agent_id,owner_id,sealed_keys,state,fly_machine_id,removed_at,created_at) VALUES($1,$2,'sealed',$4,$5,CASE WHEN $6 THEN now() END,now()-interval '30 days')`,
    [agent, OWNER, WORKSPACE, state, machine ? `m${n}` : null, removed]);
    fleet.set(`m${n}`, { state: flyState, instance_id: `v${n}`, config: {
      image: 'registry.fly.io/beeline-free-agents:old@sha256:old',
      env: { keep: agent }, rootfs: { persist: 'always' },
    } });
    return agent;
  }

  async function command(n: number, state: 'pending' | 'claimed') {
    await db.query(`INSERT INTO agent_commands(id,room_id,agent_id,turn_request_id,action,reason,
      root_command_id,root_source_message_id,agent_depth,state)
      VALUES($1,$2,$3,$1,'input','human_tag',$1,$1,0,$4)`, [`command-${n}`, ROOM, agentId(n), state]);
  }

  async function connector(n: number) {
    await db.query(`INSERT INTO workspace_connectors(id,workspace_id,owner_identity_id,helper_agent_id,connector_type)
      VALUES($1,$2,$3,$4,'tailscale')`, [randomUUID(), WORKSPACE, OWNER, agentId(n)]);
  }

  async function connect(n: number) {
    await db.query(`INSERT INTO live_server_instances(instance_id,renewed_at)
      VALUES('legacy-helper-server',clock_timestamp()) ON CONFLICT(instance_id)
      DO UPDATE SET renewed_at=EXCLUDED.renewed_at`);
    // A pre-rebuild helper has no new lifecycle/sleep protocol to report.
    await claimAgentConnection(db, live, agentId(n), { releaseVersion: '0.1.186-rc.4' }, {
      connectionId: `legacy-helper-${n}`, instanceId: 'legacy-helper-server',
    });
  }

  it.each(['current', 'old'])('suspends an idle %s-image helper from its authenticated connection alone', async release => {
    const startup = vi.spyOn(service, 'reconcileAll');
    const signals = vi.spyOn(service, 'reconcile');
    off = service.subscribeToWakes(live);
    await startup.mock.results[0]!.value;
    await seed(1, 'running', 'started');
    if (release === 'current') fleet.get('m1')!.config.image = IMAGE;

    await connect(1);
    expect(signals).toHaveBeenCalledWith(agentId(1));
    await Promise.all(signals.mock.results.map(result => result.value));

    expect((await db.query('SELECT 1 FROM agent_commands')).rowCount).toBe(0);
    expect(fleet.get('m1')).toMatchObject({ state: 'suspended', config: { image: IMAGE } });
    expect(calls.filter(call => call.startsWith('POST'))).toEqual([
      ...(release === 'old' ? ['POST m1'] : []), 'POST m1/suspend',
    ]);
  });

  it.each(['claimed', 'connector'] as const)('release visits replace and suspend a connected idle helper while %s work retains its image', async work => {
    await seed(1, 'running', 'started');
    await seed(2, 'running', 'started');
    await connect(1);
    await connect(2);
    if (work === 'claimed') await command(2, work);
    else {
      await connector(2);
      expect(await new DaemonService(db, live).execute('getConnectorAssignments', { agentId: agentId(2) }, agentId(2)))
        .toMatchObject({ assignments: [{ kind: 'install', connectorType: 'tailscale' }] });
    }

    await service.reconcileAll();

    expect(fleet.get('m1')).toMatchObject({ state: 'suspended', config: { image: IMAGE } });
    expect(fleet.get('m2')).toMatchObject({ state: 'started', instance_id: 'v2' });
    expect(fleet.get('m2')!.config.image).not.toBe(IMAGE);
    expect(calls.filter(call => call.startsWith('POST'))).toEqual(['POST m1', 'POST m1/suspend']);
  });

  it.each(['startup', 'release', 'connection'].flatMap(signal =>
    ['old', 'current'].map(binding => ({ signal, binding }))))('$signal replaces and suspends an idle helper with a saved $binding-machine Squire install', async ({ signal, binding }) => {
    const startup = vi.spyOn(service, 'reconcileAll');
    const signals = vi.spyOn(service, 'reconcile');
    if (signal === 'connection') {
      off = service.subscribeToWakes(live);
      await startup.mock.results[0]!.value;
    }
    await seed(1, 'running', 'started');
    const currentMachine = '33333333-3333-4333-8333-333333333333';
    // Production retained an install under free-agent:<id> after registration
    // changed machine identity. Even a matching binding is undeliverable:
    // free agents never receive Squire installation work.
    await db.query(`INSERT INTO squire_machines(owner_id,machine_id,helper_agent_id,squire_work)
      VALUES($1,$2,$3,'{"install":true,"steps":[{"label":"Install on helper","status":"pending"},{"label":"Connect provider account","status":"pending"}]}')`,
      [OWNER, binding === 'old' ? `free-agent:${agentId(1)}` : currentMachine, agentId(1)]);
    await db.query(`UPDATE agents SET machine_id=$2 WHERE agent_id=$1`,
      [agentId(1), currentMachine]);
    expect(await new DaemonService(db, live).execute('getConnectorAssignments', { agentId: agentId(1) }, agentId(1)))
      .toEqual({ assignments: [] });

    if (signal !== 'connection') {
      await connect(1);
      off = service.subscribeToWakes(live);
      await startup.mock.results[0]!.value;
    }
    if (signal === 'release') {
      // Recreate image drift after startup, without reopening the connection.
      fleet.get('m1')!.config.image = 'old-release';
      fleet.get('m1')!.state = 'started';
      calls.length = 0;
      live.publish({ type: 'invalidate', roomId: '', reason: 'postgres:free_agents' });
      await startup.mock.results[1]!.value;
    } else if (signal === 'connection') {
      calls.length = 0;
      await connect(1);
      await Promise.all(signals.mock.results.map(result => result.value));
    }

    expect((await db.query('SELECT 1 FROM agent_commands')).rowCount).toBe(0);
    expect(fleet.get('m1')).toMatchObject({ state: 'suspended', config: { image: IMAGE } });
    expect(calls.filter(call => call.startsWith('POST'))).toEqual(['POST m1', 'POST m1/suspend']);
    expect((await db.query(`SELECT squire_work->>'install' install FROM squire_machines`)).rows)
      .toEqual([{ install: 'true' }]);
  });

  it.each(['pending', 'claimed', 'connector'] as const)('keeps %s work committed during image replacement running', async work => {
    await seed(1, 'running', 'started');
    await connect(1);
    beforeUpdate = () => work === 'connector' ? connector(1) : command(1, work);

    await service.reconcileAll();

    expect(fleet.get('m1')).toMatchObject({ state: 'started', config: { image: IMAGE } });
    expect(calls.filter(call => call.startsWith('POST'))).toEqual(['POST m1']);
  });

  it('visits all stored lifecycle values, preserves idle identities and defers image replacement for claimed work',async()=>{
    const states=['sleeping','waking','stopped','running','failed','destroyed','provisioning'];
    for(let n=1;n<=32;n++)await seed(n,states[n%states.length]);
    await seed(33,'provisioning','stopped',false,false);
    await command(32,'claimed');
    await service.reconcileAll();
    for(let n=1;n<=31;n++)expect(fleet.get(`m${n}`)?.config.image).toBe(IMAGE);
    expect(fleet.get('m32')?.config.image).not.toBe(IMAGE);
    expect((await db.query(`SELECT fly_machine_id FROM free_agents WHERE agent_id=$1`,[agentId(33)])).rows).toEqual([{fly_machine_id:null}]);
    expect(calls.filter(call=>call.includes('/start'))).toHaveLength(32);
    expect(fleet.get('m32')?.state).toBe('started');
    expect((await db.query(`SELECT 1 FROM agent_commands WHERE state='pending'`)).rowCount).toBe(0);
  });

  it('reports unknown observations after visiting the rest of the inventory',async()=>{
    await seed(1);await seed(2);failStart='m1';
    await expect(service.reconcileAll()).rejects.toThrow('observation unavailable for 1');
    expect(fleet.get('m2')?.config.image).toBe(IMAGE);
    expect(fleet.get('m2')?.state).toBe('started');
    expect(calls.filter(call=>call==='POST m1/start')).toHaveLength(1);
  });

  it('accounts for unmapped provider machines without mutating them',async()=>{
    await seed(1);fleet.set('m99',{state:'stopped',instance_id:'orphan',config:{image:IMAGE,env:{keep:'orphan'},rootfs:{persist:'always'}}});
    await service.reconcileAll();
    expect(logs.some(line=>line.includes('unmapped machine m99: preserved'))).toBe(true);
    expect(calls.every(call=>!call.includes('m99'))).toBe(true);
  });
});

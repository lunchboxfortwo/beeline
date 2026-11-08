import { migrateMembershipSubscriptions } from './agent-subscriptions.js';
import { STARTER_BANTER_TYPING_MS, StarterOnboardingService } from './starter-onboarding-run.js';
import { starterHello, postStarterGame } from './starter-onboarding.js';
import { postRepositoryOnboarding } from './repository-onboarding.js';
import { TokenAuth } from './auth.js';
import { DaemonService } from './daemon-service.js';
import { createECDH } from 'node:crypto';
import { getPublicKey } from '@beeline/nostr';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimAgentCommand, createAgentCommand, type CommandRow } from './agent-command.js';
import { claimAgentConnection, releaseAgentConnection } from './connection-presence.js';
import { migrate } from './database.js';
import type { FreeAgentMachines, FreeAgentMachineSpec } from './fly-machines.js';
import {
  addFreeAgentToWorkspace,
  currentFreeAgentInstructions,
  FREE_AGENT_TEAM_GUIDE,
  FREE_AGENT_BROWSER_GUIDE,
  FREE_AGENT_EXIT_NOTE,
  FREE_AGENT_TURN_GUIDE,
  FREE_AGENT_HELLO,
  FREE_AGENT_JOIN_GREETING,
  FreeAgentService,
  generateAgentKeypair,
  openSecrets,
  freeAgentConfigFromEnv,
  type FreeAgentConfig,
} from './free-agents.js';
import { PushDeliveryLoop } from './background.js';
import { resolveCurrentMemberMentions } from './message-mentions.js';
import { LiveHub } from './live.js';
import { agentMachineOfflineSql } from './machine-offline.js';
import { PhoneService } from './phone-service.js';
import { AuthStore, type TransactionalDatabase } from '@beeline/auth/store';
import type { GitHubOperations } from './github-operations.js';
import { ObjectService } from './object-service.js';
import { PgliteDatabase, MemoryObjectStorage, migratedDatabase } from './test-support.js';
import { recordSigninFunnelEvent, recordOnboardingEvent } from './signin-funnel.js';
import { dashboardPeriods } from './operator-dashboard-periods.js';

const sentryCaptures = vi.hoisted(() => [] as { error: unknown; tags: Record<string, string> | undefined }[]);
vi.mock('./sentry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sentry.js')>()),
  captureServerError: (error: unknown, tags?: Record<string, string>) => {
    sentryCaptures.push({ error, tags });
  },
}));

const OWNER = 'a'.repeat(64);
const FRIEND = 'b'.repeat(64);
const ORDINARY = 'c'.repeat(64);

const TEST_FREE_AGENT_CONFIG: FreeAgentConfig = {
  model: 'deepseek/deepseek-v4-flash',
  maxPerOwner: 3,
  dailyTokenCap: 1_000_000,
  firstDayTokenCap: 1_000_000,
  lifetimeTokenCap: 3_000_000,
  sealSecret: 'test-seal-secret',
  publicOrigin: 'https://server.test',
  image: 'registry.fly.io/beeline-free-agents:test',
  region: 'iad',
  cpus: 1,
  memoryMb: 1024,
};

/** Fly Machines stand-in: records every call and keeps each Machine's state. */
class FakeMachines implements FreeAgentMachines {
  readonly calls: string[] = [];
  readonly specs: FreeAgentMachineSpec[] = [];
  readonly states = new Map<string, string>();
  failSuspend = false;
  failDestroy = false;
  beforeCreate?: () => Promise<void>;
  beforeDestroy?: () => Promise<void>;
  #next = 0;

  async create(spec: FreeAgentMachineSpec) {
    await this.beforeCreate?.();
    const id = `m${++this.#next}`;
    this.calls.push(`create ${spec.agentId.slice(0, 4)}`);
    this.specs.push(spec);
    this.states.set(id, 'started');
    return { id };
  }
  async list() {
    return Promise.all([...this.states.keys()].map(id => this.read(id))).then(rows=>rows.filter(row=>row!==undefined));
  }
  async update(machine: import('./fly-machines.js').FreeAgentMachine,image:string) {
    this.specs[Number(machine.id.slice(1))-1]!.image=image;
    return (await this.read(machine.id))!;
  }
  async find(agentId: string) {
    const index = this.specs.findIndex((spec) => spec.agentId === agentId);
    const id = index >= 0 ? `m${index + 1}` : undefined;
    const state = id ? this.states.get(id) : undefined;
    return id && state && state !== 'destroyed' ? { id, state,config:{image:this.specs[index]!.image} } : undefined;
  }
  async start(id: string, image?: string) {
    const spec = this.specs[Number(id.slice(1)) - 1]!;
    const state = this.states.get(id);
    if (image && spec.image === image && state !== 'stopped' && state !== 'suspended') return;
    if (image) spec.image = image;
    this.calls.push(`start ${id}`);
    this.states.set(id, 'started');
  }
  reconnect(){return this;}
  async read(id:string){
    const state=this.states.get(id);return state && state!=='destroyed' ? {id,state,instance_id:id,config:{image:this.specs[Number(id.slice(1))-1]!.image}} : undefined;
  }
  async refresh(id:string,image:string){
    const machine=await this.read(id);if(!machine)return false;
    if(machine.config.image===image && machine.state!=='stopped')return false;
    await this.start(id);return true;
  }
  async suspend(id: string) {
    this.calls.push(`suspend ${id}`);
    if (this.failSuspend) throw new Error('suspend unavailable');
    this.states.set(id, 'suspended');
  }
  async stop(id: string) {
    this.calls.push(`stop ${id}`);
    this.states.set(id, 'stopped');
  }
  async destroy(id: string) {
    await this.beforeDestroy?.();
    this.calls.push(`destroy ${id}`);
    if (this.failDestroy) throw new Error('delete unavailable');
    this.states.set(id, 'destroyed');
  }
  async state(id: string) {
    const state = this.states.get(id);
    return state === 'destroyed' ? undefined : state;
  }
  async waitFor() {}
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('current starter instructions', () => {
  it('replaces retired hosted policy on an existing soul and keeps its persona', () => {
    const prior = 'Be curious.\n\nFor Grok/xAI old hosted sign-in guide.\n\nWhen the person picks "Make a welcome video and post it to my YouTube", use old tools.\n\nYou are on a team with another free starter agent. Old rule.';
    const current = currentFreeAgentInstructions(prior);
    expect(current).toContain('Be curious.');
    expect(current).toContain(FREE_AGENT_BROWSER_GUIDE);
    expect(current).toContain(FREE_AGENT_TEAM_GUIDE);
    expect(current).not.toMatch(/Trusty Squire|video_preview|welcome-video|old hosted|Old rule/);
    expect(currentFreeAgentInstructions(current)).toBe(current);
  });
  it('uses exactly the requested feedback instruction with no decay or extra directions', () => {
    expect(FREE_AGENT_TEAM_GUIDE).toBe('Try to include another agent, if available, to request feedback on your work as much as possible.');
  });
});

describe('free starter agents', () => {
  let db: PgliteDatabase;
  let live: LiveHub;
  let machines: FakeMachines;
  let freeAgents: FreeAgentService;
  let phone: PhoneService;
  let exchanges: string[];

  beforeEach(async () => {
    db = await migratedDatabase();
    live = new LiveHub();
    machines = new FakeMachines();
    sentryCaptures.length = 0;
    exchanges = [];
    freeAgents = new FreeAgentService(
      db,
      TEST_FREE_AGENT_CONFIG,
      machines,
      async (agentId) => {
        const token = `bde_${String(exchanges.length).padStart(43, '0')}`;
        exchanges.push(agentId);
        return { exchangeToken: token };
      },
      () => undefined,
    );
    phone = new PhoneService(db, 'https://server.test', undefined, undefined, live);
    phone.setFreeAgents(freeAgents);
    await db.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
        ($1,'human','Charles','lunchboxfortwo'),($2,'human','Friend','friend')`,
      [OWNER, FRIEND],
    );
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await settle();
    await db.close();
  });

  const finishWelcome = async (roomId: string, viewerId: string) => {
    await new StarterOnboardingService(db).enter(roomId, viewerId);
  };

  it('shows each banter agent typing 3.5 s, and keeps playback inside the 35 s reclaim window', () => {
    expect(STARTER_BANTER_TYPING_MS).toBe(3500);
    // 20 s generation deadline + three typed lines must finish before another server may reclaim playback.
    expect(20_000 + 3 * STARTER_BANTER_TYPING_MS).toBeLessThan(35_000);
  });

  it('reruns welcome in the calling Room and keeps every manual step out of signup counts', async () => {
    const workspace = await phone.execute('createWorkspace', { name: 'Manual welcome', timeZone: 'America/New_York' }, FRIEND);
    await finishWelcome(workspace.roomId!, FRIEND);
    const roomId = workspace.roomId!;
    const beebee = (await db.query<{ agent_id: string }>(`SELECT agent_id FROM free_agents WHERE workspace_id=$1 AND starter_role='beebee'`, [workspace.id])).rows[0]!.agent_id;
    const installId = '11111111-1111-4111-8111-111111111111', attemptId = '22222222-2222-4222-8222-222222222222';
    await recordSigninFunnelEvent(db, { event: 'signed_in', installId, attemptId, platform: 'android', version: 'test', environment: 'production', timestamp: new Date().toISOString() }, 'server', FRIEND);
    await db.query(`INSERT INTO signin_funnel_events(install_id,attempt_id,event,platform,version,source,occurred_at) VALUES($1,$2,'signup','android','test','server',now())`, [installId, attemptId]);
    // Run in another Room, proving the action does not silently target General.
    const other = await phone.execute('createRoom', { workspaceId: workspace.id, name: 'onboarding-test' }, FRIEND);
    await phone.execute('addRoomMember', { roomId: other.id, memberId: beebee }, FRIEND);
    const luna = (await db.query<{ agent_id: string }>(`SELECT agent_id FROM free_agents WHERE workspace_id=$1 AND starter_role='luna'`, [workspace.id])).rows[0]!.agent_id;
    await phone.execute('addRoomMember', { roomId: other.id, memberId: luna }, FRIEND);
    const source = 'e'.repeat(64);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'run onboarding')`, [source, other.id, FRIEND]);
    const command = (await createAgentCommand(db, { roomId: other.id, agentId: beebee, sourceMessageId: source, reason: 'human_tag' }))!;
    await claimAgentCommand(db, other.id, beebee, command.id, 'welcome-generation');
    const daemon = new DaemonService(db, live);
    daemon.setStarterOnboarding(new StarterOnboardingService(db));
    const replay = async () => {
      const before = (await db.query(`SELECT id FROM messages WHERE room_id=$1 AND card->>'starterOnboarding'='welcome'`, [other.id])).rowCount;
      expect(await daemon.execute('postStarterWelcome', { roomId: other.id, requestId: command.turn_request_id, generationId: 'welcome-generation' } as never, beebee)).toEqual({ status: 'started' });
      let choice: { messageId: string } | undefined;
      await vi.waitFor(async () => {
        const rows = (await db.query<{ id: string }>(`SELECT id FROM messages WHERE room_id=$1 AND card->>'starterOnboarding'='welcome' ORDER BY created_at DESC,id DESC`, [other.id])).rows;
        expect(rows.length).toBe(before + 1);
        choice = { messageId: rows[0]!.id };
      });
      return choice!;
    };
    const first = await replay();
    const welcome = await replay();
    expect((await db.query<{ time_zone: string }>(`SELECT time_zone FROM starter_onboarding_runs WHERE room_id=$1 ORDER BY created_at DESC LIMIT 1`, [other.id])).rows[0]?.time_zone).toBe('America/New_York');
    const view = (await phone.readRoom(other.id, FRIEND))!;
    expect(view.messages.find(message => message.id === first.messageId)?.text).toBe(starterHello('Friend'));
    expect(view.messages.find(message => message.id === welcome.messageId)?.choice).toBeUndefined();
    const card = (await db.query<{card:{onboardingManual:boolean}}>('SELECT card FROM messages WHERE id=$1',[welcome.messageId])).rows[0]!.card;
    expect(card.onboardingManual).toBe(true);
    expect((await phone.readRoom(roomId, FRIEND))!.messages.some(message => message.id === welcome.messageId)).toBe(false);
    await phone.execute('sendRoomMessage', { roomId: other.id, text: 'Try the task' }, FRIEND);
    const signup = (await db.query(`SELECT event FROM signin_funnel_events WHERE install_id=$1 ORDER BY event`, [installId])).rows;
    expect(signup).toEqual([{ event: 'signed_in' }, { event: 'signup' }]);
    const manual = (await db.query<{ event: string }>(`SELECT e.event FROM signin_funnel_events e JOIN signin_funnel_installs i USING(install_id) WHERE i.internal AND e.version='manual'`)).rows.map(row => row.event);
    expect(manual).toEqual(expect.arrayContaining(['welcome_shown', 'user_answered']));
    const periods = await dashboardPeriods(db, new Date().toISOString());
    const funnel = periods['24h'].onboardingFunnel!;
    expect('steps' in funnel && funnel.steps[0]!.count).toBe(0);
    await expect(daemon.execute('postStarterWelcome', { roomId: other.id, requestId: command.turn_request_id, generationId: 'wrong' } as never, beebee)).rejects.toThrow();
  });

  it('starts playback on the first Room read only for the onboarding person', async () => {
    const workspace = await phone.execute('createWorkspace', { name: 'First entry' }, OWNER);
    const onboarding = new StarterOnboardingService(db);
    const open = vi.spyOn(onboarding, 'open').mockImplementation(() => {});
    phone.setStarterOnboarding(onboarding);
    await phone.readRoom(workspace.roomId!, OWNER);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(workspace.roomId!, OWNER);
    open.mockClear();
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`, [workspace.id, workspace.roomId, FRIEND]);
    await phone.readRoom(workspace.roomId!, FRIEND);
    expect(open).not.toHaveBeenCalled();
    await finishWelcome(workspace.roomId!, OWNER);
    await phone.readRoom(workspace.roomId!, OWNER);
    expect(open).not.toHaveBeenCalled();
  });

  it('welcomes with one open question, no card, and waits for the person', async () => {
    const workspace = await phone.execute('createWorkspace', { name: 'Welcome' }, OWNER);
    await finishWelcome(workspace.roomId!, OWNER);
    await finishWelcome(workspace.roomId!, OWNER);
    const room = (await phone.readRoom(workspace.roomId!, OWNER))!;
    expect(room.messages.filter(message => message.text === starterHello('Charles'))).toHaveLength(1);
    expect(starterHello('Charles')).toMatch(/What should we work on\?$/);
    expect(starterHello('Charles')).not.toContain('Pitch us an idea');
    expect(room.messages.some(message => message.choice || message.attachments?.length)).toBe(false);
    expect((await db.query('SELECT 1 FROM agent_commands')).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM workspace_skills WHERE slug='welcome-video'")).rowCount).toBe(0);
    await phone.execute('sendRoomMessage', { roomId: workspace.roomId!, text: 'Plan a picnic' }, OWNER);
    expect((await db.query('SELECT 1 FROM agent_commands')).rowCount).toBe(1);
  });

  it('keeps tic-tac-toe available on request without a followup menu', async () => {
    const workspace = await phone.execute('createWorkspace', { name: 'Game' }, OWNER);
    await finishWelcome(workspace.roomId!, OWNER);
    const objects = new ObjectService(db, new MemoryObjectStorage().asStorage(), 'https://server.test');
    await db.transaction(tx => postStarterGame(tx, objects, workspace.roomId!, OWNER));
    const room = (await phone.readRoom(workspace.roomId!, OWNER))!;
    expect(room.messages.some(message => message.attachments?.some(file => file.mimeType === 'application/vnd.beeline.game+html'))).toBe(true);
    expect(room.messages.some(message => message.choice)).toBe(false);
  });

  it('keeps starter agent mentions on the ordinary handoff path without a forced review limit', async () => {
    const workspace = await phone.execute('createWorkspace', { name: 'Review' }, OWNER);
    await finishWelcome(workspace.roomId!, OWNER);
    await phone.execute('sendRoomMessage', { roomId: workspace.roomId!, text: 'Plan a picnic' }, OWNER);
    const root = (await db.query<CommandRow>(`SELECT * FROM agent_commands WHERE room_id=$1`, [workspace.roomId])).rows[0]!;
    const peer = (await db.query<{ agent_id: string }>(`SELECT agent_id FROM free_agents WHERE workspace_id=$1 AND starter_role='luna'`, [workspace.id])).rows[0]!.agent_id;
    let parent = root;
    for (const [index, target] of [peer, root.agent_id, peer].entries()) {
      const source = String(index + 1).repeat(64);
      await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Please check this answer')`, [source, workspace.roomId, parent.agent_id]);
      const next = await createAgentCommand(db, { roomId: workspace.roomId!, agentId: target, sourceMessageId: source, reason: 'agent_tag', parent });
      expect(next?.agent_depth).toBe(index + 1);
      parent = next!;
    }
  });

  it('counts the first answer to the open welcome exactly once', async () => {
    const installId = '11111111-1111-4111-8111-111111111111';
    const attemptId = '22222222-2222-4222-8222-222222222222';
    await recordSigninFunnelEvent(db, { event: 'signed_in', installId, attemptId, provider: 'google',
      platform: 'android', version: '0.2.22', environment: 'production', timestamp: new Date().toISOString() }, 'server', FRIEND);
    await db.query(`INSERT INTO signin_funnel_events(install_id,attempt_id,event,platform,version,source,occurred_at)
      VALUES($1,$2,'signup','android','0.2.22','server',now())`, [installId, attemptId]);
    const workspace = await phone.execute('createWorkspace', { name: 'Answer after welcome' }, FRIEND);
    await phone.execute('sendRoomMessage', { roomId: workspace.roomId!, text: 'Hello before the welcome' }, FRIEND);
    expect((await db.query("SELECT 1 FROM signin_funnel_events WHERE event='user_answered'")).rowCount).toBe(0);
    await finishWelcome(workspace.roomId!, FRIEND);
    await recordOnboardingEvent(db, FRIEND, 'welcome_shown');
    await phone.execute('sendRoomMessage', { roomId: workspace.roomId!, text: 'Here is my answer' }, FRIEND);
    const firstAnswer = (await db.query(`SELECT occurred_at FROM signin_funnel_events WHERE event='user_answered'`)).rows;
    await phone.execute('sendRoomMessage', { roomId: workspace.roomId!, text: 'And another answer' }, FRIEND);
    expect((await db.query(`SELECT occurred_at FROM signin_funnel_events WHERE event='user_answered'`)).rows).toEqual(firstAnswer);
    const periods = await dashboardPeriods(db, new Date().toISOString());
    const funnel = periods['24h'].onboardingFunnel!;
    expect('steps' in funnel && funnel.steps.find(step => step.key === 'user_answered')?.count).toBe(1);
  });

  it('records return milestones after the welcome, using the existing signup funnel', async () => {
    const installId = '11111111-1111-4111-8111-111111111111';
    const attemptId = '22222222-2222-4222-8222-222222222222';
    await recordSigninFunnelEvent(db, { event: 'signed_in', installId, attemptId, provider: 'google',
      platform: 'android', version: '0.2.22', environment: 'production', timestamp: new Date().toISOString() }, 'server', FRIEND);
    await db.query(`INSERT INTO signin_funnel_events(install_id,attempt_id,event,platform,version,source,occurred_at)
      VALUES($1,$2,'signup','android','0.2.22','server',now())`, [installId, attemptId]);
    const workspace = await phone.execute('createWorkspace', { name: 'Return' }, FRIEND);
    await finishWelcome(workspace.roomId!, FRIEND);
    await recordOnboardingEvent(db, FRIEND, 'welcome_shown');
    await phone.execute('sendRoomMessage', { roomId: workspace.roomId!, text: 'My first task' }, FRIEND);
    expect((await db.query(`SELECT 1 FROM signin_funnel_events WHERE event LIKE 'returned_%'`)).rowCount).toBe(0);
    await db.query(`UPDATE signin_funnel_events SET occurred_at=now()-interval '8 days' WHERE event='welcome_shown'`);
    await phone.execute('sendRoomMessage', { roomId: workspace.roomId!, text: 'I am back' }, FRIEND);
    expect((await db.query(`SELECT event FROM signin_funnel_events WHERE event LIKE 'returned_%' ORDER BY event`)).rows)
      .toEqual([{ event: 'returned_day_1' }, { event: 'returned_day_7' }]);
  });

  it('retains onboarding milestones when the transport releases a committed send before observation', async () => {
    const installId = '11111111-1111-4111-8111-111111111111';
    const attemptId = '22222222-2222-4222-8222-222222222222';
    await recordSigninFunnelEvent(db, { event: 'signed_in', installId, attemptId, provider: 'google',
      platform: 'android', version: '0.2.22', environment: 'production', timestamp: new Date().toISOString() }, 'server', FRIEND);
    await db.query(`INSERT INTO signin_funnel_events(install_id,attempt_id,event,platform,version,source,occurred_at)
      VALUES($1,$2,'signup','android','0.2.22','server',now())`, [installId, attemptId]);
    const workspace = await phone.execute('createWorkspace', { name: 'Tracked phone milestones' }, FRIEND);
    await finishWelcome(workspace.roomId!, FRIEND);
    await recordOnboardingEvent(db, FRIEND, 'welcome_shown');
    await db.query(`UPDATE signin_funnel_events SET occurred_at=now()-interval '8 days' WHERE event='welcome_shown'`);

    await phone.execute('sendRoomMessage', { roomId: workspace.roomId!, text: 'A committed transport send' }, FRIEND,
      undefined, undefined, true);
    await db.backgroundWork.drain();
    const events = (await db.query<{ event: string }>(`SELECT event FROM signin_funnel_events WHERE install_id=$1`, [installId]))
      .rows.map(row => row.event);
    for (const event of ['user_answered', 'task_question', 'returned_day_1', 'returned_day_7'])
      expect(events.filter(value => value === event)).toHaveLength(1);
  });

  // Lifecycle tests start after the owner's first actual request, not the server hello.
  const createWorkspace = async (name = 'Fresh', viewer = OWNER) => {
    const result = await phone.execute('createWorkspace', { name }, viewer) as { id: string; roomId: string };
    await finishWelcome(result.roomId!, viewer);
    const agent = (await db.query<{ agent_id: string }>(`SELECT f.agent_id FROM free_agents f JOIN identities i ON i.id=f.agent_id WHERE workspace_id=$1 ORDER BY i.name`, [result.id])).rows[0];
    if (agent) {
      await createAgentCommand(db, { roomId: result.roomId, agentId: agent.agent_id, sourceMessageId: null, reason: 'human_tag' });
      await freeAgents.reconcile(agent.agent_id);
    }
    return result;
  };

  const freeAgentOf = async (workspaceId: string) =>
    (
      await db.query<{ agent_id: string; state: string; fly_machine_id: string | null }>(
        `SELECT f.agent_id,f.state,f.fly_machine_id FROM free_agents f JOIN identities i ON i.id=f.agent_id WHERE workspace_id=$1 ORDER BY i.name`,
        [workspaceId],
      )
    ).rows[0]!;

  it('adds the repository guide to a Google-only runtime without feature configuration', async () => {
    const { id, roomId } = await phone.execute('createWorkspace', { name: 'Always on' }, OWNER) as { id:string;roomId:string };
    await finishWelcome(roomId!, OWNER);
    const agent = await freeAgentOf(id);
    const daemon = new DaemonService(db, live);
    await db.query(`UPDATE agents SET soul=jsonb_set(soul,'{instructions}','"Original soul"'::jsonb)
      WHERE agent_id=$1`, [agent.agent_id]);
    const configuration = await daemon.execute('getAgentConfiguration', { roomId }, agent.agent_id);
    expect(configuration.soul?.instructions).toContain('beeline:onboarding');
    expect(configuration.soul?.instructions).toContain(FREE_AGENT_TURN_GUIDE);
    const stored=(await db.query<{soul:{instructions:string}}>(`SELECT soul FROM agents WHERE agent_id=$1`,[agent.agent_id])).rows[0]!;
    expect(stored.soul.instructions).not.toContain('beeline:onboarding');
  });

  it('replaces old team guidance for both existing free agents, including legacy roles, without changing personal agents', async () => {
    const workspace = await phone.execute('createWorkspace', { name: 'Feedback guide' }, OWNER);
    const members = (await db.query<{agent_id:string;soul:{instructions:string}}>(`SELECT f.agent_id,a.soul
      FROM free_agents f JOIN agents a ON a.agent_id=f.agent_id WHERE f.workspace_id=$1`, [workspace.id])).rows;
    expect(members).toHaveLength(2);
    const daemon = new DaemonService(db, live);
    const old = 'Original persona.\n\nYou are on a team with another free starter agent. Ask on the first three substantive questions, then only when in doubt. One review round per answer.';
    for (const member of members) {
      expect(member.soul.instructions.split(FREE_AGENT_TEAM_GUIDE)).toHaveLength(2);
      await db.query(`UPDATE agents SET soul=jsonb_set(soul,'{instructions}',$2::jsonb) WHERE agent_id=$1`, [member.agent_id,JSON.stringify(old)]);
      const config = await daemon.execute('getAgentConfiguration', { roomId: workspace.roomId! }, member.agent_id);
      expect(config.soul?.instructions).toContain('Original persona.');
      expect(config.soul?.instructions.split(FREE_AGENT_TEAM_GUIDE)).toHaveLength(2);
      expect(config.soul?.instructions).not.toMatch(/first three substantive questions|only when in doubt|One review round/);
    }
    await db.query('UPDATE free_agents SET starter_role=NULL WHERE agent_id=$1',[members[0]!.agent_id]);
    const legacy = await daemon.execute('getAgentConfiguration', { roomId: workspace.roomId! }, members[0]!.agent_id);
    expect(legacy.soul?.instructions).toContain(FREE_AGENT_TEAM_GUIDE);
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Personal agent')`,[ORDINARY]);
    await db.query(`INSERT INTO agents(agent_id,owner_id,soul,harness) VALUES($1,$2,$3::jsonb,'pi')`,
      [ORDINARY,OWNER,JSON.stringify({name:'Personal agent',instructions:'Personal instructions.'})]);
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')`,
      [workspace.id,workspace.roomId,ORDINARY]);
    const personal = await daemon.execute('getAgentConfiguration', { roomId: workspace.roomId! }, ORDINARY);
    expect(personal.soul?.instructions).toBe('Personal instructions.');
  });

  it('onboarding-invite-1: an unlinked Room join does not presume coding intent', async () => {
    const { id, roomId } = await phone.execute('createWorkspace', { name: 'Existing unlinked workspace' }, OWNER) as { id: string; roomId: string };
    await finishWelcome(roomId!, OWNER);
    const agent = await freeAgentOf(id);
    const invite = await phone.execute('createInvite', { workspaceId: id }, OWNER);
    await phone.execute('redeemInvite', { token: invite.token }, FRIEND);
    expect((await phone.readRoom(roomId, FRIEND))?.messages.some(message => message.onboarding)).toBe(false);
    expect((await freeAgentOf(id)).agent_id).toBe(agent.agent_id);
  });

  it('onboarding-invite-1: an eligible invitee selects a starter from an existing Beebee without repository-management rights', async () => {
    const { id, roomId } = await phone.execute('createWorkspace', { name: 'Existing workspace' }, OWNER) as { id: string; roomId: string };
    await finishWelcome(roomId!, OWNER);
    const agent = await freeAgentOf(id);
    await db.query(`UPDATE rooms SET repository_name='tester/existing',repository_key='github:42',
      repository_remote='git://github.com/tester/existing',repository_resolution='repository' WHERE id=$1`, [roomId]);
    const github = { onboardingSignals: vi.fn(async () => ({ commits: [], failingChecks: [], issues: [], branches: [], files: [] })) } as unknown as GitHubOperations;
    phone = new PhoneService(db, 'https://server.test', github, undefined, live);
    await db.query(`UPDATE identities SET github_subject='296966200' WHERE id=$1`, [FRIEND]);
    const invite = await phone.execute('createInvite', { workspaceId: id }, OWNER);
    await phone.execute('redeemInvite', { token: invite.token }, FRIEND);
    expect((await phone.readRoom(roomId, FRIEND))?.messages.some(message => message.onboarding)).toBe(false);
    // A subsequent coding request can still offer the existing repository's starters.
    await postRepositoryOnboarding(db, github, { roomId, agentId: agent.agent_id, requesterId: FRIEND, kind: 'starters' });
    const joined = await phone.readRoom(roomId, FRIEND);
    const card = joined?.messages.find(message => message.onboarding?.requesterId === FRIEND)?.onboarding;
    expect(card).toMatchObject({ kind: 'starters', requesterId: FRIEND, repository: 'tester/existing', canLink: false });
    expect(card?.starters).toHaveLength(3);
    expect((await phone.readRoom(roomId, OWNER))?.messages.some(message => message.onboarding)).toBe(false);
    await expect(phone.execute('actOnRepositoryCard', { roomId, cardId: card!.id, action: 'link', repositoryId: 42 }, FRIEND)).rejects.toThrow();
    await phone.execute('actOnRepositoryCard', { roomId, cardId: card!.id, action: 'starter', starterId: 'readme' }, FRIEND);
    const command = (await db.query<{ id: string; turn_request_id: string }>(
      `SELECT c.id,c.turn_request_id FROM agent_commands c JOIN messages m ON m.id=c.root_source_message_id
       WHERE c.agent_id=$1 AND c.room_id=$2 AND m.author_id=$3 AND m.text LIKE '%Make the README useful%'`, [agent.agent_id, roomId, FRIEND])).rows[0]!;
    expect(command).toBeDefined();
    await claimAgentCommand(db, roomId, agent.agent_id, command.id, 'invite-generation');
    const daemon = new DaemonService(db, live);
    const context = { roomId, requestId: command.turn_request_id, generationId: 'invite-generation' };
    const configuration = await daemon.execute('getAgentConfiguration', context as never, agent.agent_id);
    expect(configuration.soul?.instructions).toContain('beeline:onboarding');
    expect(configuration.soul?.instructions).toContain(FREE_AGENT_TURN_GUIDE);
    expect(await daemon.execute('getRoomRepositoryState', context as never, agent.agent_id)).toMatchObject({ repositoryOnboarding: true });
    expect(await daemon.execute('postRepositoryOnboarding', { ...context, kind: 'repository' } as never, agent.agent_id))
      .toMatchObject({ requesterId: FRIEND, canLink: false });
    const ownerMessageId = 'd'.repeat(64);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Help with this project')`, [ownerMessageId, roomId, OWNER]);
    const ownerCommand = (await createAgentCommand(db, { roomId, agentId: agent.agent_id,
      sourceMessageId: ownerMessageId, reason: 'human_tag', turnRequestId: 'owner-request' }))!;
    await claimAgentCommand(db, roomId, agent.agent_id, ownerCommand.id, 'owner-generation');
    const ownerContext = { roomId, requestId: ownerCommand.turn_request_id, generationId: 'owner-generation' };
    expect((await daemon.execute('getAgentConfiguration', ownerContext as never, agent.agent_id)).soul?.instructions).toContain('beeline:onboarding');
    expect(await daemon.execute('getRoomRepositoryState', ownerContext as never, agent.agent_id)).toHaveProperty('repositoryOnboarding', true);
    expect(await daemon.execute('postRepositoryOnboarding', { ...ownerContext, kind: 'repository' } as never, agent.agent_id)).toMatchObject({ requesterId: OWNER, canLink: true });
    await db.query(`UPDATE messages SET card=jsonb_set(card,'{status}','"settled"')
      WHERE room_id=$1 AND card_type='repository-onboarding' AND card->>'requesterId'=$2`, [roomId, OWNER]);
    const repeated = await Promise.all(Array.from({ length: 3 }, () =>
      new DaemonService(db, live).execute('postRepositoryOnboarding', { ...ownerContext, kind: 'repository' } as never, agent.agent_id)));
    expect(new Set(repeated.map(card => card.id)).size).toBe(1);
    expect((await phone.readRoom(roomId, OWNER))?.messages.filter(message =>
      message.onboarding?.requesterId === OWNER && message.onboarding.status === 'open')).toHaveLength(1);
  });

  it('E1: Google onboarding posts a real handle and hello without a repository card', async () => {
    const auth = new TokenAuth(db, async () => { throw new Error('GitHub is not needed'); },
      () => new Date(), async () => ({ subject: 'google-new-owner', name: 'Alex Chen', email: 'alex.chen@gmail.com', audience: 'google-client' }));
    const google = await auth.exchangeGoogleOidc('verified-fixture-ticket');
    const workspace = await phone.execute('createWorkspace', { name: 'Google onboarding' }, google.identityId);
    await finishWelcome(workspace.roomId!, google.identityId);
    const beebee = await freeAgentOf(workspace.id);
    const hello = (await db.query<{ text: string }>(
      'SELECT text FROM messages WHERE room_id=$1 AND author_id=$2 AND card_type IS NULL',
      [workspace.roomId, beebee.agent_id],
    )).rows;
    expect(hello).toHaveLength(1);
    expect(hello[0]!.text).toContain("Hi Alex, I'm Beebee and that's Luna.");
    expect(hello[0]!.text).not.toContain(google.identityId);
    const room = await phone.readRoom(workspace.roomId!, google.identityId);
    expect(room?.room.name).toBe('general');
    expect(room?.messages.some(message => message.onboarding)).toBe(false);
    expect((await db.query('SELECT github_subject FROM identities WHERE id=$1', [google.identityId])).rows[0]?.github_subject).toBeNull();
  });

  it('R-DELETE-NEW-USER: deletes a new account with its starter pair, onboarding run and turn traces, and deletes their Machines', async () => {
    await new AuthStore(db as unknown as TransactionalDatabase).migrate();
    const { id, roomId } = await phone.execute('createWorkspace', { name: 'Fresh' }, OWNER) as { id: string; roomId: string };
    await finishWelcome(roomId, OWNER);
    const team = (await db.query<{ agent_id: string }>(
      `SELECT agent_id FROM free_agents WHERE workspace_id=$1 ORDER BY starter_role`, [id],
    )).rows.map((row) => row.agent_id);
    expect(team).toHaveLength(2);
    expect((await db.query(`SELECT 1 FROM starter_onboarding_runs WHERE user_id=$1`, [OWNER])).rowCount).toBe(1);
    // Beebee has done work: a running Machine and a stored turn trace.
    await createAgentCommand(db, { roomId, agentId: team[0]!, sourceMessageId: null, reason: 'human_tag' });
    await freeAgents.reconcile(team[0]!);
    await settle();
    expect((await freeAgentOf(id)).fly_machine_id).toBe('m1');
    for (const agentId of team)
      await db.query(
        `INSERT INTO agent_turn_traces(room_id,request_id,agent_id,outcome,trace) VALUES($1,'req-1',$2,'replied','{}'::jsonb)`,
        [roomId, agentId],
      );

    await phone.execute('deleteAccount', {}, OWNER);

    for (const [table, column] of [
      ['identities', 'id'], ['free_agents', 'agent_id'], ['agent_turn_traces', 'agent_id'],
      ['starter_onboarding_runs', 'beebee_id'],
    ] as const)
      expect((await db.query(`SELECT 1 FROM ${table} WHERE ${column}=ANY($1)`, [[OWNER, ...team]])).rowCount, table).toBe(0);
    expect(machines.calls).toContain('destroy m1');
    expect(machines.states.get('m1')).toBe('destroyed');
  });

  it('keeps the Beebee name and de-duplicates its handle against existing members', async () => {
    await phone.execute('updatePersonProfile',{handle:'beebee'},OWNER);
    const { id } = await createWorkspace();
    const agent = await freeAgentOf(id);
    const identity = (await db.query<{ name: string; handle: string }>(
      `SELECT name,handle FROM identities WHERE id=$1`, [agent.agent_id],
    )).rows[0];
    expect(identity).toEqual({ name: 'Beebee', handle: 'beebee_2' });
    expect((await db.query<{ text: string }>(`SELECT text FROM messages WHERE author_id=$1 AND card_type IS NULL`, [agent.agent_id])).rows[0]!.text).toBe(starterHello('Charles'));
  });

  it('creates no duplicate team on a retried create, and admits only complete teams under the owner limit', async () => {
    const workspaceId = '33333333-3333-4333-8333-333333333333';
    await phone.execute('createWorkspace', { workspaceId, name: 'Once' }, OWNER);
    await phone.execute('createWorkspace', { workspaceId, name: 'Once' }, OWNER);
    expect(
      (await db.query(`SELECT 1 FROM free_agents WHERE workspace_id=$1`, [workspaceId])).rowCount,
    ).toBe(2);
    await createWorkspace('Two');
    await createWorkspace('Three');
    const { id } = await createWorkspace('Four');
    expect((await db.query(`SELECT 1 FROM free_agents WHERE workspace_id=$1`, [id])).rowCount).toBe(0);
    const notice = (await db.query<{ text: string }>(`SELECT text FROM messages message JOIN rooms room ON room.id=message.room_id
      WHERE room.workspace_id=$1 AND message.presentation='system'`, [id])).rows;
    expect(notice.some(line => line.text.includes('Your starter agents are already in') &&
      line.text.includes('Once') && line.text.includes('free-agent limit'))).toBe(true);
    expect(
      (await db.query(`SELECT 1 FROM free_agents WHERE owner_id=$1`, [OWNER])).rowCount,
    ).toBe(2);
  });

  it('seals keys that derive the agent identity, and bootstraps the Machine once per grant', async () => {
    const { id } = await createWorkspace();
    await settle();
    const agent = await freeAgentOf(id);
    const sealed = (
      await db.query<{ sealed_keys: string }>(`SELECT sealed_keys FROM free_agents WHERE agent_id=$1`, [
        agent.agent_id,
      ])
    ).rows[0]!.sealed_keys;
    expect(sealed).not.toContain(agent.agent_id);
    const keys = openSecrets<{ agent: string; body: string }>('test-seal-secret', sealed);
    expect(getPublicKey(Buffer.from(keys.agent, 'hex'))).toBe(agent.agent_id);

    expect(await freeAgents.bootstrap('bfb_wrong')).toBeUndefined();
    const token = machines.specs[0]!.env.BEELINE_FREE_AGENT_BOOTSTRAP!;
    const grant = (await freeAgents.bootstrap(token))!;
    expect(grant).toMatchObject({
      agentId: agent.agent_id,
      agentSecretKey: keys.agent,
      harness: 'pi',
      model: 'beeline/deepseek/deepseek-v4-flash',
      upstreamModel: 'deepseek/deepseek-v4-flash',
      workspaceId: id,
      pairedBy: OWNER,
      monolithBaseUrl: 'https://server.test',
      modelBaseUrl: 'https://server.test/v1/free-agents/model',
        });
    expect(grant.modelToken).toMatch(/^bfm_/);
    expect(exchanges).toEqual([agent.agent_id]);
    // A retried first boot gets a fresh exchange and model token; the old model token dies.
    const retry = (await freeAgents.bootstrap(token))!;
    expect(retry.modelToken).not.toBe(grant.modelToken);
    expect(exchanges).toHaveLength(2);
  });

  it('refuses Squire pairing and cards on a free agent without starting browser work', async () => {
    const { id, roomId } = await createWorkspace();
    await settle();
    const agent = await freeAgentOf(id);
    await expect(phone.execute('pairConnector', { helperAgentId: agent.agent_id, connectorType: 'trusty-squire' }, OWNER))
      .rejects.toThrow('Free agents use Lightpanda');
    const daemon = new DaemonService(db, live);
    await expect(daemon.execute('offerConnector', { roomId, connectorType: 'trusty-squire', reason: 'Sign in' }, agent.agent_id))
      .rejects.toThrow();
    expect((await db.query('SELECT 1 FROM connector_offers')).rowCount).toBe(0);
  });

  it.each(['tailscale'] as const)('R-SQUIRE-SLEEP: %s assignment wakes immediately and holds idle sleep', async (connectorType) => {
    const { id } = await createWorkspace();
    await settle();
    const agent = await freeAgentOf(id);
    await db.query(`DELETE FROM agent_commands WHERE agent_id=$1`, [agent.agent_id]);
    await db.query(`UPDATE free_agents SET state='sleeping' WHERE agent_id=$1`, [agent.agent_id]);
    machines.states.set(agent.fly_machine_id!, 'suspended');
    await phone.execute('pairConnector', { helperAgentId: agent.agent_id, connectorType }, OWNER);
    machines.calls.length = 0;
    const off = freeAgents.subscribeToWakes(live);
    try {
      live.publish({ type: 'invalidate', roomId: '', reason: 'connector-assignment', targetAgentId: agent.agent_id });
      await vi.waitFor(() => expect(machines.calls).toEqual([`start ${agent.fly_machine_id}`]));
      await freeAgents.reconcile(agent.agent_id);
    } finally { off(); }
  });

  it('R-SQUIRE-SLEEP: unrelated connector notifications do not provision an unused free agent', async () => {
    const workspace = await phone.execute('createWorkspace', { name: 'Unused' }, OWNER);
    const agent = await freeAgentOf(workspace.id);
    const off = freeAgents.subscribeToWakes(live);
    try {
      live.publish({ type: 'invalidate', roomId: '', reason: 'connector-assignment', targetAgentId: agent.agent_id });
      await settle();
      expect(machines.calls).toEqual([]);
    } finally { off(); }
  });

  it('adds one free agent to an existing Workspace in its #general, owned by its owner', async () => {
    const workspaceId = '44444444-4444-4444-8444-444444444444';
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Old')`, [workspaceId]);
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member')`,
      [workspaceId, OWNER, FRIEND],
    );
    const lounge = '55555555-5555-4555-8555-555555555555';
    const general = '66666666-6666-4666-8666-666666666666';
    await db.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name,visibility,created_at) VALUES
        ($1,$3,$4,'lounge','public',now()-interval '2 days'),($2,$3,$4,'general','public',now()-interval '1 day')`,
      [lounge, general, workspaceId, OWNER],
    );
    const additions = await Promise.all([
      addFreeAgentToWorkspace(db, freeAgents, workspaceId),
      addFreeAgentToWorkspace(db, freeAgents, workspaceId),
    ]);
    expect(additions.filter(Boolean)).toHaveLength(1);
    const agentId = additions.find(Boolean);
    expect(agentId).toBeTruthy();
    expect(machines.calls).toEqual([]);
    const hello = (await db.query<{ text: string }>(`SELECT text FROM messages WHERE author_id=$1 AND card_type IS NULL`, [agentId])).rows;
    expect(hello).toEqual([{ text: FREE_AGENT_HELLO.replace('<owner>', 'lunchboxfortwo').replace('<handle>', 'beebee') }]);
    expect(machines.calls).toEqual([]);
    expect(
      (await db.query(`SELECT owner_id FROM free_agents WHERE agent_id=$1`, [agentId])).rows,
    ).toEqual([{ owner_id: OWNER }]);
    expect(
      (
        await db.query(`SELECT room_id FROM memberships WHERE identity_id=$1 AND room_id IS NOT NULL`, [agentId])
      ).rows,
    ).toEqual([{ room_id: general }]);
    expect(await addFreeAgentToWorkspace(db, freeAgents, workspaceId)).toBeUndefined();
    expect((await db.query(`SELECT 1 FROM messages WHERE author_id=$1 AND card_type IS NULL`, [agentId])).rowCount).toBe(1);
  });

  it('hears #general joins and leaves from creation', async () => {
    const { id, roomId } = await createWorkspace();
    await settle();
    const agent = await freeAgentOf(id);
    expect(
      (
        await db.query(`SELECT event_subscriptions FROM room_access WHERE identity_id=$1 AND room_id=$2`, [
          agent.agent_id,
          roomId,
        ])
      ).rows,
    ).toEqual([{ event_subscriptions: ['joined', 'left'] }]);
    const wakes = async () =>
      (
        await db.query<{ text: string }>(
          `SELECT source.text FROM agent_commands command JOIN messages source ON source.id=command.source_message_id
           WHERE command.agent_id=$1 AND command.reason='subscribed_event' ORDER BY command.created_at`,
          [agent.agent_id],
        )
      ).rows.map((row) => row.text);

    // A person joins the Workspace: one joined event in #general wakes the free agent.
    await phone.execute('addWorkspaceMember', { workspaceId: id, memberId: FRIEND, role: 'member' }, OWNER);
    expect(await wakes()).toEqual(['@friend joined · invited by @lunchboxfortwo']);

    // Leave producers use the same event dispatch as joins, before any sweep.
    await phone.execute('leaveRoom', { roomId }, FRIEND);
    expect((await wakes()).at(-1)).toBe('@friend left');
    // Each leave is one wake, never repeated.
    expect(await wakes()).toHaveLength(2);
    // A removal by an admin is a leave too.
    await phone.execute('addRoomMember', { roomId, memberIds: [FRIEND] }, OWNER);
    await phone.execute('removeRoomMember', { roomId, memberId: FRIEND }, OWNER);
    expect((await wakes()).at(-1)).toBe('@lunchboxfortwo removed @friend');
    expect(await wakes()).toHaveLength(4);
    // A recent unkinded fact from the preceding image retains its owed wake at upgrade.
    await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,system_event)
      VALUES('legacy-leave',$1,$2,'Legacy leave','system','member-left',$3::jsonb,'{"verb":"left"}')`,[roomId,FRIEND,JSON.stringify({identityId:FRIEND})]);
    await migrateMembershipSubscriptions(db);
    await migrateMembershipSubscriptions(db);
    expect((await wakes()).at(-1)).toBe('Legacy leave');
    expect(await wakes()).toHaveLength(5);
  });

  it('carries the owner\'s exact join greeting and the exit note in the free agent\'s instructions', async () => {
    const { id } = await createWorkspace();
    await settle();
    const agent = await freeAgentOf(id);
    const soul = (
      await db.query<{ soul: { instructions: string } }>(`SELECT soul FROM agents WHERE agent_id=$1`, [
        agent.agent_id,
      ])
    ).rows[0]!.soul.instructions;
    expect(FREE_AGENT_JOIN_GREETING).toBe(
      "what up boss? I'm a pro bono agent for beeline. I can help you set up this workspace, invite other humans and agents, or whatever else you might need",
    );
    expect(soul).toContain(FREE_AGENT_JOIN_GREETING);
    expect(soul).toContain(FREE_AGENT_EXIT_NOTE);
    expect(soul).not.toContain('When you first join, greet');
    expect(soul).toContain('The server already posts your first hello');
    expect(soul).toContain('Never greet an agent.');
  });

  it.each(['owner', 'admin'])('allows a Workspace %s to remove another person\'s Beebee', async role => {
    const { id } = await createWorkspace();
    await settle();
    const agent = await freeAgentOf(id);
    await phone.execute('addWorkspaceMember', { workspaceId: id, memberId: FRIEND, role }, OWNER);
    await phone.execute('removeAgent', { workspaceId: id, agentId: agent.agent_id }, FRIEND);
    await settle();
    expect(machines.states.get('m1')).toBe('destroyed');
    expect((await db.query(`SELECT model_token_hash,removed_at FROM free_agents WHERE agent_id=$1`, [agent.agent_id])).rows[0])
      .toMatchObject({ model_token_hash: null, removed_at: expect.any(Date) });
  });

  it('retires a free agent even when it is removed from another Workspace it joined', async () => {
    const { id } = await createWorkspace();
    await settle();
    const agent = await freeAgentOf(id);
    const other = '77777777-7777-4777-8777-777777777777';
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Other')`, [other]);
    await db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner'),($1,$3,'member')`, [other, FRIEND, agent.agent_id]);
    await phone.execute('removeAgent', { workspaceId: other, agentId: agent.agent_id }, FRIEND);
    await settle();
    expect(machines.states.get('m1')).toBe('destroyed');
    await freeAgents.reconcile(agent.agent_id);expect(machines.states.get('m1')).toBe('destroyed');
    expect(await addFreeAgentToWorkspace(db, freeAgents, id)).toBeUndefined();
  });

  it('generates keys in the helper identity format', () => {
    const pair = generateAgentKeypair();
    expect(pair.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(getPublicKey(Buffer.from(pair.secretKey, 'hex'))).toBe(pair.publicKey);
    expect(createECDH('secp256k1')).toBeTruthy();
  });
});

it('defaults free agents to the October V4.1 Flash update and preserves an explicit model override', () => {
  const env = { BEELINE_FREE_AGENT_SEAL_KEY: 'seal', FLY_FREE_AGENT_IMAGE: 'image' };
  expect(freeAgentConfigFromEnv(env, 'https://server.test')?.model).toBe('deepseek/deepseek-v4.1-flash-1017');
  expect(freeAgentConfigFromEnv({ ...env, BEELINE_FREE_AGENT_MODEL: 'custom/model' }, 'https://server.test')?.model).toBe('custom/model');
});

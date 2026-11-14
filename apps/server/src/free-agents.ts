import { AGENT_INVITATION_PROMPT, BEELINE_PRODUCT_GUIDE } from '@beeline/api-contract/agent-invitation-guide';
import { notifyLive } from './postgres-live.js';
import {FREE_AGENT_CREATION_SCHEMA,reserveStarterAgents,refundStarterAgent} from './free-agent-creation.js';
import { FREE_AGENT_ACCOUNTING_SCHEMA } from './free-agent-accounting.js';
import { setRoomEventSubscriptions } from './agent-subscriptions.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { createCipheriv, createDecipheriv, createECDH, createHash, randomBytes, randomUUID } from 'node:crypto';
import { assignSeededAgentIdentity, resolveFace, agentHandleFromName } from '@beeline/api-contract/phone';
import { createAgentCommand } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import type { FreeAgentMachines } from './fly-machines.js';
import { FlyApiError, sameMachineImage } from './fly-machines.js';
import type { LiveHub } from './live.js';
import { freeAgentDailyTokenCapFromEnv, freeAgentFirstDayTokenCapFromEnv, freeAgentLimitsFromEnv, type FreeAgentLimits } from './free-agent-limits.js';
import { createInvitedWorkspaceMembership, joinRooms } from './membership-join.js';
import { createStarterOnboardingRun } from './starter-onboarding-run.js';

/**
 * Free starter agents: every new Workspace gets one agent, owned by its
 * creator, that runs on its own small Fly Machine. Committed work and
 * authenticated helper connections drive server-owned acquisition and suspension. The server keeps
 * the model key and the Fly token; the Machine holds only its own daemon
 * token and a revocable model token for the proxy in
 * `free-agent-model-proxy.ts`.
 */
export const FREE_AGENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS free_agents (
  agent_id text PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES identities(id),
  state text NOT NULL DEFAULT 'provisioning'
    CHECK (state IN ('provisioning','waking','running','sleeping','stopped','failed','destroyed')),
  fly_machine_id text,
  removed_at timestamptz,
  removal_cleaned_at timestamptz,
  sealed_keys text NOT NULL,
  bootstrap_hash text,
  model_token_hash text,
  wake_requested_at timestamptz,
  provision_started_at timestamptz,
  provision_attempts integer NOT NULL DEFAULT 0,
  provision_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE free_agents ADD COLUMN IF NOT EXISTS removed_at timestamptz;
ALTER TABLE free_agents ADD COLUMN IF NOT EXISTS removal_cleaned_at timestamptz;
ALTER TABLE free_agents ADD COLUMN IF NOT EXISTS runtime_operation_id text;
ALTER TABLE free_agents ADD COLUMN IF NOT EXISTS runtime_owner text;
ALTER TABLE free_agents ADD COLUMN IF NOT EXISTS runtime_phase jsonb;
ALTER TABLE free_agents ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE free_agents ADD COLUMN IF NOT EXISTS starter_role text;
DROP TRIGGER IF EXISTS defer_allowance_wake ON agent_commands;
DROP FUNCTION IF EXISTS defer_allowance_wake();
-- Inert for the previous server during this rolling release; drop next release.
ALTER TABLE free_agents ADD COLUMN IF NOT EXISTS allowance_paused_until timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS free_agents_bootstrap_hash ON free_agents(bootstrap_hash)
  WHERE bootstrap_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS free_agents_model_token_hash ON free_agents(model_token_hash)
  WHERE model_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS free_agents_owner ON free_agents(owner_id);
CREATE TABLE IF NOT EXISTS free_agent_usage (
  owner_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  day date NOT NULL,
  tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, day)
);
ALTER TABLE free_agent_usage ADD COLUMN IF NOT EXISTS reservation_credit bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS free_agent_budget (
  day date PRIMARY KEY,
  usd numeric NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS free_agent_call_rate (
  owner_id text PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  minute bigint NOT NULL,
  calls integer NOT NULL
);
CREATE TABLE IF NOT EXISTS free_agent_events (
  id bigserial PRIMARY KEY,
  agent_id text NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  kind text NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  detail jsonb
);
CREATE INDEX IF NOT EXISTS free_agent_events_agent ON free_agent_events(agent_id, at);
-- Retain the old columns and capture trigger through the rollback overlap.
-- Current runtime readers and writers never consume lifecycle/phase values.
${FREE_AGENT_ACCOUNTING_SCHEMA}
${FREE_AGENT_CREATION_SCHEMA}
`;

export const FREE_AGENT_HARNESS = 'pi';

export interface FreeAgentConfig {
  limits?: FreeAgentLimits;
  /** Upstream OpenRouter model every proxied request is pinned to. */
  model: string;
  lunaModel?: string;
  /** Free agents one person may own; later Workspaces get none. */
  maxPerOwner: number;
  dailyTokenCap: number;
  /** Larger allowance during an owner's first 24 hours; always at least `dailyTokenCap`. */
  firstDayTokenCap: number;
  /** Lifetime allowance per owner; 0 means none (the default). */
  lifetimeTokenCap: number;
  /** Key that seals the agent's identity keys at rest. */
  sealSecret: string;
  /** The server's public origin, as the Machine reaches it. */
  publicOrigin: string;
  image: string;
  region: string;
  cpus: number;
  memoryMb: number;
}

export function freeAgentConfigFromEnv(
  env: NodeJS.ProcessEnv,
  publicOrigin: string,
): FreeAgentConfig | undefined {
  const sealSecret = env.BEELINE_FREE_AGENT_SEAL_KEY;
  const image = env.FLY_FREE_AGENT_IMAGE;
  if (!sealSecret || !image) return undefined;
  const number = (name: string, fallback: number) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    limits: freeAgentLimitsFromEnv(env),
    model: env.BEELINE_FREE_AGENT_MODEL || 'deepseek/deepseek-v4.1-flash-1017',
    lunaModel: env.BEELINE_FREE_AGENT_LUNA_MODEL || 'openai/gpt-6-luna',
    maxPerOwner: number('BEELINE_FREE_AGENT_MAX_PER_OWNER', 3),
    dailyTokenCap: freeAgentDailyTokenCapFromEnv(env),
    firstDayTokenCap: freeAgentFirstDayTokenCapFromEnv(env),
    lifetimeTokenCap: number('BEELINE_FREE_AGENT_LIFETIME_TOKENS', 0),
    sealSecret,
    publicOrigin: env.BEELINE_FREE_AGENT_SERVER_ORIGIN || publicOrigin,
    image,
    region: env.FLY_FREE_AGENT_REGION || 'iad',
    cpus: number('FLY_FREE_AGENT_CPUS', 1),
    memoryMb: number('FLY_FREE_AGENT_MEMORY_MB', 2048),
  };
}

/** The model id the helper selects in OpenCode: its `beeline` provider is our proxy. */
export function freeAgentHarnessModel(config: Pick<FreeAgentConfig, 'model'>): string {
  return `beeline/${config.model}`;
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function opaque(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

function sealKey(secret: string): Buffer {
  return createHash('sha256').update(`beeline-free-agent:${secret}`).digest();
}

export function sealSecrets(secret: string, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function openSecrets<T>(secret: string, sealed: string): T {
  const bytes = Buffer.from(sealed, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', sealKey(secret), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
  ) as T;
}

/**
 * A secp256k1 key pair in the helper's identity format: the 32-byte secret in
 * hex and the BIP-340 x-only public key, which is the X coordinate of the
 * compressed point.
 */
export function generateAgentKeypair(): { secretKey: string; publicKey: string } {
  for (;;) {
    const ecdh = createECDH('secp256k1');
    ecdh.generateKeys();
    const secret = ecdh.getPrivateKey();
    if (secret.length !== 32) continue;
    return {
      secretKey: secret.toString('hex'),
      publicKey: ecdh.getPublicKey(undefined, 'compressed').subarray(1).toString('hex'),
    };
  }
}

/** The owner's exact join greeting (message d97de435…), after the joiner's @handle. */
export const FREE_AGENT_JOIN_GREETING =
  "what up boss? I'm a pro bono agent for beeline. I can help you set up this workspace, invite other humans and agents, or whatever else you might need";

/** Owner-approved backfill greeting (approval relayed by Ruby, ae9a4279). */
export const LUNA_BACKFILL_HELLO =
  "Hi {name}, I'm Luna. I just joined your team. Beebee and I run on different AI models, so we can check each other's work. What should we do first?";
export const LUNA_BACKFILL_HELLO_APPROVED = true;

export const FREE_AGENT_HELLO =
  `@<owner> Hi, I'm Beebee, your free agent. I run on my own small cloud computer, so I can research, write, draft, build things and run code for you.

Three things to know:
- **Talk to me here.** Tag @beebee, or just type while I'm the only agent in this Room.
- **Big jobs get a corner.** That's where I plan, do and check the work, then bring you one thing to approve. Tap it to follow along.
- **Connect once, use everywhere.** Link your apps in Connectors and every agent here can use them. You can also add your own agents, like Claude Code or Codex, from Members.

What are you working on? Tell me, and I'll take the first step with you. If you'd rather not have me here, remove me from Members.`;

/**
 * The exit note. Both claims hold: leaving or removal keeps the member's
 * messages, and a Workspace admin can add them back (`addRoomMember`,
 * `addWorkspaceMember`, invite links).
 */
export const FREE_AGENT_EXIT_NOTE =
  '{name} left. Their messages stay here, and an admin can invite them back anytime.';

/** Membership events every free agent hears in #general from creation. */
export const FREE_AGENT_EVENT_SUBSCRIPTIONS = ['joined', 'left'] as const;

export const FREE_AGENT_CONNECT_GUIDE = `When asked to add an agent, help one step at a time and wait for each result. Ask which device, assistant and plan they have when needed to select the supported steps. Do not require a computer for a supported chat-app connector. Never create, retrieve, request, repeat or post a pairing code in a Room; use redacted errors. Confirm a tagged reply before claiming setup complete.`;

export const FREE_AGENT_APP_CONNECT_GUIDE = AGENT_INVITATION_PROMPT;

export const FREE_AGENT_REPOSITORY_GUIDE = `Post the repository card only when the person asks for coding work on a codebase (writing, fixing or reviewing code in a repo), or asks to connect GitHub or a repository. For non-coding requests, never suggest linking a repository; do the requested research, writing, drafting or other work directly. For example, "help me write a cold email" needs no repository card; "fix the login bug in my app" needs the repository card if this Room has no repository. On those coding or connection requests, call app_tool(app:"beeline:onboarding", tool:"repository", args:{}). For other repository work, discover the repository and starters tools with app_tool(app:"beeline:onboarding"). If the card fails, explain the actual reason and the concrete next step to connect the repository. For coding work when a Room has no repository, post its repository card instead of sending anyone to Settings or a CLI. When a person wants to switch repositories, post the same card. After linking, offer the starters card, grounded in recent commits, CI and open issues. A tapped starter is an instruction to start that task now: open a repository corner with a complete brief using their selection as approval, do the work, and use the normal checks, independent review and merge path.`;

export const FREE_AGENT_TURN_GUIDE = `Before long work, call read(facet:"usage") to check your remaining allowance. If the job will not fit, deliver a smaller useful version or explain the limit up front. End every turn with the deliverable or a clear status explaining what is finished, what stopped, and the next step. Never end on a promise of more work: once your turn ends, no work continues until another message wakes you.`;

export const FREE_AGENT_TEAM_GUIDE = `Try to include another agent, if available, to request feedback on your work as much as possible.`;

export const FREE_AGENT_BROWSER_GUIDE = `Use agent-browser with the installed Lightpanda engine for every browser task. Before first use, run agent-browser skills get core. Open with agent-browser open <url>, read with agent-browser snapshot, and close with agent-browser close when finished. Do not install another browser or use a remote browser. A bot check, sign-in or signup blocks this browser: stop immediately, explain the actual block plainly, and suggest the person opens the page themselves or connects their own agent. Never retry a blocked page, bypass the block, or claim success without reading the result. Ask what the person wants to work on without offering a menu. When they request tic-tac-toe, call app_tool(app:"beeline:onboarding",tool:"game",args:{}).`;

/** Retain the agent's persona while replacing release-owned hosted policy on every read. */
export function currentFreeAgentInstructions(instructions: string): string {
  const retained = instructions.split(/\n\n/u).filter(paragraph =>
    paragraph !== FREE_AGENT_TEAM_GUIDE && paragraph !== AGENT_INVITATION_PROMPT && paragraph !== BEELINE_PRODUCT_GUIDE &&
    !/^(?:For Grok\/xAI|Offer help bringing their own agent|When they accept, guide them|When asked to add an agent|When the person picks "Make a welcome video|You are on a team with another free starter agent|Use agent-browser with)/u.test(paragraph));
  return [...retained, BEELINE_PRODUCT_GUIDE, FREE_AGENT_CONNECT_GUIDE, FREE_AGENT_APP_CONNECT_GUIDE, FREE_AGENT_BROWSER_GUIDE, FREE_AGENT_TEAM_GUIDE].join('\n\n');
}

export function freeAgentInstructions(seededSoul: string, name: string, config: FreeAgentConfig): string {
  return `${seededSoul}

You are ${name}, the free starter agent of this Beeline Workspace. Beeline gave you to the person who created it so they can try real work right away, without connecting their own agent first.

You run on your own small Linux cloud computer (${config.cpus} shared CPU, ${config.memoryMb} MB memory). It sleeps after a minute without work and wakes when someone writes to you, so a first reply after a pause can take a few seconds. Files you create in your home folder stay there between wakes. Never use the person's own computer; you cannot reach it.

Do real work when asked: write and edit files, run commands, install tools, research, draft and explain. Keep replies warm, short and concrete.

The server already posts your first hello in #general. Do not repeat it.

When people join #general (a "joined" line), always reply, with nothing else, exactly: their @handles, then a space, then this sentence:
${FREE_AGENT_JOIN_GREETING}
If several people joined since your last greeting, tag them all in that one message. Never greet an agent.

When a member leaves #general or is removed (a "left" or "removed" line), always reply with exactly one message and nothing else, putting their display name (not an @handle) in place of {name}:
${FREE_AGENT_EXIT_NOTE}
If several members left since your last note, name them all in that one note.
Leaving the Workspace itself is silent in Beeline; you only hear about leaves and removals in #general.

You have a free daily allowance of model tokens. If it runs out, say so plainly and tell them they can connect their own agent from the Members page to keep going.

${BEELINE_PRODUCT_GUIDE}

${FREE_AGENT_TURN_GUIDE}

${FREE_AGENT_CONNECT_GUIDE}

${FREE_AGENT_APP_CONNECT_GUIDE}

${FREE_AGENT_BROWSER_GUIDE}

${FREE_AGENT_TEAM_GUIDE}`;
}

/**
 * Create the free agent for a new Workspace inside the creator's transaction:
 * identity, agent row, Workspace and `#general` membership, sealed keys and
 * its exact hello. Its Machine boots only when work arrives.
 * Returns undefined when the creator already owns the maximum.
 */
type FreeAgentCreationInput={workspaceId:string;creatorId:string;roomId:string;name?:'Beebee'|'Luna';silent?:boolean;team?:boolean};

export async function createFreeAgentInWorkspace(database:SqlDatabase,config:FreeAgentConfig,
  input:FreeAgentCreationInput):Promise<string|undefined>{
  await database.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [input.workspaceId]);
  if (!await reserveStarterAgents(database,input.creatorId,1,config.maxPerOwner)) return undefined;
  return createReservedFreeAgent(database,config,input);
}

async function createReservedFreeAgent(database:SqlDatabase,config:FreeAgentConfig,
  input:FreeAgentCreationInput):Promise<string|undefined>{
  const name = input.name ?? 'Beebee';
  if (name === 'Luna' && (await database.query(`SELECT 1 FROM memberships member
    JOIN free_agents free ON free.agent_id=member.identity_id
    WHERE member.workspace_id=$1 AND member.room_id IS NULL AND free.starter_role='luna'`,
    [input.workspaceId])).rowCount) {
    await refundStarterAgent(database,input.creatorId);
    return undefined;
  }
  const agent = generateAgentKeypair();
  const body = generateAgentKeypair();
  const roster = await database.query<{ id: string; name: string; face_id: string | null; handle: string | null }>(
    `SELECT i.id,i.name,i.face_id,i.handle FROM memberships m JOIN identities i ON i.id=m.identity_id
     WHERE m.workspace_id=ANY($1::uuid[]) AND m.room_id IS NULL AND m.removed_at IS NULL
       AND i.hidden_from_roster=false`,
    [[input.workspaceId]],
  );
  const seeded = assignSeededAgentIdentity({
    seed: agent.publicKey,
    takenFaces: roster.rows.map((row) => resolveFace(row.face_id, row.id)),
    takenNames: roster.rows.map((row) => row.name),
  });
  await database.query<{handle:string}>(
    `INSERT INTO identities(id,kind,name,handle,face_id,workspace_handle_base) VALUES($1,'agent',$2,beeline_identity_handle($1,$3),$4,$3) RETURNING handle`,
    [agent.publicKey, name, agentHandleFromName(name), seeded.face],
  );
  await database.query(
    `INSERT INTO agents(agent_id,owner_id,soul,selected_model,machine_id,machine_name,harness)
     VALUES($1,$2,$3::jsonb,$4,$5,'Beeline cloud',$6)`,
    [
      agent.publicKey,
      input.creatorId,
      JSON.stringify({
        name,
        instructions: freeAgentInstructions(seeded.soul, name, config),
        avatarSeed: agent.publicKey,
      }),
      freeAgentHarnessModel(config),
      `free-agent:${agent.publicKey}`,
      FREE_AGENT_HARNESS,
    ],
  );
  await database.query(
    `INSERT INTO free_agents(agent_id,owner_id,sealed_keys,model,starter_role)
     VALUES($1,$2,$3,$4,$5)`,
    [
      agent.publicKey,
      input.creatorId,
      sealSecrets(config.sealSecret, { agent: agent.secretKey, body: body.secretKey }),
      config.model,
      input.team ? name.toLowerCase() : null,
    ],
  );
  await createInvitedWorkspaceMembership(database, [input.workspaceId, agent.publicKey, input.creatorId]);
  await joinRooms(database, {
    workspaceId: input.workspaceId,
    identityId: agent.publicKey,
    invitedById: input.creatorId,
    rooms: { type: 'rooms', roomIds: [input.roomId] },
    workspaceJoined: true,
  });
  // Subscribed after its own arrival, so only later joins and leaves wake it.
  if (!input.team) await setRoomEventSubscriptions(database, input.roomId, agent.publicKey, FREE_AGENT_EVENT_SUBSCRIPTIONS);
  // Reachable from the first moment: a mention before the Machine has booted
  // is a wake to deliver, not an offline agent.
  await database.query(
    `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body,updated_at)
     VALUES($1,$2,'presence','presence',$3::jsonb,clock_timestamp())
     ON CONFLICT(room_id,agent_id,turn_id,kind) DO NOTHING`,
    [
      input.roomId,
      agent.publicKey,
      JSON.stringify({
        status: 'online',
        held: true,
        asleep: true,
        observedAt: Math.floor(Date.now() / 1000),
      }),
    ],
  );
  const owner = (await database.query<{ handle: string }>(
    `SELECT COALESCE(handle,id) handle FROM identities WHERE id=$1`, [input.creatorId],
  )).rows[0]!;
  const handle = (await database.query<{handle:string}>(
    `SELECT beeline_workspace_handle($1,$2) handle`, [agent.publicKey,input.workspaceId],
  )).rows[0]!.handle;
  const hello = FREE_AGENT_HELLO.replace('<owner>', owner.handle).replace('<handle>', handle);
  const helloId = createHash('sha256').update(`free-agent-hello:${agent.publicKey}`).digest('hex');
  // An ordinary agent-authored message: the existing mention/push path notifies the owner.
  if (!input.silent) await database.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`,
    [helloId, input.roomId, agent.publicKey, hello],
  );
  await recordFreeAgentEvent(database, agent.publicKey, 'created', {
    workspaceId: input.workspaceId,
  });
  return agent.publicKey;
}

/**
 * Operator path for a Workspace created before free agents existed: give it
 * one, owned by its oldest owner, in its #general (or, without one, its
 * oldest public top-level Room). Returns the agent, or undefined when the
 * Workspace already has one or its owner is at the limit.
 */
export async function addFreeAgentToWorkspace(
  database: SqlDatabase,
  service: Pick<FreeAgentService, 'createInWorkspace'>,
  workspaceId: string,
): Promise<string | undefined> {
  const agentId = await database.transaction(async (db) => {
    // Serialize operator retries so two additions cannot post two first hellos.
    await db.query(`SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, [workspaceId]);
    const existing = await db.query(`SELECT 1 FROM memberships member
      JOIN free_agents free ON free.agent_id=member.identity_id
      WHERE member.workspace_id=$1 AND member.room_id IS NULL`, [workspaceId]);
    if (existing.rowCount) return undefined;
    const target = (
      await db.query<{ owner_id: string; room_id: string }>(
        `SELECT owner.identity_id owner_id,room.id room_id
         FROM memberships owner
         JOIN identities person ON person.id=owner.identity_id AND person.kind='human'
         JOIN rooms room ON room.workspace_id=owner.workspace_id AND room.parent_id IS NULL
           AND room.direct_participants IS NULL AND room.archived_at IS NULL AND room.visibility='public'
         WHERE owner.workspace_id=$1 AND owner.room_id IS NULL AND owner.role='owner' AND owner.removed_at IS NULL
         ORDER BY owner.joined_at,owner.id,(lower(room.name)='general') DESC,room.created_at,room.id
         LIMIT 1`,
        [workspaceId],
      )
    ).rows[0];
    if (!target) throw new Error(`Workspace ${workspaceId} has no owner or public Room`);
    return service.createInWorkspace(db, {
      workspaceId,
      creatorId: target.owner_id,
      roomId: target.room_id,
    });
  });
  return agentId;
}

export async function recordFreeAgentEvent(
  database: Pick<SqlDatabase, 'query'>,
  agentId: string,
  kind: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await database.query(
    `INSERT INTO free_agent_events(agent_id,kind,detail) VALUES($1,$2,$3::jsonb)`,
    [agentId, kind, detail ? JSON.stringify(detail) : null],
  );
}

/** Whether this agent is a free agent the server may wake. */
export function freeAgentReachableSql(agentIdSql: string): string {
  return `EXISTS (SELECT 1 FROM free_agents reachable_free_agent
    WHERE reachable_free_agent.agent_id=${agentIdSql} AND reachable_free_agent.removed_at IS NULL)`;
}

export interface FreeAgentBootstrapGrant {
  agentId: string;
  agentSecretKey: string;
  bodySecretKey: string;
  agentName: string;
  harness: typeof FREE_AGENT_HARNESS;
  model: string;
  soul: string;
  workspaceId: string;
  workspaceName: string;
  pairedBy: string;
  monolithBaseUrl: string;
  daemonExchangeToken: string;
  modelToken: string;
  modelBaseUrl: string;
  upstreamModel: string;
}

/** Free helpers receive workspace connector work, never Squire installs. */
const connectorWorkSql = (agent: string): string => `(
  EXISTS (SELECT 1 FROM workspace_connectors connector
    WHERE connector.helper_agent_id=${agent} AND connector.status='installing')
)`;

/** Identity, work and provider facts; no cached lifecycle readiness. */
interface RuntimeFacts {
  fly_machine_id: string | null;
  removed_at: Date | null;
  pending: boolean;
  connector: boolean;
  connection_id: string | null;
}
const runtimeFactsSql = `SELECT f.fly_machine_id,f.removed_at,
  EXISTS(SELECT 1 FROM agent_commands c WHERE c.agent_id=f.agent_id AND c.state='pending') pending,
  ${connectorWorkSql('f.agent_id')} connector,
  (SELECT c.connection_id FROM agent_connections c JOIN live_server_instances server ON server.instance_id=c.instance_id
    WHERE c.agent_id=f.agent_id AND c.released_at IS NULL
      AND server.renewed_at>clock_timestamp()-interval '90 seconds') connection_id
  FROM free_agents f WHERE f.agent_id=$1`;

/** All machine effects, including suspension and retirement, have one owner. */
export class FreeAgentService {
  readonly #inFlight = new Map<string,Promise<void>>();

  constructor(
    private readonly database: SqlDatabase,
    readonly config: FreeAgentConfig,
    private readonly machines: FreeAgentMachines,
    private readonly createDaemonExchange: (
      agentId: string,
      database: SqlDatabase,
    ) => Promise<{ exchangeToken: string }>,
    private readonly log: (line: string) => void = (line) => console.log(`[free-agents] ${line}`),
    private readonly instanceId: string = randomUUID(),
  ) {}

  async createInWorkspace(
    database: SqlDatabase,
    input: { workspaceId: string; creatorId: string; roomId: string; team?: boolean; timeZone?: string; locale?: string },
  ): Promise<string | undefined> {
    if (!input.team) return createFreeAgentInWorkspace(database,this.config,input);
    await database.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [input.workspaceId]);
    if (!await reserveStarterAgents(database,input.creatorId,2,this.config.maxPerOwner)) {
      return undefined;
    }
    const beebee = await createReservedFreeAgent(database, this.config, { ...input, silent: true, team: true });
    const luna = await createReservedFreeAgent(database, {
      ...this.config, model: this.config.lunaModel ?? 'openai/gpt-6-luna',
    }, { ...input, name: 'Luna', silent: true, team: true });
    if (!beebee || !luna) throw new Error('starter team provisioning failed');
    for (const agent of [beebee, luna]) await setRoomEventSubscriptions(database, input.roomId, agent, FREE_AGENT_EVENT_SUBSCRIPTIONS);
    await createStarterOnboardingRun(database, { roomId: input.roomId, userId: input.creatorId, beebeeId: beebee, lunaId: luna, timeZone: input.timeZone, locale: input.locale });
    return beebee;
  }

  /** Fire-and-forget adapter for already committed work. */
  kick(agentId: string): void {
    void this.reconcile(agentId).catch(error => this.log(`agent ${agentId.slice(0,12)}: ${String(error)}`));
  }

  reconcile(agentId: string, refreshImage = false): Promise<void> {
    const previous = this.#inFlight.get(agentId) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(() => this.#reconcile(agentId, refreshImage))
      .finally(() => { if (this.#inFlight.get(agentId) === work) this.#inFlight.delete(agentId); });
    this.#inFlight.set(agentId,work);
    return work;
  }

  async #reconcile(agentId: string, refreshImage = false): Promise<void> {
    const operationId = randomUUID();
    // A real signal is source evidence; idle time never renews ownership.
    await this.database.query(`INSERT INTO live_server_instances(instance_id,renewed_at) VALUES($1,clock_timestamp())
      ON CONFLICT(instance_id) DO UPDATE SET renewed_at=EXCLUDED.renewed_at`,[this.instanceId]);
    const admitted = await this.database.transaction(async db => {
      // Even a peer that finds an owner must participate in the final row-lock
      // handoff, so a signal cannot slip between its last facts read and release.
      await db.query(`SELECT agent_id FROM free_agents WHERE agent_id=$1 FOR UPDATE`,[agentId]);
      return db.query(`UPDATE free_agents f SET runtime_owner=$2,runtime_operation_id=$3
      WHERE agent_id=$1 AND (runtime_owner IS NULL OR NOT EXISTS(
        SELECT 1 FROM live_server_instances server WHERE server.instance_id=f.runtime_owner
          AND server.renewed_at>clock_timestamp()-interval '90 seconds')) RETURNING agent_id`,
      [agentId,this.instanceId,operationId]);
    });
    if (!admitted.rowCount) return;
    let initial: RuntimeFacts | undefined;
    let completedEffect = false;
    let mutationStarted = false;
    let machineId: string | null = null;
    const owns = async () => Boolean((await this.database.query(`SELECT 1 FROM free_agents
      WHERE agent_id=$1 AND runtime_operation_id=$2 AND removed_at IS NULL`, [agentId,operationId])).rowCount);
    const adopt = async (id: string) => {
      machineId = id;
      await this.database.query(`UPDATE free_agents SET fly_machine_id=$3,removal_cleaned_at=NULL,updated_at=now()
        WHERE agent_id=$1 AND runtime_operation_id=$2`, [agentId,operationId,id]);
    };
    try {
      initial = (await this.database.query<RuntimeFacts>(runtimeFactsSql,[agentId])).rows[0];
      if (!initial) return;
      machineId = initial.fly_machine_id;
      if (initial.removed_at) {
        const machine = machineId ? await this.machines.read(machineId) : await this.machines.find(agentId);
        if (machine) { mutationStarted = true; await this.machines.destroy(machine.id); }
        await this.database.query(`UPDATE free_agents SET fly_machine_id=NULL,removal_cleaned_at=clock_timestamp()
          WHERE agent_id=$1 AND runtime_operation_id=$2`, [agentId,operationId]);
        return;
      }
      const work = initial.pending || initial.connector;
      // A disconnected idle helper needs no provider action. Connection/work
      // events own waking and sleeping; only startup/release visits check images.
      if (!work && !initial.connection_id && !refreshImage) return;
      let machine = machineId ? await this.machines.read(machineId) : undefined;
      machine ??= await this.machines.find(agentId);
      if (!machine) {
        if (!work || !await owns()) return;
        const bootstrap = opaque('bfb');
        await this.database.query(`UPDATE free_agents SET bootstrap_hash=$3 WHERE agent_id=$1 AND runtime_operation_id=$2`,
          [agentId,operationId,tokenHash(bootstrap)]);
        mutationStarted = true;
        const created = await this.machines.create({ agentId,image:this.config.image,region:this.config.region,
          cpus:this.config.cpus,memoryMb:this.config.memoryMb,
          env:{BEELINE_FREE_AGENT_ID:agentId,BEELINE_FREE_AGENT_BOOTSTRAP:bootstrap,BEELINE_SERVER_URL:this.config.publicOrigin} });
        await adopt(created.id);
        completedEffect = true;
        await recordFreeAgentEvent(this.database,agentId,'provisioned',{machineId,operationId});
        return;
      }
      if (machine.id !== machineId) await adopt(machine.id);
      if (!['created','stopped','suspended','started'].includes(machine.state)) return;
      // Queued and running items survive a replacement; never replace an in-progress connector install.
      if (!sameMachineImage(machine.config.image,this.config.image) && !initial.connector) {
        if (!await owns()) return;
        const before = machine;
        mutationStarted = true;
        machine = await this.machines.update(machine,this.config.image);
        if (!machine.instance_id) throw new Error('Fly update returned no replacement version');
        // Provider completion is version-bound. A timeout leaves the result unknown.
        await this.machines.waitFor(machine.id,before.state === 'started' ? 'started' : 'stopped',60,machine.instance_id);
        const observed = await this.machines.read(machine.id);
        if (!observed || observed.instance_id !== machine.instance_id) throw new Error('Fly replacement version is unconfirmed');
        machine = observed;
        completedEffect = true;
      }
      if (machine.state === 'stopped' || machine.state === 'suspended' || machine.state === 'created') {
        if ((work || completedEffect) && await owns()) {
          mutationStarted = true;
          await this.machines.start(machine.id);
          completedEffect = true;
          await recordFreeAgentEvent(this.database,agentId,'start_requested',{machineId:machine.id,operationId,machineVersion:machine.instance_id});
        }
      } else if (machine.state === 'started') {
        // Image replacement does not make an idle connection busy. Re-read work
        // committed during provider observation/replacement before taking its snapshot.
        const current = (await this.database.query<RuntimeFacts>(runtimeFactsSql,[agentId])).rows[0];
        if (current?.connection_id && !current.pending && !current.connector && await owns()) {
          // Work committed while the snapshot is being taken is read at handoff.
          mutationStarted = true;
          await this.machines.suspend(machine.id);
          await this.machines.waitFor(machine.id,'suspended',60,machine.instance_id);
          completedEffect = true;
          await recordFreeAgentEvent(this.database,agentId,'slept',{machineId:machine.id,operationId});
        }
      }
    } catch (error) {
      completedEffect = false;
      await recordFreeAgentEvent(this.database,agentId,'runtime_result_lost',{
        operationId,machineId,...(error instanceof FlyApiError ? {status:error.status,operation:error.operation} : {}) });
      // Observe once over a fresh transport. Never replay the unknown mutation.
      if (mutationStarted) {
        const provider = this.machines.reconnect();
        const observed = machineId ? await provider.read(machineId) : await provider.find(agentId);
        if (observed) await adopt(observed.id);
      }
      throw error;
    } finally {
      await this.database.transaction(async db => {
        // Signals arriving before this row-locked handoff are retained by a
        // committed notification; signals arriving after it can acquire ownership.
        const final = (await db.query<RuntimeFacts>(`${runtimeFactsSql} FOR UPDATE OF f`,[agentId])).rows[0];
        const released = await db.query(`UPDATE free_agents SET runtime_owner=NULL
          WHERE agent_id=$1 AND runtime_operation_id=$2 RETURNING agent_id`,[agentId,operationId]);
        if (released.rowCount && (completedEffect || JSON.stringify(initial) !== JSON.stringify(final)))
          await notifyLive(db,{table:'free_agents',operation:'UPDATE',roomId:'',agentId});
      });
    }
  }

  /** Listener startup/recovery and releases visit durable work and every mapping. */
  async reconcileAll(): Promise<void> {
    const machines = await this.machines.list();
    const rows = await this.database.query<{agent_id:string;fly_machine_id:string|null;needed:boolean}>(`SELECT agent_id,fly_machine_id,
      (${connectorWorkSql('f.agent_id')} OR EXISTS(SELECT 1 FROM agent_commands c
        WHERE c.agent_id=f.agent_id AND c.state='pending')) needed FROM free_agents f`);
    const identities = new Set(rows.rows.map(row => row.agent_id));
    for (const machine of machines) {
      const agent = (machine.config.metadata as {beeline_agent?:string}|undefined)?.beeline_agent;
      if (!agent || !identities.has(agent)) this.log(`unmapped machine ${machine.id}: preserved; ownership reconciliation required`);
    }
    const failures: string[] = [];
    for (const row of rows.rows) {
      if (!row.fly_machine_id && !row.needed && !machines.some(machine =>
        (machine.config.metadata as {beeline_agent?:string}|undefined)?.beeline_agent === row.agent_id)) continue;
      try { await this.reconcile(row.agent_id, true); }
      catch { failures.push(row.agent_id); }
    }
    if (failures.length) throw new Error(`Free-agent observation unavailable for ${failures.length} Machines`);
  }

  /**
   * First boot of a Machine: hand it everything it needs to stage its helper.
   * Valid until the agent first connects; each call mints a fresh daemon
   * exchange and model token, so a crashed first boot can simply retry.
   */
  async bootstrap(token: string): Promise<FreeAgentBootstrapGrant | undefined> {
    return this.database.transaction(async (database) => {
      const row = (
        await database.query<{
          agent_id: string;
          owner_id: string;
          workspace_id: string;
          workspace_name: string;
          sealed_keys: string;
          name: string;
          soul: { instructions?: string } | null;
          model: string | null;
        }>(
          `SELECT f.agent_id,f.owner_id,member.workspace_id,w.name workspace_name,f.sealed_keys,
                  i.name,a.soul,f.model
           FROM free_agents f
           JOIN LATERAL (SELECT workspace.workspace_id FROM memberships workspace
             WHERE workspace.identity_id=f.agent_id AND workspace.room_id IS NULL AND workspace.removed_at IS NULL
             ORDER BY workspace.joined_at,workspace.id LIMIT 1) member ON true
           JOIN workspaces w ON w.id=member.workspace_id
           JOIN identities i ON i.id=f.agent_id JOIN agents a ON a.agent_id=f.agent_id
           WHERE f.bootstrap_hash=$1 AND f.removed_at IS NULL
           FOR UPDATE OF f`,
          [tokenHash(token)],
        )
      ).rows[0];
      if (!row) return undefined;
      const keys = openSecrets<{ agent: string; body: string }>(this.config.sealSecret, row.sealed_keys);
      const modelToken = opaque('bfm');
      await database.query(
        `UPDATE free_agents SET model_token_hash=$2,updated_at=now() WHERE agent_id=$1`,
        [row.agent_id, tokenHash(modelToken)],
      );
      const exchange = await this.createDaemonExchange(row.agent_id, database);
      await recordFreeAgentEvent(database, row.agent_id, 'bootstrapped');
      return {
        agentId: row.agent_id,
        agentSecretKey: keys.agent,
        bodySecretKey: keys.body,
        agentName: row.name,
        harness: FREE_AGENT_HARNESS,
        model: freeAgentHarnessModel({ model: row.model ?? this.config.model }),
        soul: row.soul?.instructions ?? '',
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        pairedBy: row.owner_id,
        monolithBaseUrl: new URL(this.config.publicOrigin).origin,
        daemonExchangeToken: exchange.exchangeToken,
        modelToken,
        modelBaseUrl: `${new URL(this.config.publicOrigin).origin}/v1/free-agents/model`,
        upstreamModel: row.model ?? this.config.model,
      };
    });
  }

  /** Tombstones are cleanup work for the same serialized owner. */
  remove(agentId: string): void { this.kick(agentId); }

  async cleanupRemoved(agentId: string): Promise<boolean> {
    const removed = (await this.database.query(`SELECT 1 FROM free_agents WHERE agent_id=$1 AND removed_at IS NOT NULL`,[agentId])).rowCount;
    if (removed) await this.reconcile(agentId);
    return Boolean(removed);
  }

  subscribeToWakes(live: LiveHub): () => void {
    const catchUp = () => { void this.reconcileAll().catch(error => this.log(`runtime catch-up: ${String(error)}`)); };
    const stopResync = live.subscribeResync(catchUp);
    const stopRecovery = this.database.onRecovery?.(catchUp);
    catchUp();
    const stopEvents = live.subscribeAll(event => {
      if (event.type === 'agent-connection') this.kick(event.agentId);
      if (event.type !== 'invalidate') return;
      if (event.reason === 'postgres:free_agents' && !event.targetAgentId) catchUp();
      else if (event.targetAgentId && ['connector-assignment','postgres:agent_commands','postgres:free_agents'].includes(event.reason))
        this.kick(event.targetAgentId);
    });
    return () => { stopEvents(); stopResync(); stopRecovery?.(); };
  }

}

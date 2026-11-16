import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AgentSignInEvent,
  startAgentSignIn, completeAgentSignIn,
} from './agent-sign-in.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { POSTGRES_LIVE_CHANNEL, PostgresLiveListener, type LivePgClient } from './postgres-live.js';
import { COMMAND_COMPLETION_CHANNEL } from './command-completion.js';
import { PgliteDatabase, migratedDatabase } from './test-support.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const AGENT = 'a'.repeat(64);
const OWNER = 'b'.repeat(64);
const MEMBER = 'c'.repeat(64);
const OTHER_AGENT = 'd'.repeat(64);
const CODE = 'pasted-claude-code-7f3a#state-from-claude';
const LINK = 'https://claude.com/cai/oauth/authorize?code=true&state=s';

const SNAPSHOT = await (async () => {
  const database = await migratedDatabase();
  try {
    return await database.snapshot();
  } finally {
    await database.close();
  }
})();

class PgliteListenClient extends EventEmitter implements LivePgClient {
  private readonly releases = new Map<string, () => Promise<void>>();
  constructor(private readonly database: PgliteDatabase) { super(); }
  async connect(): Promise<void> {}
  async query(sql: string): Promise<void> {
    const channel = [POSTGRES_LIVE_CHANNEL, COMMAND_COMPLETION_CHANNEL]
      .find(value => sql === `LISTEN ${value}`);
    if (!channel) throw new Error(`unexpected query: ${sql}`);
    if (this.releases.has(channel)) return;
    this.releases.set(channel, await this.database.client.listen(channel, payload =>
      this.emit('notification', { channel, payload })));
  }
  async end(): Promise<void> {
    await Promise.all([...this.releases.values()].map(release => release()));
    this.releases.clear();
  }
}

/** Every row of every table, as text, contains `needle` nowhere. */
async function persistedAnywhere(database: PgliteDatabase, needle: string): Promise<string[]> {
  const tables = await database.query<{ name: string }>(
    `SELECT quote_ident(table_schema)||'.'||quote_ident(table_name) AS name
     FROM information_schema.tables
     WHERE table_schema='public' AND table_type='BASE TABLE'`,
  );
  const hits: string[] = [];
  for (const { name } of tables.rows) {
    const found = await database.query(
      `SELECT 1 FROM ${name} row WHERE row::text LIKE '%' || $1 || '%' LIMIT 1`,
      [needle],
    );
    if (found.rowCount) hits.push(name);
  }
  return hits;
}

describe('agent sign-in credentials and ordinary queued login text', () => {
  let database: PgliteDatabase;
  let live: LiveHub;
  let listener: PostgresLiveListener;
  let phone: PhoneService;
  let daemon: DaemonService;
  let helperFrames: AgentSignInEvent[];
  let logged: string[];
  let sent = 0;

  beforeEach(async () => {
    logged = [];
    for (const method of ['log', 'warn', 'error', 'info'] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' '));
      });
    database = PgliteDatabase.fromSnapshot(SNAPSHOT);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
         ($1,'agent','Clara','clara'),($2,'human','Owner','owner'),
         ($3,'human','Member','member'),($4,'agent','Codie','codie')`,
      [AGENT, OWNER, MEMBER, OTHER_AGENT],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES ($1,'Workspace')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES ($1,$2,'General')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO agents(agent_id,owner_id,harness) VALUES ($1,$2,'claude'),($3,$2,'custom')`,
      [AGENT, OWNER, OTHER_AGENT],
    );
    for (const [identity, role] of [
      [AGENT, 'member'],
      [OWNER, 'owner'],
      [MEMBER, 'admin'],
      [OTHER_AGENT, 'member'],
    ] as const)
      for (const room of [null, ROOM])
        await database.query(
          `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES ($1,$2,$3,$4)`,
          [WORKSPACE, room, identity, role],
        );
    await database.query(`INSERT INTO live_server_instances(instance_id) VALUES('instance')`);
    await database.query(
      `INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id)
       VALUES ($1,1,'connection','instance'),($2,1,'connection-2','instance')`,
      [AGENT, OTHER_AGENT],
    );
    live = new LiveHub();
    const client = new PgliteListenClient(database);
    listener = new PostgresLiveListener(database, live, () => client);
    void listener.run();
    await vi.waitFor(() => expect(listener.projectionHealth().connected).toBe(true));
    phone = new PhoneService(database, 'https://server.example', undefined, undefined, live);
    daemon = new DaemonService(database, live);
    // What a helper's live session receives (`daemon-live.ts` forwards only these).
    helperFrames = [];
    live.subscribeAll((event) => {
      if (event.type === 'agent-sign-in' && (event.step === 'start' || event.step === 'code'))
        helperFrames.push(event);
    });
  });

  afterEach(async () => {
    await listener.stop();
    await database.close();
    vi.restoreAllMocks();
  });

  /** A helper that answers each frame the way `answerAgentSignInFrame` does. */
  function helper(answer: (event: AgentSignInEvent) => Record<string, unknown> | undefined) {
    return live.subscribeAll((event) => {
      if (event.type !== 'agent-sign-in' || event.agentId !== AGENT) return;
      if (event.step !== 'start' && event.step !== 'code') return;
      const report = answer(event);
      if (report)
        void daemon.execute(
          'reportAgentSignIn',
          { agentId: AGENT, attemptId: event.attemptId, ...report } as never,
          AGENT,
        );
    });
  }

  async function send(author: string, text: string): Promise<string> {
    const messageId = String(++sent).padStart(64, '0');
    await phone.execute('sendRoomMessage', { roomId: ROOM, text, messageId }, author);
    return messageId;
  }

  it('queues login text from any current member without starting a credential flow', async () => {
    await send(OWNER, '@clara /login');
    await send(MEMBER, '@clara login');
    expect((await database.query(`SELECT message->>'body' body,state FROM agent_commands ORDER BY created_at,id`)).rows)
      .toEqual([{ body: '@clara /login', state: 'pending' }, { body: '@clara login', state: 'pending' }]);
    expect(helperFrames).toEqual([]);
  });

  it('relays an explicit sign-in code only to its own helper without persisting it', async () => {
    helper(event => event.step === 'start' ? {kind:'paste-code',authorizeUrl:LINK} : {outcome:'signed-in'});
    const attemptId = randomUUID();
    await expect(startAgentSignIn(database,live,AGENT,{attemptId,cardId:'c'.repeat(64)}))
      .resolves.toMatchObject({authorizeUrl:LINK});
    await expect(completeAgentSignIn(database,live,AGENT,{attemptId,code:CODE})).resolves.toEqual({signedIn:true});
    expect(helperFrames.map(frame=>frame.step)).toEqual(['start','code']);
    expect(await persistedAnywhere(database,'pasted-claude-code')).toEqual([]);
    expect(logged.filter(line=>line.includes('pasted-claude-code'))).toEqual([]);
  });

  it("never lets another agent's helper answer this agent's sign-in", async () => {
    let attemptId = '';
    live.subscribeAll((event) => {
      if (event.type === 'agent-sign-in' && event.step === 'start') {
        attemptId = event.attemptId;
        void daemon.execute(
          'reportAgentSignIn',
          { agentId: OTHER_AGENT, attemptId, kind: 'paste-code', authorizeUrl: 'https://evil.example/' },
          OTHER_AGENT,
        );
      }
    });
    const pending = startAgentSignIn(database, live, AGENT, { attemptId: randomUUID(), cardId: 'c'.repeat(64) });
    await vi.waitFor(() => expect(attemptId).not.toBe(''));
    await expect(
      daemon.execute(
        'reportAgentSignIn',
        { agentId: AGENT, attemptId, kind: 'paste-code', authorizeUrl: 'https://evil.example/' },
        OTHER_AGENT,
      ),
    ).rejects.toThrow(/daemon token does not own requested agent|daemon chat access denied/);
    await daemon.execute('reportAgentSignIn', { agentId: AGENT, attemptId, kind: 'paste-code', authorizeUrl: LINK }, AGENT);
    await expect(pending).resolves.toMatchObject({ authorizeUrl: LINK });
  });
});

import { randomUUID } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { LiveHub } from './live.js';
import { freeAgentReachableSql } from './free-agents.js';
import { notifyAgentConnection } from './postgres-live.js';

const FULL_ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A shortened id must not be cast to uuid; the previous presence room stays. */
function presenceRoomId(roomId: string | undefined): string | null {
  return roomId && FULL_ROOM_ID.test(roomId) ? roomId : null;
}

export const DELIVERY_PICKUP_WINDOW_MS = 90_000;
/** A server that has not renewed for this long is gone; its connections are released. */
export const SERVER_LEASE_EXPIRY_MS = 90_000;

interface PresenceMetadata {
  releaseVersion?: string;
  sourceSha?: string;
  available?: boolean;
  lifecycleId?: string;
}

/** One live helper connection for one agent, held by one server instance. */
interface HeldConnection {
  connectionId: string;
  instanceId: string;
}
/** Presence changes with authenticated traffic and connection lifecycle events. */
export class ConnectionPresence {
  readonly instanceId: string;
  private stopped = false;
  private leaseWrite?: Promise<void>;
  private readonly evidenceWrites = new Map<string, Promise<void>>();
  constructor(private readonly database: SqlDatabase, private readonly live: LiveHub,
    lease: { instanceId?: string } = {}) {
    this.instanceId = lease.instanceId ?? randomUUID();
  }
  async start(): Promise<void> { await this.renewLease(); }
  holdServerConnection(): () => void {
    void this.renewLease().catch(this.report);
    return () => {};
  }
  async renewLease(): Promise<void> {
    if (this.stopped) return;
    if (this.leaseWrite) return this.leaseWrite;
    const work = this.database.query(`INSERT INTO live_server_instances(instance_id,renewed_at) VALUES($1,clock_timestamp())
      ON CONFLICT(instance_id) DO UPDATE SET renewed_at=EXCLUDED.renewed_at`, [this.instanceId])
      .then(() => {});
    this.leaseWrite = work;
    try { await work; } finally { this.leaseWrite = undefined; }
  }
  async claimConnection(agentId: string, metadata: PresenceMetadata & { connectionId: string }): Promise<number> {
    if (this.stopped) throw new Error('connection presence stopped');
    await this.renewLease();
    const { connectionId, ...presence } = metadata;
    return claimAgentConnection(this.database, this.live, agentId, presence, { connectionId, instanceId: this.instanceId });
  }
  async releaseConnection(agentId: string, connectionId: string, forUpdate = false): Promise<void> {
    if (this.stopped) return;
    await releaseAgentConnection(this.database, this.live, agentId, connectionId, forUpdate);
  }
  async announce(roomId: string | undefined, agentId: string, metadata: PresenceMetadata = {}): Promise<void> {
    if (!this.stopped && metadata.lifecycleId)
      await announceAgentLifecycle(this.database, this.live, roomId, agentId, { ...metadata, lifecycleId: metadata.lifecycleId });
  }
  async evidence(roomId: string | undefined, agentId: string): Promise<void> {
    if (this.stopped) return;
    await this.renewLease();
    const running = this.evidenceWrites.get(agentId);
    if (running) return running;
    const work = recordAgentEvidence(this.database, this.live, roomId, agentId);
    this.evidenceWrites.set(agentId, work);
    try { await work; } finally { this.evidenceWrites.delete(agentId); }
  }
  private readonly report = (error: unknown) => console.error('[presence] connection transition failed', error);
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([this.leaseWrite, ...this.evidenceWrites.values()]);
  }
}

export async function announceAgentLifecycle(
  database: SqlDatabase,
  live: LiveHub,
  roomId: string | undefined,
  agentId: string,
  metadata: PresenceMetadata & { lifecycleId: string },
): Promise<void> {
  const announcement = await database.transaction((db) =>
    writeAgentAnnouncement(db, roomId, agentId, metadata),
  );
  if (announcement.changed) await broadcastAgentPresence(database, live, agentId);
}

/**
 * Record a newly accepted helper connection and hold the agent's presence
 * online for as long as it lives. The epoch only grows, so whichever instance
 * accepted the newest connection wins, and every other instance drops its own.
 */
export async function claimAgentConnection(
  database: SqlDatabase,
  live: LiveHub,
  agentId: string,
  metadata: PresenceMetadata,
  connection: HeldConnection,
): Promise<number> {
  const claimedConnection = await database.transaction(async (db) => {
    // A connection carries presence only. Queue items stay pending through
    // reconnects and helper restarts; the helper receives them again.
    const claimed = await db.query<{ epoch: string | number }>(
      `INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id,connected_at,released_at)
       VALUES($1,1,$2,$3,clock_timestamp(),NULL)
       ON CONFLICT(agent_id) DO UPDATE SET epoch=agent_connections.epoch+1,
         connection_id=EXCLUDED.connection_id,instance_id=EXCLUDED.instance_id,
         connected_at=EXCLUDED.connected_at,offline_since=agent_connections.released_at,released_at=NULL
       RETURNING epoch`,
      [agentId, connection.connectionId, connection.instanceId],
    );
    const announcement = await writeAgentAnnouncement(db, undefined, agentId, metadata, connection);
    await db.query(`INSERT INTO free_agent_events(agent_id,kind,detail)
      SELECT agent_id,'connected',jsonb_build_object('connectionId',$2::text) FROM free_agents
      WHERE agent_id=$1 AND removed_at IS NULL`,[agentId,connection.connectionId]);
    return { epoch: Number(claimed.rows[0]?.epoch ?? 0), announcement };
  });
  const { epoch } = claimedConnection;
  await notifyAgentConnection(database,agentId,epoch);
  live.publish({ type: 'agent-connection', roomId: '', agentId, epoch });
  await broadcastAgentPresence(database, live, agentId);
  return epoch;
}

/** Fenced: a connection that is no longer the agent's newest changes nothing. */
export async function releaseAgentConnection(
  database: SqlDatabase,
  live: LiveHub,
  agentId: string,
  connectionId: string,
  forUpdate = false,
): Promise<boolean> {
  const released = await database.transaction(async (db) => {
    const current = await db.query<{ epoch: string | number }>(
      `UPDATE agent_connections SET released_at=clock_timestamp()
       WHERE agent_id=$1 AND connection_id=$2 AND released_at IS NULL RETURNING epoch`,
      [agentId, connectionId],
    );
    if (!current.rowCount) return undefined;
    // A dropped socket leaves queue items pending.
    await db.query(
      `UPDATE live_outputs SET body=body || ${releasedPresenceSql('$1')} || jsonb_build_object(
         'observedAt',GREATEST($3::bigint,COALESCE((body->>'observedAt')::bigint,0)+1)),
         updated_at=clock_timestamp()
       WHERE agent_id=$1 AND kind='presence' AND body->>'connectionId'=$2`,
      [agentId, connectionId, Math.floor(Date.now() / 1000)],
    );
    return Number(current.rows[0]!.epoch);
  });
  if (released !== undefined) {
    await notifyAgentConnection(database,agentId,released);
    live.publish({ type: 'agent-connection', roomId: '', agentId, epoch: released });
    await broadcastAgentPresence(database, live, agentId);
  }
  return released !== undefined;
}

/**
 * Presence once an agent's connection ends. An ordinary agent goes offline.
 * A free agent's Machine sleeps and is started by its next wake, so it stays
 * reachable (`held`) and is marked `asleep`.
 */
function releasedPresenceSql(agentIdSql: string): string {
  return `(CASE WHEN ${freeAgentReachableSql(agentIdSql)}
    THEN jsonb_build_object('status','online','held',true,'asleep',true)
    ELSE jsonb_build_object('status','offline','held',false) END)`;
}

/**
 * Write one presence announcement inside the caller's transaction. A
 * connection claim marks the presence held by that connection; any other
 * announcement keeps whatever connection already holds it.
 */
type Announcement = { changed: boolean; previous?: Record<string, unknown> };

async function writeAgentAnnouncement(
  db: SqlDatabase,
  roomId: string | undefined,
  agentId: string,
  metadata: PresenceMetadata,
  connection?: HeldConnection,
): Promise<Announcement> {
  const body = {
    status: metadata.available === false ? 'offline' : 'online',
    observedAt: Math.floor(Date.now()/1000), evidenceNonce: randomUUID(),
    ...(metadata.lifecycleId ? {lifecycleId:metadata.lifecycleId} : {}),
    ...(metadata.releaseVersion ? {releaseVersion:metadata.releaseVersion} : {}),
    ...(metadata.sourceSha ? {sourceSha:metadata.sourceSha} : {}),
    ...(connection ? {held:true,connectionId:connection.connectionId} : {}),
  };
  const written = await db.query<{previous:Record<string,unknown>|null}>(`WITH previous AS MATERIALIZED (
      SELECT room_id,body FROM live_outputs WHERE agent_id=$1 AND kind='presence' FOR UPDATE
    ), target AS (
      SELECT COALESCE((SELECT room_id FROM previous),$2::uuid,
        (SELECT room_id FROM room_access WHERE identity_id=$1 AND room_id IS NOT NULL AND removed_at IS NULL LIMIT 1)) room_id
    ), written AS (
      INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body,updated_at)
      SELECT target.room_id,$1,'presence','presence',$3::jsonb,clock_timestamp() FROM target WHERE room_id IS NOT NULL
      ON CONFLICT(agent_id) WHERE kind='presence' DO UPDATE
        SET body=jsonb_strip_nulls(jsonb_build_object('releaseVersion',live_outputs.body->'releaseVersion',
          'sourceSha',live_outputs.body->'sourceSha','held',live_outputs.body->'held','connectionId',live_outputs.body->'connectionId'))
          || EXCLUDED.body || jsonb_build_object('observedAt',
          GREATEST((EXCLUDED.body->>'observedAt')::bigint,COALESCE((live_outputs.body->>'observedAt')::bigint,0)+1)),
          updated_at=clock_timestamp()
      RETURNING agent_id
    ) SELECT (SELECT body FROM previous) previous FROM written`, [agentId,presenceRoomId(roomId),JSON.stringify(body)]);
  return {changed:Boolean(written.rowCount),previous:written.rows[0]?.previous??undefined};
}

export async function recordAgentEvidence(
  database: SqlDatabase,
  live: LiveHub,
  roomId: string | undefined,
  agentId: string,
): Promise<void> {
  const changed = await database.query(
    // Lock the presence row before INSERT's owner-projection lock, matching
    // lifecycle UPDATE's row-then-projection order.
    `WITH previous AS MATERIALIZED (
       SELECT output.room_id,output.body FROM live_outputs output
       WHERE output.agent_id=$1 AND output.kind='presence'
       ORDER BY output.updated_at DESC LIMIT 1 FOR UPDATE
     ), target AS MATERIALIZED (
       SELECT membership.room_id,previous.room_id previous_room,previous.body
       FROM (SELECT 1) singleton LEFT JOIN previous ON true
       JOIN room_access membership
         ON membership.room_id=COALESCE($2::uuid,previous.room_id)
        AND membership.identity_id=$1 AND membership.removed_at IS NULL
     ), written AS (
       INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body,updated_at)
       SELECT COALESCE(previous_room,room_id),$1,'presence','presence',
         COALESCE(body,'{}'::jsonb) || jsonb_build_object(
           'status','online',
           'observedAt',GREATEST($3::bigint,COALESCE((body->>'observedAt')::bigint,0)+1),
           'evidenceNonce',$4::text
         ),clock_timestamp()
       FROM target
       ON CONFLICT(room_id,agent_id,turn_id,kind) DO UPDATE SET
         body=live_outputs.body || jsonb_build_object(
           'status','online',
           'observedAt',GREATEST($3::bigint,COALESCE((live_outputs.body->>'observedAt')::bigint,0)+1),
           'evidenceNonce',$4::text
         ),updated_at=EXCLUDED.updated_at
       RETURNING 1
     ) SELECT 1 FROM written`,
    [agentId, presenceRoomId(roomId), Math.floor(Date.now() / 1000), randomUUID()],
  );
  // One canonical presence row produces one PostgreSQL notification. Local
  // subscribers still receive the same membership-authorized projection.
  if (changed.rowCount) await broadcastAgentPresence(database, live, agentId);
}

async function broadcastAgentPresence(
  database: SqlDatabase,
  live: LiveHub,
  agentId: string,
): Promise<void> {
  // Production arms listener-owned fanout so the NOTIFY path alone expands one
  // durable row across memberships. A second writer-local query would duplicate
  // that work on every evidence write.
  if (live.listenerOwnsPresenceFanout()) return;
  const result = await database.query<{
    room_id: string;
    body: { status: 'online' | 'offline'; observedAt: number; held?: unknown };
  }>(
    `SELECT m.room_id,p.body FROM room_access m
        JOIN LATERAL(SELECT body FROM live_outputs WHERE agent_id=$1 AND kind='presence'
          ORDER BY updated_at DESC LIMIT 1)p ON true
        WHERE m.identity_id=$1 AND m.room_id IS NOT NULL AND m.removed_at IS NULL`,
    [agentId],
  );
  for (const row of result.rows)
    live.publish({
      type: 'presence',
      roomId: row.room_id,
      agentId,
      status: row.body.status,
      observedAt: row.body.observedAt,
      ...(row.body.held === true ? { held: true } : {}),
    });
}

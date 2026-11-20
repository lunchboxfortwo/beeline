import { REQUEST_REASONS,agentMessageText,replyNeeded } from '@beeline/api-contract/daemon';
import { queuedContextSql } from './agent-command-context.js';
import { mentionReplyRule } from '@beeline/api-contract/phone';
import { createHash,createHmac,randomBytes,randomUUID,timingSafeEqual } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { recordDiagnostic } from './diagnostics.js';
import { openSecrets,sealSecrets } from './free-agents.js';
import { notifyMcpWakesSql,notifyMcpWebhook,POSTGRES_LIVE_CHANNEL } from './postgres-live.js';
import { connectorHostAcceptedSql, connectorDeliveryChanged, noteConnectorPresence, recoverMemberDelivery } from './rooms-mcp-delivery.js';
import { postMcpWebhook } from './rooms-mcp-members.js';
import type { McpPrincipal } from './rooms-mcp-oauth.js';

// Replay stays in list_mentions; event cursors are null so queued events cannot be skipped.
const ATTACHMENTS = { type: 'array', items: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } };
const MENTION_EVENT = {
  name: 'mention', description: 'A chat message tags this connected Beeline member, or messages it directly.',
  delivery: ['webhook'], inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  payloadSchema: { type: 'object', properties: {
    roomId: { type: 'string' }, messageId: { type: 'string' }, memberId: { type: 'string' },
    replyRule: { type: 'string' }, idempotencyKey: { type: 'string' }, text: { type: 'string' },
    attachments: ATTACHMENTS, institutionalContext: { type: 'string' },
    author: { type: 'object', properties: { id: { type: 'string' }, handle: { type: ['string', 'null'] },
      name: { type: ['string', 'null'] } }, required: ['id', 'handle', 'name'], additionalProperties: false },
  }, required: ['roomId', 'messageId', 'memberId', 'replyRule', 'idempotencyKey', 'text', 'author'], additionalProperties: false },
};
const WAKE_EVENT = {
  name: 'wake',
  description: 'A message, reply, thread assignment, schedule, or lifecycle wake for this connected member.',
  delivery: ['webhook'], inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  payloadSchema: { type: 'object', properties: {
    roomId: { type: 'string' }, address: { type: 'string' }, commandId: { type: 'string' }, id: { type: 'string' },
    from: {type:'object',properties:{agent:{type:'string'},place:{type:'string'}},required:['agent','place'],additionalProperties:false}, text: { type: ['string', 'null'] }, next: { type: 'string' },
    attachments: ATTACHMENTS, institutionalContext: { type: 'string' },
  }, required: ['roomId', 'address', 'commandId', 'id', 'from', 'text', 'next'], additionalProperties: false },
};
type Transport = typeof postMcpWebhook;
interface Subscription {
  id: string; client_id: string; owner_id: string; member_id: string; url: string; secret: string;
  previous_secret: string | null; rotation_until: Date | null; verified_at: Date; expires_at: Date | null;
}
export class McpEventError extends Error {
  constructor(readonly code: number, message: string, readonly data?: { reason: string }) { super(message); }
}
function key(): string {
  const value = process.env.BEELINE_MCP_WEBHOOK_KEY;
  if (!value) throw new McpEventError(-32603, 'Event signing is not configured');
  return value;
}
function invalid(): never { throw new McpEventError(-32602, 'Invalid event subscription arguments'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function signingKey(value: unknown): string {
  if (typeof value !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(value)) return invalid();
  const decoded = Buffer.from(value.slice(6), 'base64');
  if (decoded.length < 24 || decoded.length > 64 || decoded.toString('base64').replace(/=+$/, '') !== value.slice(6).replace(/=+$/, '')) return invalid();
  return value;
}
function headers(id: string, subscriptionId: string, body: string, secret: string, previous?: string): Record<string, string> {
  if (Buffer.byteLength(body) > 256 * 1024) throw new Error('Event payload exceeds 256 KiB');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = (value: string) => 'v1,' + createHmac('sha256', Buffer.from(value.slice(6), 'base64'))
    .update(`${id}.${timestamp}.${body}`).digest('base64');
  return { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp,
    'webhook-signature': [sign(secret), ...(previous ? [sign(previous)] : [])].join(' '),
    'X-MCP-Subscription-Id': subscriptionId };
}

export class RoomsMcpEvents {
  constructor(private readonly db: SqlDatabase, private readonly transport: Transport = postMcpWebhook) {}
  async call(principal: McpPrincipal, method: string, raw: unknown): Promise<object> {
    if (!principal.member_id) throw new McpEventError(-32602, 'Reconnect this member before subscribing');
    const params = raw === undefined ? {} : object(raw);
    if (method === 'events/list') {
      if (Object.keys(params).some(k => !['cursor', '_meta'].includes(k)) || (params.cursor !== undefined && params.cursor !== null)) return invalid();
      return { events: [MENTION_EVENT, WAKE_EVENT] };
    }
    if (method !== 'events/subscribe' && method !== 'events/unsubscribe') throw new McpEventError(-32601, 'Method not found');
    const subscribing = method === 'events/subscribe';
    if (Object.keys(params).some(k => !['name', 'arguments', 'delivery', '_meta', ...(subscribing ? ['cursor', 'ttlMs'] : [])].includes(k))) return invalid();
    if ((params.name !== 'mention' && params.name !== 'wake') || Object.keys(object(params.arguments)).length) return invalid();
    const delivery = object(params.delivery);
    if (delivery.mode !== 'webhook' || typeof delivery.url !== 'string' || delivery.url.length > 2048 ||
      Object.keys(delivery).some(k => !['mode', 'url', ...(subscribing ? ['secret'] : [])].includes(k))) return invalid();
    let url: URL;
    try { url = new URL(delivery.url); } catch { return invalid(); }
    if (url.protocol !== 'https:' || url.hash || url.username || url.password) return invalid();
    const name = params.name === 'wake' ? 'wake' : 'mention';
    const id = 'sub_' + createHash('sha256').update(JSON.stringify([
      principal.client_id, principal.identity_id, principal.member_id, url.href, name, {},
    ])).digest('hex');
    if (!subscribing) {
      await this.db.transaction(async tx=>{
        await tx.query('UPDATE rooms_mcp_event_subscriptions SET expires_at=now() WHERE id=$1 AND member_id=$2', [id, principal.member_id]);
        await tx.query("UPDATE rooms_mcp_delivery SET failure='event_subscription_ended',receipt_at=NULL WHERE member_id=$1 AND subscription_id=$2",[principal.member_id,id]);
        await connectorDeliveryChanged(tx,principal.member_id!);
      });
      return {};
    }
    const secret = signingKey(delivery.secret);
    if (params.cursor !== undefined && params.cursor !== null) return invalid();
    const ttl = params.ttlMs;
    if (ttl !== undefined && ttl !== null && (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl <= 0)) return invalid();
    const expires = typeof ttl === 'number' ? new Date(Date.now() + ttl) : null;
    if(expires && !Number.isFinite(expires.getTime()))return invalid();
    const sealingKey = key();
    const old = (await this.db.query<Subscription>('SELECT * FROM rooms_mcp_event_subscriptions WHERE id=$1', [id])).rows[0];
    const sameSecret = old && openSecrets<string>(sealingKey, old.secret) === secret;
    // Verification is cached persistently, scoped to the principal, URL and signing key.
    if (!sameSecret || old.verified_at.getTime() < Date.now() - 300_000) {
      const challenge = randomBytes(32).toString('base64url');
      const body = JSON.stringify({ type: 'verification', challenge });
      try {
        const response = await this.transport(url.href, { body, readResponse: true, headers: headers('verification_' + randomUUID(), id, body, secret) });
        const result = await response.json() as { challenge?: unknown };
        const echoed = typeof result.challenge === 'string' ? Buffer.from(result.challenge) : Buffer.alloc(0);
        if (!response.ok || echoed.length !== Buffer.byteLength(challenge) || !timingSafeEqual(echoed, Buffer.from(challenge)))
          throw new Error('challenge_failed');
      } catch (error) {
        throw new McpEventError(-32015, 'CallbackEndpointError', {
          reason: error instanceof Error && /timeout|abort/i.test(error.message) ? 'timeout' : 'challenge_failed',
        });
      }
    }
    await this.db.transaction(async tx => {
      // Serialize with refresh/disconnect, and recheck the consent after verification.
      const active = await tx.query(`SELECT c.client_id FROM rooms_mcp_connections c
        JOIN rooms_mcp_members m ON m.client_id=c.client_id AND m.owner_id=c.identity_id
        WHERE c.client_id=$1 AND c.identity_id=$2 AND c.revoked_at IS NULL AND m.member_id=$3 FOR UPDATE OF c`,
      [principal.client_id, principal.identity_id, principal.member_id]);
      if (!active.rowCount) throw new McpEventError(-32602, 'Connection ended');
      const current = (await tx.query<Subscription>('SELECT * FROM rooms_mcp_event_subscriptions WHERE id=$1', [id])).rows[0];
      const changed = current && openSecrets<string>(sealingKey, current.secret) !== secret;
      if(current?.expires_at && current.expires_at.getTime()<=Date.now())
        await tx.query("UPDATE rooms_mcp_delivery SET failure='event_subscription_ended',receipt_at=NULL WHERE member_id=$1 AND mechanism='events' AND subscription_id=$2",[principal.member_id,id]);
      if(changed) await tx.query("UPDATE rooms_mcp_delivery SET failure='event_signing_key_changed',receipt_at=NULL WHERE member_id=$1 AND mechanism='events' AND subscription_id=$2",[principal.member_id,id]);
      await noteConnectorPresence(tx, principal.member_id!);
      await tx.query(`INSERT INTO rooms_mcp_event_subscriptions(id,client_id,owner_id,member_id,url,secret,
        previous_secret,rotation_until,verified_at,expires_at,event_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT(id) DO UPDATE SET secret=EXCLUDED.secret,previous_secret=EXCLUDED.previous_secret,
          rotation_until=EXCLUDED.rotation_until,verified_at=EXCLUDED.verified_at,expires_at=EXCLUDED.expires_at,
          event_name=EXCLUDED.event_name`,
      [id, principal.client_id, principal.identity_id, principal.member_id, url.href, sealSecrets(sealingKey, secret),
        changed ? current.secret : current?.previous_secret ?? null,
        changed ? new Date(Date.now() + 300_000) : current?.rotation_until ?? null,
        sameSecret && old.verified_at.getTime() >= Date.now() - 300_000 ? old.verified_at : new Date(), expires, name]);
      await recoverMemberDelivery(tx,principal);
      await noteConnectorPresence(tx,principal.member_id!);
    });
    return { id, refreshBefore: expires?.toISOString() ?? null, cursor: null, truncated: false };
  }
}

/** Called inside the existing mention write transaction, so retries cannot enqueue a tag twice. */
export async function queueMcpMentionEvents(db: SqlDatabase, member: string, room: string, message: string): Promise<void> {
  const queued = await db.query(`INSERT INTO rooms_mcp_event_deliveries(subscription_id,message_id,room_id,event_id,body)
    SELECT s.id,m.id,m.room_id,'evt_'||s.id||'_'||m.id||'_'||'0',
      json_build_object('eventId','evt_'||s.id||'_'||m.id||'_'||'0','name','mention','timestamp',m.created_at,
        'data',jsonb_build_object('roomId',m.room_id,'messageId',m.id,'memberId',s.member_id,'replyRule',CASE WHEN beeline_room_handle(i.id,m.room_id) IS NULL THEN format($5::text,m.id) ELSE format($4::text,m.id,beeline_room_handle(i.id,m.room_id)) END,
          'idempotencyKey','mention:'||s.member_id||':'||m.id,'text',left(m.text,16000),'attachments',m.attachments,
          'author',json_build_object('id',m.author_id,'handle',beeline_room_handle(i.id,m.room_id),'name',i.name)) ||
          jsonb_strip_nulls(jsonb_build_object('institutionalContext',(SELECT ${queuedContextSql('command')} FROM agent_commands command
            WHERE command.agent_id=s.member_id AND command.source_message_id=m.id ORDER BY command.created_at DESC LIMIT 1))), 'cursor',NULL)::text
    FROM rooms_mcp_event_subscriptions s
    JOIN rooms_mcp_connections c ON c.client_id=s.client_id AND c.identity_id=s.owner_id AND c.revoked_at IS NULL
    JOIN messages m ON m.id=$3 AND m.room_id=$2 AND m.deleted_at IS NULL
    JOIN identities i ON i.id=m.author_id
    WHERE s.member_id=$1 AND beeline_mcp_delivery_owner(s.member_id,'events',s.id) AND (s.expires_at IS NULL OR s.expires_at>now()) AND s.event_name='mention'
    ON CONFLICT(subscription_id,message_id) WHERE message_id IS NOT NULL DO NOTHING
    RETURNING subscription_id`, [member, room, message, mentionReplyRule('%1$s', '%2$s'), mentionReplyRule('%s', null)]);
  if (queued.rowCount) await notifyMcpWebhook(db, room);
}

/**
 * One signed wake for each live wake subscription of the commanded member,
 * folded into the `agent_commands` insert. `inserted` is that write's CTE.
 * A member who has only the mention subscription (today's webhook) receives
 * it there, so an existing subscriber starts without resubscribing. Once a
 * wake subscription is live, mention subscriptions are not also posted.
 * Retries of the same command conflict on (subscription, command). A command
 * with no live subscription inserts nothing and notifies nobody, so the
 * command write stays one statement.
 *
 * Its next is `agentMessageText`, written here in SQL. Parameters, in order,
 * starting at `first`: the live channel and `REQUEST_REASONS`.
 */
export function mcpCommandWakeSql(first: number): { cte: string; join: string; params: readonly unknown[] } {
  const channel = `$${first}`;
  const requests = `$${first + 1}`;
  return {
    params: [POSTGRES_LIVE_CHANNEL, REQUEST_REASONS],
    cte: `queued_mcp_wakes AS (
      INSERT INTO rooms_mcp_event_deliveries(subscription_id,command_id,room_id,event_id,body)
      SELECT s.id,command.id,command.room_id,'evt_'||s.id||'_cmd_'||command.id,
        jsonb_build_object('eventId','evt_'||s.id||'_cmd_'||command.id,'name','wake','timestamp',command.created_at,
          'data',jsonb_build_object(
            'roomId',command.room_id,'address',command.room_id,'commandId',command.id,'id',command.id,
            'from',wake_data.origin,'text',wake_data.body,'attachments',wake_data.files,
            'next',concat_ws(E'\n','From: '||COALESCE(sender.name,wake_data.origin->>'agent')||' in #'||COALESCE(place.name,wake_data.origin->>'place'),
              'id: '||command.id,'Reply needed: '||wake_data.needed::text,'text: '||COALESCE(wake_data.body,''),
              'attachment: '||(SELECT string_agg(COALESCE(file->>'name','attachment'),', ') FROM jsonb_array_elements(wake_data.files) file),
              CASE WHEN wake_data.needed THEN 'Reply(id: '||command.id||', text: ...) with your reply' END)),
          'cursor',NULL)::text
      FROM inserted command
      LEFT JOIN messages source ON source.id=command.source_message_id
      CROSS JOIN LATERAL (SELECT COALESCE(command.message->'route'->'from',command.private_payload->'route'->'from',
          jsonb_build_object('agent',COALESCE(command.private_payload->>'authorId',source.author_id),
            'place',COALESCE(command.private_payload->>'fromRoomId',source.room_id::text,command.room_id::text))) origin,
        left(COALESCE(command.private_payload->>'text',source.text),16000) AS body,
        COALESCE(command.message->'attachments',command.private_payload->'attachments',source.attachments,'[]'::jsonb) AS files,
        (command.reason=ANY(${requests}::text[]) OR command.reason='reply' AND command.private_payload->>'messageAsk' IS NOT NULL) AS needed) wake_data
      LEFT JOIN identities sender ON sender.id=wake_data.origin->>'agent'
      LEFT JOIN rooms place ON place.id=CASE WHEN wake_data.origin->>'place' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (wake_data.origin->>'place')::uuid END
      JOIN rooms_mcp_event_subscriptions s ON s.member_id=command.agent_id AND (s.expires_at IS NULL OR s.expires_at>now())
        AND (s.event_name='wake' OR (s.event_name='mention' AND NOT EXISTS (
          SELECT 1 FROM rooms_mcp_event_subscriptions wake
          JOIN rooms_mcp_connections wake_connection ON wake_connection.client_id=wake.client_id
            AND wake_connection.identity_id=wake.owner_id AND wake_connection.revoked_at IS NULL
          WHERE wake.member_id=command.agent_id AND wake.event_name='wake' AND (wake.expires_at IS NULL OR wake.expires_at>now())
            AND beeline_mcp_delivery_owner(wake.member_id,'events',wake.id))))
      JOIN rooms_mcp_connections c ON c.client_id=s.client_id AND c.identity_id=s.owner_id AND c.revoked_at IS NULL
      WHERE beeline_mcp_delivery_owner(s.member_id,'events',s.id) AND command.state='pending' AND command.action='input' AND command.reason<>'mcp_call'
        AND (command.source_message_id IS NULL OR command.private_payload IS NOT NULL
          OR command.reason NOT IN ('human_tag','direct_message','agent_tag','human_message'))
      ON CONFLICT(subscription_id,command_id) WHERE command_id IS NOT NULL DO NOTHING
      RETURNING room_id
    )`,
    // The aggregate always returns one row, even without deliveries. A LEFT
    // JOIN whose output is unused can be removed by PostgreSQL, skipping
    // pg_notify while still committing the queued delivery. CROSS JOIN keeps
    // the notification in the execution plan without filtering the command.
    join: `CROSS JOIN LATERAL (
      SELECT ${notifyMcpWakesSql(channel)} notified
      FROM (SELECT DISTINCT room_id FROM queued_mcp_wakes) notices
    ) mcp_wake_notice`,
  };
}

/** Each committed webhook notification drains its deliveries once. */
export async function deliverMcpEvents(db: SqlDatabase, transport: Transport, signal?: AbortSignal): Promise<number> {
  let delivered = 0;
  for (;;) {
    if (signal?.aborted) break;
    const row = (await db.query<Subscription & { event_id: string; body: string; message_id: string | null; command_id: string | null; probe_generation: string | null; delivery_generation:string|null; deliverable: boolean }>(`
      WITH claimed AS (
        UPDATE rooms_mcp_event_deliveries d SET claimed_at=now(),attempted_at=now()
        WHERE d.event_id IN (
          SELECT event_id FROM rooms_mcp_event_deliveries
          WHERE delivered_at IS NULL AND claimed_at IS NULL
          ORDER BY event_id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING d.*)
      SELECT s.*,d.event_id,d.body,d.message_id,d.command_id,d.probe_generation,selected.generation delivery_generation,
        (beeline_mcp_delivery_owner(s.member_id,'events',s.id) AND (s.expires_at IS NULL OR s.expires_at>now()) AND c.revoked_at IS NULL AND c.client_id IS NOT NULL
         AND r.archived_at IS NULL AND r.id IS NOT NULL
         AND NOT EXISTS(SELECT 1 FROM agent_commands accepted
           WHERE accepted.agent_id=s.member_id AND (accepted.id=d.command_id OR accepted.source_message_id=d.message_id)
             AND ${connectorHostAcceptedSql('accepted')})
         AND ((d.probe_generation IS NOT NULL AND EXISTS(SELECT 1 FROM rooms_mcp_delivery proof
             WHERE proof.member_id=s.member_id AND proof.generation=d.probe_generation AND proof.receipt_at IS NULL AND proof.failure IS NULL))
           OR (d.message_id IS NOT NULL AND m.deleted_at IS NULL AND m.id IS NOT NULL
             AND NOT EXISTS(SELECT 1 FROM rooms_mcp_mentions mention WHERE mention.member_id=s.member_id
               AND mention.message_id=d.message_id AND mention.cleared_at IS NOT NULL))
           OR (d.command_id IS NOT NULL AND command.id IS NOT NULL AND command.action='input'
             AND command.reason<>'mcp_call'
             AND command.state='pending'))
         AND EXISTS(SELECT 1 FROM room_access rm WHERE rm.room_id=d.room_id AND rm.identity_id=s.member_id AND rm.removed_at IS NULL)
         AND EXISTS(SELECT 1 FROM memberships wm WHERE wm.workspace_id=r.workspace_id AND wm.room_id IS NULL AND wm.identity_id=s.member_id AND wm.removed_at IS NULL)) deliverable
      FROM claimed d JOIN rooms_mcp_event_subscriptions s ON s.id=d.subscription_id
      LEFT JOIN rooms_mcp_delivery selected ON selected.member_id=s.member_id
      LEFT JOIN rooms_mcp_connections c ON c.client_id=s.client_id AND c.identity_id=s.owner_id
      LEFT JOIN rooms r ON r.id=d.room_id LEFT JOIN messages m ON m.id=d.message_id
      LEFT JOIN agent_commands command ON command.id=d.command_id`)).rows[0];
    if (!row || signal?.aborted) break;
    const startedAt = Date.now();
    let state: 'delivered'|'failed'|'skipped' = row.deliverable ? 'failed' : 'skipped';
    let status: number | null = null;
    let category: 'network_error'|'http_error'|'access_ended'|null = row.deliverable ? 'network_error' : 'access_ended';
    if (row.deliverable) {
      try {
        const response = await transport(row.url, { body: row.body,
          headers: headers(row.event_id, row.id, row.body, openSecrets<string>(key(), row.secret),
            row.previous_secret && row.rotation_until && row.rotation_until.getTime() > Date.now()
              ? openSecrets<string>(key(), row.previous_secret) : undefined) });
        status = response.status;
        state = response.ok ? 'delivered' : 'failed';
        category = response.ok ? null : 'http_error';
        if (response.ok) delivered++;

      } catch { /* Best effort; a failure creates no future delivery. */ }
    }
    await db.transaction(async tx => {
      await tx.query(`SELECT id FROM agent_commands WHERE agent_id=$1
        AND (id=$2 OR source_message_id=$3) ORDER BY id FOR UPDATE`, [row.member_id,row.command_id,row.message_id]);
      await tx.query(`UPDATE rooms_mcp_event_deliveries SET delivered_at=now(),completed_at=now(),
        http_status=$2,failure_category=$3,duration_ms=$4,delivery_state=$5 WHERE event_id=$1`,
      [row.event_id,status,category,Date.now()-startedAt,state]);
    });
    if(state==='failed' && (status===404 || status===410)) {
      await db.transaction(async tx=>{
        const ended=await tx.query(`UPDATE rooms_mcp_event_subscriptions SET expires_at=now()
          WHERE id=$1 AND secret=$2 RETURNING id`,[row.id,row.secret]);
        if(ended.rowCount) await tx.query("UPDATE rooms_mcp_delivery SET failure='event_subscription_gone',receipt_at=NULL WHERE member_id=$1 AND generation=$2 AND mechanism='events'",[row.member_id,row.delivery_generation]);
      });
    }
    if(state==='failed' && status!==404 && status!==410) await db.query("UPDATE rooms_mcp_delivery SET failure='event_delivery_failed' WHERE member_id=$1 AND generation=$2 AND mechanism='events'",[row.member_id,row.delivery_generation]);
    if(state==='failed')await connectorDeliveryChanged(db,row.member_id);
    await recordDiagnostic(db,{ name: 'mcp_delivery',...(row.command_id ? { commandId:row.command_id } : {}),deliveryState: state,outcome: state==='delivered' ? 'success' : state==='failed' ? 'failed' : 'unknown',
      ...(status ? { httpStatus: status } : {}),code: category ?? 'host_execution_unknown',durationMs: Date.now()-startedAt },row.owner_id).catch(()=>undefined);
  }
  return delivered;
}

/** list_mentions and legacy webhooks render the same next as the event SQL above. */
export function mcpWakeText(wake: { id: string; fromName?: string | null; placeName?: string | null; from: { agent: string; place: string };
  reason: string | null; ask: unknown; text: string | null; attachments?: readonly { name?: string }[] }): string {
  return agentMessageText({ from: wake.fromName ?? wake.from.agent, place: wake.placeName ?? wake.from.place, id: wake.id,
    replyNeeded: replyNeeded(wake.reason, wake.ask), text: wake.text ?? '', attachments: wake.attachments?.map(file => file.name ?? 'attachment') });
}

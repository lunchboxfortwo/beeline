import type { MemberDelivery } from '@beeline/api-contract/phone';
import { ExpectedRefusalError } from './command-refusal.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { tokenHash } from './auth.js';
import type { SqlDatabase } from './database.js';
import type { McpPrincipal } from './rooms-mcp-oauth.js';
import { MCP_FULL_SCOPE, issueMcpTokens } from './rooms-mcp-connections.js';
import { notifyMcpWebhook, notifyMcpDeliveryChange } from './postgres-live.js';

type DeliveryMechanism = 'local' | 'events' | 'webhook' | 'on_demand';

interface Route {
  member_id: string;
  generation: string;
  mechanism: DeliveryMechanism;
  host: string;
  surface: string;
  conversation: string;
  receipt_at: Date | null;
  failure: string | null;
  credentials_valid: boolean;
}
/** Expiration is a credential read, never an expiry job. A callback or membership is not a proof. */
export async function readMemberDelivery(db: SqlDatabase, member: string): Promise<MemberDelivery> {
  return (await readMemberDeliveries(db, [member])).get(member)!;
}
export async function readMemberDeliveries(
  db: SqlDatabase,
  members: readonly string[],
): Promise<Map<string, MemberDelivery>> {
  const result = new Map<string, MemberDelivery>(
    members.map((member) => [member, { state: 'setup_unfinished', ...deliveryReachability(true) }]),
  );
  if (!members.length) return result;
  const rows = (
    await db.query<Route>(
      `SELECT m.member_id,d.generation,d.mechanism,d.host,d.surface,d.conversation,d.receipt_at,d.failure,
    (c.client_id IS NOT NULL AND c.revoked_at IS NULL AND
      CASE WHEN d.member_id IS NULL THEN (NULLIF(COALESCE(m.callback_url,client.callback_url),'') IS NOT NULL
        OR EXISTS(SELECT 1 FROM rooms_mcp_event_subscriptions s WHERE s.member_id=m.member_id AND (s.expires_at IS NULL OR s.expires_at>now())))
      ELSE CASE d.mechanism WHEN 'events' THEN EXISTS(
        SELECT 1 FROM rooms_mcp_event_subscriptions s WHERE s.id=d.subscription_id AND (s.expires_at IS NULL OR s.expires_at>now()))
      WHEN 'webhook' THEN NULLIF(COALESCE(m.callback_url,client.callback_url),'') IS NOT NULL
      WHEN 'local' THEN d.stream_id IS NOT NULL AND EXISTS(
        SELECT 1 FROM rooms_mcp_tokens t LEFT JOIN rooms_mcp_families f ON f.id=t.family_id
        WHERE t.hash=d.credential_hash AND t.revoked_at IS NULL AND t.expires_at>now()
          AND (t.family_id IS NULL OR f.revoked_at IS NULL))
      ELSE true END END) credentials_valid
    FROM rooms_mcp_members m
    LEFT JOIN rooms_mcp_delivery d ON d.member_id=m.member_id
    LEFT JOIN rooms_mcp_clients client ON client.id=m.client_id
    LEFT JOIN rooms_mcp_connections c ON c.client_id=m.client_id AND c.identity_id=m.owner_id
    WHERE m.member_id=ANY($1::text[])`,
      [members],
    )
  ).rows;
  for (const row of rows) result.set(row.member_id, projectDelivery(row));
  return result;
}
function deliveryReachability(offline: boolean): Pick<MemberDelivery, 'offline' | 'reconnectUrl'> {
  return { offline, ...(offline ? { reconnectUrl: 'https://join.usebeeline.app' } : {}) };
}
function projectDelivery(row: Route): MemberDelivery {
  if (!row.generation)
    return { state: 'setup_unfinished', ...deliveryReachability(!row.credentials_valid) };
  const state = row.failure
    ? 'failed'
    : row.mechanism === 'on_demand'
      ? 'host_without_live_delivery'
      : row.receipt_at && row.credentials_valid
        ? 'proved_ready'
        : 'setup_unfinished';
  return {
    state,
    ...deliveryReachability(Boolean(row.failure) || !row.credentials_valid),
    mechanism: row.mechanism,
    host: row.host,
    surface: row.surface,
    conversation: row.conversation,
    generation: row.generation,
    ...(row.receipt_at
      ? { proof: { generation: row.generation, receivedAt: row.receipt_at.toISOString() } }
      : {}),
    ...(row.failure ? { failure: row.failure } : {}),
  };
}
const field = (v: unknown) => {
  if (typeof v !== 'string' || !v.trim() || v.length > 300)
    throw new ExpectedRefusalError('Delivery host, surface and conversation are required');
  return v;
};
/** Repeated setup of the same binding is idempotent. A real replacement starts a new generation. */
export async function setupMemberDelivery(
  db: SqlDatabase,
  principal: McpPrincipal,
  input: Record<string, unknown>,
) {
  const mechanism = input.mechanism;
  if (!['local', 'events', 'webhook', 'on_demand'].includes(String(mechanism)))
    throw new ExpectedRefusalError('Invalid delivery mechanism');
  const host = field(input.host),
    surface = field(input.surface),
    conversation = field(input.conversation);
  await db.transaction(async (tx) => {
    const active = await tx.query(
      `SELECT c.client_id FROM rooms_mcp_connections c JOIN rooms_mcp_members m
      ON m.client_id=c.client_id AND m.owner_id=c.identity_id
      WHERE m.member_id=$1 AND c.revoked_at IS NULL FOR UPDATE OF c`,
      [principal.member_id],
    );
    if (!active.rowCount) throw new ExpectedRefusalError('Connection ended');
    let subscription: string | null = null;
    if (mechanism === 'events') {
      subscription =
        (
          await tx.query<{ id: string }>(
            `SELECT id FROM rooms_mcp_event_subscriptions
        WHERE member_id=$1 AND (expires_at IS NULL OR expires_at>now()) AND event_name='mention'
        ORDER BY verified_at DESC,id LIMIT 1`,
            [principal.member_id],
          )
        ).rows[0]?.id ?? null;
      if (!subscription)
        throw new ExpectedRefusalError('Ask the host to subscribe to Beeline mention events first');
    }
    if (
      mechanism === 'webhook' &&
      !(
        await tx.query(
          `SELECT 1 FROM rooms_mcp_members m JOIN rooms_mcp_clients c ON c.id=m.client_id
      WHERE m.member_id=$1 AND NULLIF(COALESCE(m.callback_url,c.callback_url),'') IS NOT NULL`,
          [principal.member_id],
        )
      ).rowCount
    )
      throw new ExpectedRefusalError('Create the host webhook routine and call set_webhook first');
    const old = (
      await tx.query<{ generation: string }>(
        `SELECT generation FROM rooms_mcp_delivery
      WHERE member_id=$1 AND mechanism=$2 AND host=$3 AND surface=$4 AND conversation=$5
        AND subscription_id IS NOT DISTINCT FROM $6 AND failure IS NULL`,
        [principal.member_id, mechanism, host, surface, conversation, subscription],
      )
    ).rows[0];
    if (old) return;
    const generation = randomUUID(),
      nonce = randomBytes(32).toString('base64url');
    const receipt = { generation, nonce, conversation };
    const probe = {
      id: generation,
      address: conversation,
      reason: 'join_probe',
      kind: 'join_probe',
      createdAt: new Date().toISOString(),
      text: 'Beeline join delivery check. This is a receipt only and authorizes no work.',
      next: `In this host conversation, call confirm_delivery with ${JSON.stringify(receipt)}. Do not post a Room message.`,
      receipt,
    };
    await tx.query(
      `INSERT INTO rooms_mcp_delivery(member_id,generation,mechanism,host,surface,conversation,nonce_hash,probe,subscription_id,credential_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
      ON CONFLICT(member_id) DO UPDATE SET generation=EXCLUDED.generation,mechanism=EXCLUDED.mechanism,
        host=EXCLUDED.host,surface=EXCLUDED.surface,conversation=EXCLUDED.conversation,nonce_hash=EXCLUDED.nonce_hash,
        probe=EXCLUDED.probe,subscription_id=EXCLUDED.subscription_id,credential_hash=EXCLUDED.credential_hash,
        receipt_at=NULL,failure=NULL,stream_id=NULL,created_at=now()`,
      [
        principal.member_id,
        generation,
        mechanism,
        host,
        surface,
        conversation,
        tokenHash(nonce),
        JSON.stringify(probe),
        subscription,
        principal.hash,
      ],
    );
    await notifyMcpDeliveryChange(tx, principal.member_id!);
    if (mechanism === 'local') {
      await tx.query(
        `SELECT beeline_mcp_stream($1,jsonb_build_object('kind','join_probe','id',$2::text))`,
        [principal.member_id, generation],
      );
    } else if (mechanism === 'events' || mechanism === 'webhook') {
      const room = (
        await tx.query<{ room_id: string }>(
          `SELECT a.room_id FROM room_access a JOIN rooms r ON r.id=a.room_id
        JOIN memberships w ON w.workspace_id=r.workspace_id AND w.room_id IS NULL AND w.identity_id=a.identity_id AND w.removed_at IS NULL
        WHERE a.identity_id=$1 AND a.removed_at IS NULL AND r.archived_at IS NULL ORDER BY r.id LIMIT 1`,
          [principal.member_id],
        )
      ).rows[0]?.room_id;
      if (!room) throw new ExpectedRefusalError('Join a Room before testing delivery');
      if (mechanism === 'events')
        await tx.query(
          `INSERT INTO rooms_mcp_event_deliveries(subscription_id,room_id,event_id,body,probe_generation)
        VALUES($1,$2,$3,$4,$5)`,
          [
            subscription,
            room,
            'probe_' + generation,
            JSON.stringify({
              eventId: 'probe_' + generation,
              name: 'mention',
              timestamp: new Date().toISOString(),
              data: {
                memberId: principal.member_id,
                roomId: room,
                messageId: 'probe_' + generation,
                replyRule: probe.next,
                idempotencyKey: 'probe:' + generation,
                text: probe.next,
                author: { id: principal.identity_id, handle: null, name: null },
              },
              cursor: null,
            }),
            generation,
          ],
        );
      else {
        const call = randomUUID();
        await tx.query(
          `INSERT INTO subscription_webhook_calls(id,member_id,wake_message_id,outcome,byte_size,reason)
          VALUES($1,$2,$3,'woke',0,'join-probe')`,
          [call, principal.member_id, generation],
        );
        await tx.query(
          `INSERT INTO rooms_mcp_webhook_outbox(call_id,member_id,room_id,message_id,body)
          VALUES($1,$2,$3,$4,$5)`,
          [
            call,
            principal.member_id,
            room,
            generation,
            JSON.stringify({ ...probe, memberId: principal.member_id, roomId: room }),
          ],
        );
      }
      await notifyMcpWebhook(tx, room);
    }
  });
  return { delivery: await readMemberDelivery(db, principal.member_id!) };
}
/** The nonce is exposed only to the selected transport, never in a read/setup response or transcript parser. */
export async function confirmMemberDelivery(
  db: SqlDatabase,
  principal: McpPrincipal,
  args: Record<string, unknown>,
) {
  const result = await db.query(
    `UPDATE rooms_mcp_delivery d SET receipt_at=COALESCE(receipt_at,now())
    WHERE member_id=$1 AND generation=$2 AND nonce_hash=$3 AND conversation=$4 AND failure IS NULL
      AND (mechanism='webhook' OR mechanism='events' AND EXISTS(
        SELECT 1 FROM rooms_mcp_event_subscriptions s WHERE s.id=d.subscription_id AND (s.expires_at IS NULL OR s.expires_at>now()))
        OR mechanism='local' AND stream_id IS NOT NULL AND EXISTS(
          SELECT 1 FROM rooms_mcp_tokens t LEFT JOIN rooms_mcp_families f ON f.id=t.family_id
          WHERE t.hash=d.credential_hash AND t.revoked_at IS NULL AND t.expires_at>now()
            AND (t.family_id IS NULL OR f.revoked_at IS NULL))) AND EXISTS(SELECT 1 FROM rooms_mcp_members m JOIN rooms_mcp_connections c
        ON c.client_id=m.client_id AND c.identity_id=m.owner_id WHERE m.member_id=d.member_id AND c.revoked_at IS NULL)
    RETURNING generation`,
    [
      principal.member_id,
      field(args.generation),
      tokenHash(field(args.nonce)),
      field(args.conversation),
    ],
  );
  if (!result.rowCount)
    throw new ExpectedRefusalError(
      'Delivery receipt does not match the current member, generation and conversation',
    );
  await notifyMcpDeliveryChange(db, principal.member_id!);
  return { delivery: await readMemberDelivery(db, principal.member_id!) };
}
export async function localDeliveryProbe(db: SqlDatabase, member: string) {
  return (
    await db.query<{ probe: { id: string; address: string; [key: string]: unknown } }>(
      `SELECT probe FROM rooms_mcp_delivery
    WHERE member_id=$1 AND mechanism='local' AND receipt_at IS NULL AND failure IS NULL`,
      [member],
    )
  ).rows.map((r) => r.probe);
}
export async function failMemberDelivery(
  db: SqlDatabase,
  member: string,
  generation: string,
  reason: string,
) {
  await db.transaction(async (tx) => {
    await tx.query(
      'UPDATE rooms_mcp_delivery SET failure=$3 WHERE member_id=$1 AND generation=$2',
      [member, generation, reason.slice(0, 300)],
    );
    await notifyMcpDeliveryChange(tx, member);
  });
}
/** Setup in the active local assistant adopts the existing consent, with a single-use credential handoff. */
export async function prepareLocalDelivery(
  db: SqlDatabase,
  principal: McpPrincipal,
  origin: string,
  input: Record<string, unknown>,
) {
  const conversation = field(input.conversation);
  const quotedConversation = "'" + conversation.replace(/'/g, "'\\''") + "'";
  const secret = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO rooms_mcp_delivery_attachments(hash,client_id,owner_id,member_id,expires_at)
    VALUES($1,$2,$3,$4,now()+interval '10 minutes')
    ON CONFLICT(member_id) DO UPDATE SET hash=EXCLUDED.hash,client_id=EXCLUDED.client_id,owner_id=EXCLUDED.owner_id,
      expires_at=EXCLUDED.expires_at,consumed_at=NULL`,
    [tokenHash(secret), principal.client_id, principal.identity_id, principal.member_id],
  );
  return {
    command: `npx -y usebeeline@latest join --attach ${secret} --server ${origin} --conversation ${quotedConversation}`,
    instruction:
      'Run this once in the intended local Codex, Antigravity App or Claude Code conversation. It installs delivery for this same member; it does not create another membership.',
  };
}
export async function consumeLocalDelivery(db: SqlDatabase, secret: string) {
  return db.transaction(async (tx) => {
    const row = (
      await tx.query<{ client_id: string; owner_id: string; member_id: string }>(
        `SELECT a.* FROM rooms_mcp_delivery_attachments a
      JOIN rooms_mcp_connections c ON c.client_id=a.client_id AND c.identity_id=a.owner_id AND c.revoked_at IS NULL
      JOIN rooms_mcp_members m ON m.client_id=a.client_id AND m.owner_id=a.owner_id AND m.member_id=a.member_id
      WHERE a.hash=$1 AND a.consumed_at IS NULL AND a.expires_at>now() FOR UPDATE OF a,c`,
        [tokenHash(secret)],
      )
    ).rows[0];
    if (!row) throw new ExpectedRefusalError('Local delivery handoff ended or was already used');
    await tx.query('UPDATE rooms_mcp_delivery_attachments SET consumed_at=now() WHERE hash=$1', [
      tokenHash(secret),
    ]);
    const family = randomBytes(32).toString('base64url');
    await tx.query(
      'INSERT INTO rooms_mcp_families(id,client_id,identity_id,scope) VALUES($1,$2,$3,$4)',
      [family, row.client_id, row.owner_id, MCP_FULL_SCOPE],
    );
    return {
      clientId: row.client_id,
      ...(await issueMcpTokens(
        tx,
        { client_id: row.client_id, identity_id: row.owner_id, scope: MCP_FULL_SCOPE },
        family,
      )),
    };
  });
}

/** A real authenticated host connection may replace its ended route once; reads and clocks never resend a probe. */
export async function recoverMemberDelivery(
  db: SqlDatabase,
  principal: McpPrincipal,
): Promise<void> {
  if (!principal.member_id) return;
  const binding = (
    await db.query<{
      mechanism: string;
      host: string;
      surface: string;
      conversation: string;
      failure: string | null;
    }>(
      `
    SELECT d.mechanism,d.host,d.surface,d.conversation,d.failure FROM rooms_mcp_delivery d
    WHERE d.member_id=$1 AND d.failure IS NOT NULL AND d.mechanism IN ('events','local')
      AND (d.mechanism='local' OR EXISTS(SELECT 1 FROM rooms_mcp_event_subscriptions s
        WHERE s.member_id=d.member_id AND s.event_name='mention' AND (s.expires_at IS NULL OR s.expires_at>now())))`,
      [principal.member_id],
    )
  ).rows[0];
  if (binding) await setupMemberDelivery(db, principal, binding);
}

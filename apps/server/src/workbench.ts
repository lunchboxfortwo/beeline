import { ensureSystemDirectMessageRoom } from './system-line.js';
import { ensureSquireMachine } from './squire-machine.js';
import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CONNECTABLE_CONNECTOR_KINDS,
  isConnectorKind,
  type ConnectorAssignment,
  type ConnectorKind,
  type ConnectorStatus,
  type ConnectorStep,
  type ConnectionUsageRecord,
  type PostConnectionUsageInput,
  type VaultConnectionMeta,
  type WorkbenchCatalogEntry,
} from '@beeline/api-contract/workbench';
import type { ConnectionGrant } from '@beeline/api-contract/daemon';
import { SQUIRE_MCP_TARGET } from '@beeline/api-contract/phone';
import type { SqlDatabase } from './database.js';
import { notifyAgentConfigChange, notifyAgentConfigChanges } from './postgres-live.js';

/**
 * The server authority for Workbench connector provisioning.
 *
 * A connection belongs to the HUMAN who provisioned it; every read and write
 * re-checks `owner_identity_id` against the viewer. Receipts the helper
 * reports land in the owner's read-only @System DM alongside other system notices.
 */

export const CONNECTOR_METADATA_TTL_MS = 5 * 60_000;

export type ConnectorCatalogEntry = WorkbenchCatalogEntry;

const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  { connectorType: 'trusty-squire', name: 'Trusty Squire', available: true },
  { connectorType: 'wallet', name: 'Wallet', available: true },
  { connectorType: 'tailscale', name: 'Tailscale', available: true },
];

export function connectorCatalog(): readonly ConnectorCatalogEntry[] {
  return CONNECTOR_CATALOG;
}

export function connectorDisplayName(type: ConnectorKind): string {
  if (type === 'link') return systemMessage("workbench.link");
  if (type === 'registry-mcp') return systemMessage("workbench.mcp-connector");
  return CONNECTOR_CATALOG.find((entry) => entry.connectorType === type)?.name ?? type;
}

export function isConnectableConnector(type: ConnectorKind): boolean {
  return CONNECTABLE_CONNECTOR_KINDS.includes(type);
}

/**
 * Connector kinds that no longer connect but whose hidden identity already
 * spoke: their receipt DMs stay read-only ledgers with their own face.
 */
const RETIRED_CONNECTOR_KINDS = ['composio'] as const;

const logoCache = new Map<string, string>();

/** Fixed bot logos, including System, served at /v1/connectors/logo/<type>.svg. */
export function connectorLogo(type: string): string | undefined {
  if (
    type !== 'system' &&
    type !== 'google' &&
    !isConnectorKind(type) &&
    !(RETIRED_CONNECTOR_KINDS as readonly string[]).includes(type)
  )
    return undefined;
  const cached = logoCache.get(type);
  if (cached) return cached;
  try {
    const svg = readFileSync(
      fileURLToPath(new URL(`../assets/connectors/${type}.svg`, import.meta.url)),
      'utf8',
    );
    logoCache.set(type, svg);
    return svg;
  } catch {
    return undefined;
  }
}

/** Record helper usage in the connection ledger. */
export async function receiveConnectionUsage(
  database: SqlDatabase,
  input: PostConnectionUsageInput,
  helperAgentId: string,
): Promise<{ connectionId: string; messageId: string | null }[]> {
  // One report may touch several connections; resolve each ref against the
  // connectors this helper serves (the authenticated daemon agent is the
  // helper — the reported agentId is only the turn's speaker).
  const results: { connectionId: string; messageId: string | null }[] = [];
  const byRef = new Map<string, { connection: ConnectionRow; connector: ConnectorRow }>();
  for (const record of input.usage) {
    const resolved = await resolveUsageConnection(database, helperAgentId, record, input);
    if (!resolved) continue;
    const { connection, connector } = resolved;
    byRef.set(connection.reference, { connection, connector });
    const agentId = input.agentId;
    await database.query(
      `INSERT INTO connection_receipts(
         id,connection_id,workspace_id,owner_identity_id,agent_id,
         operation,status_code,bytes,grant_info,turn_key
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        randomUUID(),
        connection.id,
        connector.workspace_id,
        connection.owner_identity_id,
        agentId,
        record.operation,
        record.statusCode ?? null,
        Math.max(0, Math.round(record.bytes ?? 0)),
        record.grantId ?? null,
        input.requestId,
      ],
    );
  }
  for (const { connection } of byRef.values()) {
    results.push({ connectionId: connection.id, messageId: null });
  }
  return results;
}

type ConnectorRow = {
  id: string;
  workspace_id: string;
  owner_identity_id: string;
  connector_type: ConnectorKind;
};
type ConnectionRow = {
  id: string;
  reference: string;
  label: string | null;
  service: string | null;
  owner_identity_id: string;
};

async function resolveUsageConnection(
  database: SqlDatabase,
  helperAgentId: string,
  record: ConnectionUsageRecord,
  input: PostConnectionUsageInput,
): Promise<{ connection: ConnectionRow; connector: ConnectorRow } | undefined> {
  const candidates = (
    await database.query<ConnectionRow & { connector: ConnectorRow }>(
      `SELECT c.id,c.reference,c.label,c.service,c.owner_identity_id,
              CASE WHEN c.machine_id IS NOT NULL THEN jsonb_build_object(
                'workspace_id',COALESCE((SELECT workspace_id FROM rooms WHERE id=$3::uuid),c.workspace_id),
                'owner_identity_id',c.owner_identity_id,'connector_type','trusty-squire')
                ELSE to_jsonb(w) END connector
       FROM workspace_connections c
       JOIN agents a ON a.agent_id=$1
       LEFT JOIN workspace_connectors w ON w.id=c.connector_id
       WHERE (w.helper_agent_id=$1 OR (c.owner_identity_id=a.owner_id
         AND c.machine_id=COALESCE(a.machine_id,a.agent_id))) AND c.reference=$2
       ORDER BY c.created_at`,
      [helperAgentId, record.ref, input.cornerId ?? input.roomId ?? null],
    )
  ).rows;
  let picked = candidates[0];
  if (candidates.length > 1 && (input.roomId || input.cornerId)) {
    const scope = (
      await database.query<{ workspace_id: string }>(`SELECT workspace_id FROM rooms WHERE id=$1`, [
        input.cornerId ?? input.roomId,
      ])
    ).rows[0];
    if (scope)
      picked = candidates.find(
        (candidate) => candidate.connector.workspace_id === scope.workspace_id,
      );
  }
  return picked ? { connection: picked, connector: picked.connector } : undefined;
}

export function isMetadataStale(lastSyncedAt: Date | null): boolean {
  return !lastSyncedAt || Date.now() - lastSyncedAt.getTime() > CONNECTOR_METADATA_TTL_MS;
}

/** Upserts one helper vault report into the sovereign connection rows. */
export async function applyVaultList(
  database: SqlDatabase,
  connector: { owner_identity_id: string; machine_id: string; workspace_id: string },
  connections: readonly VaultConnectionMeta[],
  report: import('@beeline/api-contract/workbench').SquireMachineReport = {status:'connected',reportedAt:Date.now()/1000},
): Promise<boolean> {
  const source=await ensureSquireMachine(database,connector.owner_identity_id,connector.machine_id);
  // One statement for the whole report: a per-entry round trip held the
  // old machine lock for seconds and starved the pool on reconnect.
  const rows = [...new Map(connections.map(entry => [entry.reference, {
    id: randomUUID(),
    reference: entry.reference,
    service: entry.service,
    label: entry.label,
    hosts: entry.allowedHosts ?? [],
    state: entry.state,
    metadata: { fieldNames: entry.fieldNames, vaultCreatedAt: entry.createdAt,
      loginHosts: entry.loginHosts, faviconDomain: entry.faviconDomain, keyName: entry.keyName,
      credentialKind: entry.credentialKind, expiresAt: entry.expiresAt },
  }])).values()];
  const result=await database.query<{applied:boolean}>(
    `WITH accepted AS (
      UPDATE squire_machines SET squire_report=$5::jsonb,revision=revision+1
      WHERE owner_id=$2 AND machine_id=$3 AND revision=$6 AND generation=$8
        AND squire_work->>'disconnected' IS DISTINCT FROM 'true' RETURNING owner_id
    ), reported AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,reference text,service text,label text,
        hosts jsonb,state text,metadata jsonb)
    ), written AS (
      INSERT INTO workspace_connections(id,owner_identity_id,reference,service,label,hosts,state,
        connection_metadata,last_synced_at,machine_id,workspace_id)
      SELECT r.id,$2::text,r.reference,r.service,r.label,r.hosts,r.state,r.metadata,now(),$3::text,$4::uuid
        FROM reported r CROSS JOIN accepted WHERE $7::boolean
      ON CONFLICT (owner_identity_id,machine_id,reference) WHERE machine_id IS NOT NULL
        DO UPDATE SET service=EXCLUDED.service,label=EXCLUDED.label,hosts=EXCLUDED.hosts,
          state=EXCLUDED.state,connection_metadata=EXCLUDED.connection_metadata,last_synced_at=now(),updated_at=now()
    ), removed AS (
      DELETE FROM workspace_connections cached WHERE owner_identity_id=$2 AND machine_id=$3
        AND NOT EXISTS(SELECT 1 FROM reported WHERE reference=cached.reference)
        AND $7::boolean AND EXISTS(SELECT 1 FROM accepted)
    ) SELECT EXISTS(SELECT 1 FROM accepted) applied`,
    [JSON.stringify(rows),connector.owner_identity_id,connector.machine_id,connector.workspace_id,
      JSON.stringify(report),source.revision,report.status==='connected',source.generation]);
  return result.rows[0]!.applied;
}

/** The default steps a freshly paired connector shows while installing. */
export function defaultConnectorSteps(): readonly ConnectorStep[] {
  return [
    { label: 'Install on helper', status: 'pending' },
    { label: 'Connect provider account', status: 'pending' },
  ];
}

const SQUIRE_MACHINE_GRANT_REASON = 'Trusty Squire connected on this machine';

/**
 * Standing owner-approved mcp/squire grants for every agent this person owns
 * on this machine, recorded in the grant ledger. Idle sessions restart through
 * the existing agent-config wake so the next turn mounts the route.
 */
export async function grantSquireToOwnerMachineAgents(
  database: SqlDatabase,
  input: {
    workspaceId: string;
    ownerIdentityId: string;
    machineId: string;
    agentId?: string;
  },
): Promise<string[]> {
  const dmRoomId = await ensureSystemDirectMessageRoom(database, input.workspaceId, input.ownerIdentityId);
  const granted=await database.query<{agent_id:string}>(`INSERT INTO agent_grants(
    id,agent_id,workspace_id,kind,target,reason,requested_by,room_id,status,decided_by,decided_at,auto)
    SELECT gen_random_uuid(),agent.agent_id,$1,'mcp',$4,$5,$2,$6,'approved',$2,now(),false FROM agents agent
    WHERE agent.owner_id=$2 AND COALESCE(agent.machine_id,agent.agent_id)=$3 AND ($7::text IS NULL OR agent.agent_id=$7)
      AND EXISTS(SELECT 1 FROM memberships member WHERE member.identity_id=agent.agent_id AND member.workspace_id=$1
        AND member.room_id IS NULL AND member.removed_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM agent_grants grant_row WHERE grant_row.agent_id=agent.agent_id
        AND grant_row.workspace_id=$1 AND grant_row.kind='mcp' AND grant_row.target=$4 AND grant_row.requested_by=$2
        AND grant_row.status IN ('approved','once') AND (grant_row.expires_at IS NULL OR grant_row.expires_at>now()))
    RETURNING agent_id`,[input.workspaceId,input.ownerIdentityId,input.machineId,SQUIRE_MCP_TARGET,
    SQUIRE_MACHINE_GRANT_REASON,dmRoomId,input.agentId??null]);
  const ids=granted.rows.map(row=>row.agent_id);
  await notifyAgentConfigChanges(database,ids,input.workspaceId);
  return ids;
}

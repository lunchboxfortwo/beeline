import { OwnedModelRefusal, OwnedModelUnknownGeneration } from './owned-model-errors.js';
import type { OwnedModelCredential } from '@beeline/api-contract/helper-model';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SqlDatabase } from './database.js';
import { commandOwnerLiveSql, invocationCommandSql, registerOwnedAccessCheck } from './turn-ownership.js';

/** Release-installed additive primitive for the claim/router/provider adapters;
 * this module creates no transport or rollout switch. */
export const OWNED_MODEL_CREDENTIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS owned_model_credentials (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{32}$'),
 key_version text NOT NULL,
 token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 agent_id text NOT NULL, owner_id text NOT NULL, workspace_id uuid NOT NULL, room_id uuid NOT NULL,
 command_id text NOT NULL, generation_id text NOT NULL, request_id text NOT NULL,
 connection_id text, connection_epoch bigint CHECK(connection_epoch>0), instance_id text,
 model text NOT NULL, agent_model text, model_token_hash text NOT NULL,
 expires_ms bigint CHECK(expires_ms>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), revoked_at timestamptz,
 UNIQUE(command_id,generation_id)
);
-- One invocation has one credential: a resumed batch member finds it by
-- agent and generation, whichever member's claim created it.
CREATE INDEX IF NOT EXISTS owned_model_credentials_invocation ON owned_model_credentials(agent_id,generation_id,created_at);
ALTER TABLE owned_model_credentials ALTER COLUMN expires_ms DROP NOT NULL;
-- A credential belongs to its invocation. Older rows keep their recorded
-- connection only as signed history; new rows record none.
ALTER TABLE owned_model_credentials ALTER COLUMN connection_id DROP NOT NULL,
 ALTER COLUMN connection_epoch DROP NOT NULL, ALTER COLUMN instance_id DROP NOT NULL;
CREATE OR REPLACE FUNCTION beeline_owned_model_credential_immutable() RETURNS trigger AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'owned model credential identity is retained' USING ERRCODE='23514'; END IF;
 IF to_jsonb(NEW)-'revoked_at' IS DISTINCT FROM to_jsonb(OLD)-'revoked_at'
   OR OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
   RAISE EXCEPTION 'owned model credential binding is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_owned_model_credential_immutable ON owned_model_credentials;
CREATE TRIGGER beeline_owned_model_credential_immutable BEFORE UPDATE OR DELETE ON owned_model_credentials
 FOR EACH ROW EXECUTE FUNCTION beeline_owned_model_credential_immutable();
`;

export interface OwnedModelBinding {
  readonly id: string;
  readonly keyVersion: string;
  readonly agentId: string;
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly commandId: string;
  readonly generationId: string;
  readonly requestId: string;
  /** Signed history of older credentials only; never compared to live state. */
  readonly connectionId: string | null;
  readonly connectionEpoch: number | null;
  readonly instanceId: string | null;
  readonly model: string;
  readonly agentModel: string | null;
  readonly modelTokenHash: string;
  readonly expiresMs: number | null;
}
interface CredentialRow {
  id: string; key_version: string; token_hash: string; agent_id: string; owner_id: string; workspace_id: string; room_id: string;
  command_id: string; generation_id: string; request_id: string; connection_id: string | null; connection_epoch: string | number | null;
  instance_id: string | null; model: string; agent_model: string | null; model_token_hash: string; expires_ms: string | number | null;
  revoked_at: Date | null;
}
interface CurrentRow {
  agent_id: string; owner_id: string; workspace_id: string; room_id: string; parent_id: string | null;
  command_id: string; generation_id: string; request_id: string;
  model: string; agent_model: string | null; model_token_hash: string; expires_ms: string | number | null;
}
declare const authenticated: unique symbol;
export type AuthenticatedOwnedModel = Readonly<{ readonly [authenticated]: true; readonly binding: OwnedModelBinding }>;
type Actor = { binding: OwnedModelBinding; tokenHash: string };
export type OwnedModelKeyring = Readonly<{
  currentVersion: string;
  /** Injected server key material only. Never an environment/file read here. */
  key(version: string): Uint8Array | undefined;
}>;
const scalar = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixedEqual(a: Buffer, b: Buffer): boolean { return a.length === b.length && timingSafeEqual(a, b); }
function binding(row: CredentialRow): OwnedModelBinding {
  const value = Object.freeze({ id: row.id, keyVersion: row.key_version, agentId: row.agent_id, ownerId: row.owner_id,
    workspaceId: row.workspace_id, roomId: row.room_id, commandId: row.command_id, generationId: row.generation_id,
    requestId: row.request_id, connectionId: row.connection_id,
    connectionEpoch: row.connection_epoch === null ? null : Number(row.connection_epoch), instanceId: row.instance_id, model: row.model, agentModel: row.agent_model, modelTokenHash: row.model_token_hash,
    expiresMs: row.expires_ms === null ? null : Number(row.expires_ms) });
  if (!/^[a-f0-9]{32}$/.test(value.id) || !/^[A-Za-z0-9._-]{1,32}$/.test(value.keyVersion) ||
      (value.connectionEpoch !== null && (!Number.isSafeInteger(value.connectionEpoch) || value.connectionEpoch < 1)) || (value.expiresMs !== null && (!Number.isSafeInteger(value.expiresMs) || value.expiresMs < 1)) ||
      !/^[a-f0-9]{64}$/.test(value.modelTokenHash) || Object.entries(value).some(([key, item]) =>
        !['expiresMs', 'connectionEpoch', 'agentModel', 'connectionId', 'instanceId'].includes(key) && !scalar(item)) ||
      [value.agentModel, value.connectionId, value.instanceId].some(item => item !== null && !scalar(item))) throw new OwnedModelRefusal();
  return value;
}
function signatureData(value: OwnedModelBinding): string {
  return JSON.stringify([value.id, value.keyVersion, value.agentId, value.ownerId, value.workspaceId, value.roomId,
    value.commandId, value.generationId, value.requestId, value.connectionId, value.connectionEpoch, value.instanceId,
    value.model, value.agentModel, value.modelTokenHash, value.expiresMs]);
}

/** The durable invocation plus current membership, account and model policy.
 * No socket, epoch, server instance or lease takes part. Membership is
 * resolved from stored parent rows, never HTTP metadata. */
const CURRENT = `SELECT command.agent_id,starter.owner_id,room.workspace_id,room.id room_id,room.parent_id,
 command.id command_id,command.generation_id,command.turn_request_id request_id,
 COALESCE(starter.model,$4::text) model,starter.model agent_model,starter.model_token_hash,
 NULL::bigint expires_ms
 FROM agent_commands command JOIN rooms room ON room.id=command.room_id
 JOIN rooms parent ON parent.id=COALESCE(room.parent_id,room.id)
 JOIN agents agent ON agent.agent_id=command.agent_id
 JOIN free_agents starter ON starter.agent_id=command.agent_id AND starter.owner_id=agent.owner_id
 WHERE command.id=$1 AND command.agent_id=$2 AND command.generation_id=$3 AND command.action IN ('input','resume')
   AND starter.removed_at IS NULL
   AND starter.model_token_hash IS NOT NULL AND command.claimed_at IS NOT NULL
   AND room.archived_at IS NULL AND parent.archived_at IS NULL
   AND EXISTS(SELECT 1 FROM memberships workspace WHERE workspace.workspace_id=room.workspace_id AND workspace.room_id IS NULL
     AND workspace.identity_id=command.agent_id AND workspace.removed_at IS NULL)
   AND EXISTS(SELECT 1 FROM memberships member WHERE member.room_id=COALESCE(room.parent_id,room.id)
     AND member.identity_id=command.agent_id AND member.removed_at IS NULL)
   AND EXISTS(SELECT 1 FROM agent_commands invocation_command
     WHERE ${invocationCommandSql('command','invocation_command')})`;

/** Retirement prerequisite for the three signed connection columns. It counts
 * credentials whose signature still covers a connection and whose invocation
 * can still authenticate. At zero no such credential can be accepted again, so
 * the columns can be dropped without a credential-format migration. */
export const LEGACY_CREDENTIAL_BINDINGS_LIVE_SQL = `SELECT count(*)::int live FROM owned_model_credentials credential
  WHERE credential.revoked_at IS NULL
    AND (credential.connection_id IS NOT NULL OR credential.connection_epoch IS NOT NULL OR credential.instance_id IS NOT NULL)
    AND EXISTS(SELECT 1 FROM agent_commands member WHERE member.agent_id=credential.agent_id
      AND member.room_id=credential.room_id AND member.generation_id=credential.generation_id
      AND member.action IN ('input','resume') AND ${commandOwnerLiveSql('member')})`;

export class OwnedModelCredentials {
  private readonly actors = new WeakMap<object, Actor>();
  constructor(private readonly keys: OwnedModelKeyring, private readonly currentDefaultModel: () => string) {}

  private token(value: OwnedModelBinding): string {
    const key = this.keys.key(value.keyVersion);
    if (!key || key.byteLength < 32) throw new OwnedModelRefusal();
    // Neither sealing's key derivation nor the legacy model-token domain is
    // reused as a credential MAC key or message prefix.
    const derived = createHmac('sha256', key).update('beeline:owned-model:credential-key:v1\0').digest();
    const mac = createHmac('sha256', derived).update('beeline:owned-model:credential:v1\0').update(signatureData(value)).digest('hex');
    return `bfmc_v1.${value.id}.${mac}`;
  }

  /** Compose inside the successful claim transaction. A repeated claim of the
   * same invocation, through any of its batch members, returns its one
   * credential, so its attempt ledger stays whole. Only opaque ID, token hash
   * and immutable DB-derived metadata are stored. */
  async issueInTransaction(database: SqlDatabase, input: {
    agentId: string; commandId: string; generationId: string;
  }): Promise<OwnedModelCredential> {
    if (![input.agentId, input.commandId, input.generationId].every(value => scalar(value))) throw new OwnedModelRefusal();
    // The actual claim already owns this row. The explicit read fence also
    // makes direct composition safe against an old in-flight reservation.
    // NOWAIT refuses existing inverse lock owners without a retry timer.
    // One invocation is (agent, Room, generation): the addressed command's Room
    // selects its credential, so equal generations in two Rooms never alias.
    const addressed = (await database.query<{ room_id: string }>('SELECT room_id FROM agent_commands WHERE id=$1 AND agent_id=$2 FOR SHARE NOWAIT',
      [input.commandId, input.agentId])).rows[0];
    if (!addressed) throw new OwnedModelRefusal();
    const model = this.currentDefaultModel();
    const invocation = () => database.query<CredentialRow>(`SELECT * FROM owned_model_credentials
      WHERE agent_id=$1 AND room_id=$2 AND generation_id=$3 ORDER BY created_at,id LIMIT 1`,
      [input.agentId, addressed.room_id, input.generationId]);
    let row = (await invocation()).rows[0];
    // The credential's own command stays its anchor after that member ends.
    const current = (await database.query<CurrentRow>(CURRENT,
      [row?.command_id ?? input.commandId, input.agentId, input.generationId, model])).rows[0];
    if (!current) throw new OwnedModelRefusal();
    if (!row) {
      if ((await database.query(`SELECT 1 FROM owned_model_attempts WHERE command_id=$1 AND generation_id<>$2 AND state='unknown' LIMIT 1`,
        [input.commandId, input.generationId])).rowCount) throw new OwnedModelUnknownGeneration();
      await registerOwnedAccessCheck(database, { id: current.command_id, agent_id: current.agent_id, generation_id: current.generation_id });
      const candidate: CredentialRow = { id: randomBytes(16).toString('hex'), key_version: this.keys.currentVersion,
        token_hash: '', agent_id: current.agent_id, owner_id: current.owner_id, workspace_id: current.workspace_id, room_id: current.room_id,
        command_id: current.command_id, generation_id: current.generation_id, request_id: current.request_id,
        connection_id: null, connection_epoch: null, instance_id: null,
        model: current.model, agent_model: current.agent_model, model_token_hash: current.model_token_hash, expires_ms: current.expires_ms, revoked_at: null };
      const value = binding(candidate); candidate.token_hash = hash(this.token(value));
      row = (await database.query<CredentialRow>(`INSERT INTO owned_model_credentials(id,key_version,token_hash,agent_id,owner_id,workspace_id,room_id,
        command_id,generation_id,request_id,model,agent_model,model_token_hash,expires_ms)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT(command_id,generation_id) DO NOTHING RETURNING *`, [candidate.id, candidate.key_version, candidate.token_hash,
        candidate.agent_id, candidate.owner_id, candidate.workspace_id, candidate.room_id, candidate.command_id, candidate.generation_id,
        candidate.request_id, candidate.model, candidate.agent_model,
        candidate.model_token_hash, candidate.expires_ms])).rows[0];
      row ??= (await invocation()).rows[0];
    }
    if (!row || row.revoked_at) throw new OwnedModelRefusal();
    const value = binding(row), token = this.token(value);
    if (value.ownerId !== current.owner_id || value.workspaceId !== current.workspace_id || value.roomId !== current.room_id ||
        value.requestId !== current.request_id || value.model !== current.model ||
        value.agentModel !== current.agent_model || value.modelTokenHash !== current.model_token_hash ||
        !fixedEqual(Buffer.from(hash(token), 'hex'), Buffer.from(row.token_hash, 'hex')))
      throw new OwnedModelRefusal();
    return Object.freeze({ v: 1, token, expiresAt: null });
  }

  async authenticate(database: SqlDatabase, token: string): Promise<AuthenticatedOwnedModel> {
    const match = /^bfmc_v1\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(token);
    if (!match) throw new OwnedModelRefusal();
    const row = (await database.query<CredentialRow>('SELECT * FROM owned_model_credentials WHERE id=$1', [match[1]])).rows[0];
    if (!row || row.revoked_at) throw new OwnedModelRefusal();
    const value = binding(row), expected = this.token(value);
    if (!fixedEqual(Buffer.from(token), Buffer.from(expected)) || !fixedEqual(Buffer.from(hash(token), 'hex'), Buffer.from(row.token_hash, 'hex')))
      throw new OwnedModelRefusal();
    const actor = Object.freeze({ binding: value }) as AuthenticatedOwnedModel;
    this.actors.set(actor, { binding: value, tokenHash: row.token_hash });
    await this.assertCurrent(database, actor);
    return actor;
  }

  actor(value: AuthenticatedOwnedModel): OwnedModelBinding {
    const actor = this.actors.get(value);
    if (!actor) throw new OwnedModelRefusal();
    return actor.binding;
  }

  /** Serialize provider admission with results, Stop and invocation release.
   * The original command remains the immutable credential/ledger anchor. */
  async lockInvocation(database: SqlDatabase, actor: AuthenticatedOwnedModel): Promise<void> {
    const owned=this.actor(actor);
    await database.query(`SELECT id FROM agent_commands
      WHERE room_id=$1 AND agent_id=$2 AND generation_id=$3
      ORDER BY created_at,id FOR SHARE NOWAIT`,
      [owned.roomId,owned.agentId,owned.generationId]);
  }

  /** Read-only final predicate after the caller acquired its ordered locks. */
  async assertCurrent(database: SqlDatabase, actor: AuthenticatedOwnedModel): Promise<void> {
    const owned = this.actors.get(actor);
    if (!owned) throw new OwnedModelRefusal();
    const value = owned.binding, model = this.currentDefaultModel();
    const stored = (await database.query<CredentialRow>('SELECT * FROM owned_model_credentials WHERE id=$1', [value.id])).rows[0];
    if (!stored || stored.revoked_at || stored.token_hash !== owned.tokenHash || signatureData(binding(stored)) !== signatureData(value))
      throw new OwnedModelRefusal();
    const current = (await database.query<CurrentRow>(CURRENT, [value.commandId, value.agentId, value.generationId, model])).rows[0];
    if (!current || current.owner_id !== value.ownerId || current.workspace_id !== value.workspaceId || current.room_id !== value.roomId ||
        current.request_id !== value.requestId || current.model !== value.model || current.agent_model !== value.agentModel ||
        current.model_token_hash !== value.modelTokenHash) throw new OwnedModelRefusal();
  }
}

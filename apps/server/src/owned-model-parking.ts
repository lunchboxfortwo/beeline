import type { SqlDatabase } from './database.js';
import type { PostTurnReceiptInput } from '@beeline/api-contract/daemon';

/** Causal owner lifetime evidence, not a provider outcome or product state.
 * Install with TURN_OWNERSHIP_SCHEMA before using its effective predicates. */
export const OWNED_MODEL_OWNER_END_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_command_owner_ends (
 command_id text NOT NULL, generation_id text NOT NULL,
 model_request_id text, ended_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 transaction_id bigint NOT NULL DEFAULT txid_current(),
 PRIMARY KEY(command_id,generation_id),
 FOREIGN KEY(command_id,generation_id) REFERENCES agent_command_generation_owners(command_id,generation_id) ON DELETE CASCADE
);
ALTER TABLE agent_command_owner_ends ALTER COLUMN model_request_id DROP NOT NULL;
CREATE OR REPLACE FUNCTION beeline_command_generation_open(command text,generation text) RETURNS boolean
 LANGUAGE sql STABLE AS $$ SELECT NOT EXISTS(SELECT 1 FROM agent_command_owner_ends ended
   WHERE ended.command_id=command AND ended.generation_id=generation) $$;
CREATE OR REPLACE FUNCTION beeline_command_claim_open(command text) RETURNS boolean
 LANGUAGE sql STABLE AS $$ SELECT NOT EXISTS(SELECT 1 FROM agent_command_owner_ends ended WHERE ended.command_id=command) $$;
CREATE OR REPLACE FUNCTION beeline_fence_ended_command_claim() RETURNS trigger AS $$
BEGIN
 IF to_jsonb(NEW)->>'action' IN ('input','resume') AND NEW.state='claimed' AND
   (TG_OP='INSERT' OR ROW(NEW.state,NEW.generation_id,to_jsonb(NEW)->>'action')
     IS DISTINCT FROM ROW(OLD.state,OLD.generation_id,to_jsonb(OLD)->>'action'))
   AND NOT beeline_command_claim_open(NEW.id) THEN
   RAISE EXCEPTION 'command model owner has ended' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_fence_ended_command_claim ON agent_commands;
CREATE TRIGGER beeline_fence_ended_command_claim BEFORE INSERT OR UPDATE
 ON agent_commands FOR EACH ROW EXECUTE FUNCTION beeline_fence_ended_command_claim();
CREATE OR REPLACE FUNCTION beeline_preserve_owner_end() RETURNS trigger AS $$
BEGIN
 IF TG_OP='UPDATE' OR EXISTS(SELECT 1 FROM agent_commands WHERE id=OLD.command_id) THEN
   RAISE EXCEPTION 'command owner end is immutable' USING ERRCODE='23514';
 END IF;
 RETURN OLD;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_preserve_owner_end ON agent_command_owner_ends;
CREATE TRIGGER beeline_preserve_owner_end BEFORE UPDATE OR DELETE ON agent_command_owner_ends
 FOR EACH ROW EXECUTE FUNCTION beeline_preserve_owner_end();
`;
type Identity = { roomId: string; agentId: string; requestId: string; generationId?: string | null };
type Cause = { modelRequestId: string | null };
export class OwnedModelOwnerEndRefusal extends Error {
  constructor() { super('Owned model owner end could not be authorized'); }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function modelInstalled(database: SqlDatabase): Promise<boolean> {
  return (await database.query<{ installed: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace space ON space.oid=relation.relnamespace
    WHERE space.nspname=current_schema() AND relation.relname='owned_model_attempts' AND relation.relkind='r') installed`)).rows[0]?.installed === true;
}
type Member = { id: string; state: string; turn_request_id: string };
/** The invocation is one agent, Room and generation. Its members are locked in
 * the same order as credential admission (OwnedModelCredentials.lockInvocation). */
async function invocationMembers(database: SqlDatabase, input: Identity & { generationId: string }): Promise<Member[]> {
  return (await database.query<Member>(`SELECT id,state,turn_request_id FROM agent_commands
    WHERE room_id=$1 AND agent_id=$2 AND generation_id=$3 AND action IN ('input','resume')
    ORDER BY created_at,id FOR UPDATE`, [input.roomId, input.agentId, input.generationId])).rows;
}
/** The invocation's one credential, whichever member's claim issued it. */
const INVOCATION_CREDENTIAL = `SELECT credential.id FROM owned_model_credentials credential
  WHERE credential.agent_id=$1 AND credential.generation_id=$2 AND credential.room_id=$3
  ORDER BY credential.created_at,credential.id LIMIT 1`;

/** Compose inside the existing actual-authority transaction. The owner end may
 * arrive through any member of the invocation. It records evidence for every
 * claimed or completed member, so no member keeps model authority. No provider
 * I/O, new receipt state, release/refund, requeue or notification is invented
 * here; the receipt owner ends the unfinished members after this returns. */
export async function parkOwnedModelGeneration(database: SqlDatabase, input: Identity, cause: Cause): Promise<boolean> {
  const generationId = input.generationId;
  if (!generationId) throw new OwnedModelOwnerEndRefusal();
  if (cause.modelRequestId!==null&&!uuid.test(cause.modelRequestId)) throw new OwnedModelOwnerEndRefusal();
  const members = (await invocationMembers(database, { ...input, generationId }))
    .filter(member => member.state === 'claimed' || member.state === 'complete');
  const addressed = members.find(member => member.turn_request_id === input.requestId);
  if (!addressed) throw new OwnedModelOwnerEndRefusal();
  const ended = await database.query<{ command_id: string }>(`SELECT command_id FROM agent_command_owner_ends
    WHERE command_id=ANY($1::text[]) AND generation_id=$2`, [members.map(member => member.id), generationId]);
  const open = members.filter(member => !ended.rows.some(row => row.command_id === member.id));
  if (!open.length) return true;
  const credential = (await database.query<{ id: string }>(INVOCATION_CREDENTIAL,
    [input.agentId, generationId, input.roomId])).rows[0];
  // Journal loss supplies no provider outcome or invented request identity.
  // Only an actually issued credential for this invocation can end.
  if (!credential) throw new OwnedModelOwnerEndRefusal();
  let modelRequestId: string | null = null;
  if (cause.modelRequestId !== null) {
    const attempt = (await database.query<{ model_request_id: string }>(
      `SELECT model_request_id FROM owned_model_attempts
       WHERE credential_id=$1 AND agent_id=$2 AND generation_id=$3 AND model_request_id=$4
       LIMIT 1 FOR SHARE`,
      [credential.id, input.agentId, generationId, cause.modelRequestId])).rows[0];
    if (!attempt) throw new OwnedModelOwnerEndRefusal();
    modelRequestId = attempt.model_request_id;
  }
  await database.query('SELECT beeline_register_owned_effect($1,$2,$3)', [addressed.id, input.agentId, generationId]);
  await database.query(`INSERT INTO agent_command_owner_ends(command_id,generation_id,model_request_id)
    SELECT unnest($1::text[]),$2,$3 ON CONFLICT DO NOTHING`, [open.map(member => member.id), generationId, modelRequestId]);
  return true;
}

/** Existing terminal receipt ingress, before all terminal effects. An explicit
 * modelOwnerEnd ends the whole invocation, including committed success whose
 * final response was lost. Without that causal field, only actual UNKNOWN is
 * parked, and only when this receipt ends the invocation's last claimed member. */
export async function parkOwnedModelTerminal(
  database: SqlDatabase, input: PostTurnReceiptInput, agentId: string,
): Promise<boolean> {
  const explicit = input.modelOwnerEnd !== undefined;
  if (explicit && (input.status !== 'failed' || input.heartbeat !== undefined || !input.modelOwnerEnd ||
      typeof input.modelOwnerEnd !== 'object' || Array.isArray(input.modelOwnerEnd) ||
      !(('requestId' in input.modelOwnerEnd && Object.keys(input.modelOwnerEnd).join()==='requestId' &&
        typeof input.modelOwnerEnd.requestId==='string' && uuid.test(input.modelOwnerEnd.requestId)) ||
        ('journalUnavailable' in input.modelOwnerEnd && Object.keys(input.modelOwnerEnd).join()==='journalUnavailable' && input.modelOwnerEnd.journalUnavailable===true)))) throw new OwnedModelOwnerEndRefusal();
  if (!['failed', 'complete'].includes(input.status) || input.heartbeat) return false;
  if (!await modelInstalled(database)) {
    if (explicit) throw new OwnedModelOwnerEndRefusal(); return false;
  }
  const identity = { ...input, agentId };
  if(input.modelOwnerEnd&&'journalUnavailable' in input.modelOwnerEnd)
    return parkOwnedModelGeneration(database,identity,{modelRequestId:null});
  let modelRequestId = input.modelOwnerEnd?.requestId;
  if (!modelRequestId) {
    if (!input.generationId) return false;
    const claimed = (await invocationMembers(database, { ...identity, generationId: input.generationId }))
      .filter(member => member.state === 'claimed');
    if (claimed.some(member => member.turn_request_id !== input.requestId)) return false;
    modelRequestId = (await database.query<{ model_request_id: string }>(`SELECT attempt.model_request_id
      FROM owned_model_attempts attempt WHERE attempt.state='unknown' AND attempt.credential_id=(${INVOCATION_CREDENTIAL})
      ORDER BY attempt.model_request_id LIMIT 1`,
    [agentId, input.generationId, input.roomId])).rows[0]?.model_request_id;
  }
  if (!modelRequestId) return false;
  return parkOwnedModelGeneration(database, identity, { modelRequestId });
}

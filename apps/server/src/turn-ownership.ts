import type { SqlDatabase } from './database.js';
import { OWNED_MODEL_OWNER_END_SCHEMA } from './owned-model-parking.js';

/** Independent rollout gate. Legacy rows and helpers retain their receipt adapter. */
export { networkRouterEnabled as turnOwnershipEnabled } from './network-router-rollout.js';

/** Actual access rows are retained only at the final commit check or
 * synchronous transport enqueue. Earlier authorization is a read. */
export function ownedRoomAccessSql(room:string,agent:string,control:string,retain=false):string {
  if(retain)return `SELECT 1 FROM beeline_retain_owned_access(${room},${agent},${control})`;
  return `SELECT 1 FROM rooms room JOIN rooms parent ON parent.id=COALESCE(room.parent_id,room.id)
    JOIN memberships member ON member.room_id=parent.id AND member.identity_id=${agent} AND member.removed_at IS NULL
    JOIN memberships workspace_member ON workspace_member.workspace_id=room.workspace_id
      AND workspace_member.room_id IS NULL AND workspace_member.identity_id=member.identity_id
      AND workspace_member.removed_at IS NULL
    WHERE room.id=${room} AND (room.archived_at IS NULL OR (room.parent_id IS NOT NULL AND EXISTS(SELECT 1 FROM agent_commands control
      WHERE control.id=${control} AND control.room_id=room.id AND control.agent_id=${agent}
        AND control.action IN ('stop','restart'))))
    `;
}

export const TURN_OWNERSHIP_SCHEMA = `
-- Retired transport columns stay for serving and rollback overlap; nothing
-- reads them, and no trigger rewrites them.
ALTER TABLE agent_connections ADD COLUMN IF NOT EXISTS turn_connection_id text;
ALTER TABLE agent_connections ADD COLUMN IF NOT EXISTS turn_connection_epoch bigint;
ALTER TABLE agent_connections ADD COLUMN IF NOT EXISTS turn_transport_id text;
DROP TRIGGER IF EXISTS beeline_replace_turn_transport ON agent_connections;
DROP FUNCTION IF EXISTS beeline_replace_turn_transport();
-- The claim records how its generation executes: 'helper' for the helper
-- turn-ownership protocol, 'mcp' for connected-app calls, 'legacy' for the
-- installed-helper legacy adapter. NULL is reserved for claims written by
-- images below this release. Dispatch reads this, never a socket.
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS execution_kind text;
DO $$ BEGIN
  -- Replace an earlier check that did not admit 'legacy'.
  IF EXISTS(SELECT 1 FROM pg_constraint WHERE conname='agent_commands_execution_kind'
    AND conrelid='agent_commands'::regclass AND pg_get_constraintdef(oid) NOT LIKE '%legacy%') THEN
    ALTER TABLE agent_commands DROP CONSTRAINT agent_commands_execution_kind;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='agent_commands_execution_kind'
    AND conrelid='agent_commands'::regclass) THEN
    ALTER TABLE agent_commands ADD CONSTRAINT agent_commands_execution_kind CHECK
      (execution_kind IN ('helper','mcp','legacy'));
  END IF;
END $$;
-- Retired transport columns: claims still fill them for rollback overlap
-- below this release. Only the older-claim-writer classifier below reads them.
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS turn_owner_connection_id text;
ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS turn_owner_epoch bigint;
-- Older-image compatibility writer. Images below this release claim without
-- execution_kind during serving and rollback overlap, and never clear it on
-- requeue. When a write sets a generation without declaring a new kind, the
-- database derives it the way those images named their work: an 'mcp:'
-- generation is a connected-app call, a recorded connection is a helper turn,
-- anything else stays NULL (the legacy adapter). Current claims always
-- declare their kind, so derivation never changes their answer. Retirement condition:
-- docs/agent-server-surfaces.md, "Older claim writers".
CREATE OR REPLACE FUNCTION beeline_classify_claim_kind() RETURNS trigger AS $$
BEGIN
  IF NEW.generation_id IS NULL THEN NEW.execution_kind:=NULL; RETURN NEW; END IF;
  IF (TG_OP='INSERT' AND NEW.execution_kind IS NULL) OR (TG_OP='UPDATE'
      AND NEW.generation_id IS DISTINCT FROM OLD.generation_id
      AND NEW.execution_kind IS NOT DISTINCT FROM OLD.execution_kind) THEN
    NEW.execution_kind:=CASE WHEN NEW.generation_id LIKE 'mcp:%' THEN 'mcp'
      WHEN NEW.turn_owner_connection_id IS NOT NULL THEN 'helper' END;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_classify_claim_kind ON agent_commands;
CREATE TRIGGER beeline_classify_claim_kind BEFORE INSERT OR UPDATE OF generation_id ON agent_commands
  FOR EACH ROW EXECUTE FUNCTION beeline_classify_claim_kind();
-- One migration cut for claims admitted before their kind was recorded.
UPDATE agent_commands SET execution_kind=CASE WHEN generation_id LIKE 'mcp:%' THEN 'mcp' ELSE 'helper' END
  WHERE state='claimed' AND execution_kind IS NULL
    AND (generation_id LIKE 'mcp:%' OR turn_owner_connection_id IS NOT NULL);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='agent_commands_turn_owner_pair'
    AND conrelid='agent_commands'::regclass) THEN
    ALTER TABLE agent_commands ADD CONSTRAINT agent_commands_turn_owner_pair CHECK
      ((turn_owner_connection_id IS NULL)=(turn_owner_epoch IS NULL)) NOT VALID;
  END IF;
END $$;
ALTER TABLE agent_commands VALIDATE CONSTRAINT agent_commands_turn_owner_pair;
CREATE INDEX IF NOT EXISTS agent_commands_turn_owner_claimed
  ON agent_commands(agent_id,turn_owner_connection_id,turn_owner_epoch)
  WHERE state='claimed' AND turn_owner_connection_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS agent_command_generation_owners(
  command_id text NOT NULL REFERENCES agent_commands(id) ON DELETE CASCADE,
  generation_id text NOT NULL,
  connection_id text,
  connection_epoch bigint,
  PRIMARY KEY(command_id,generation_id),
  CHECK((connection_id IS NULL)=(connection_epoch IS NULL))
);
-- One migration cut records known legacy generations.
INSERT INTO agent_command_generation_owners(command_id,generation_id)
 SELECT id,generation_id FROM agent_commands
 WHERE generation_id IS NOT NULL ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION beeline_preserve_generation_binding() RETURNS trigger AS $$
BEGIN
  IF TG_OP='UPDATE' OR EXISTS(SELECT 1 FROM agent_commands WHERE id=OLD.command_id) THEN
    RAISE EXCEPTION 'command generation binding is immutable' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_preserve_generation_binding ON agent_command_generation_owners;
CREATE TRIGGER beeline_preserve_generation_binding BEFORE UPDATE OR DELETE ON agent_command_generation_owners
  FOR EACH ROW EXECUTE FUNCTION beeline_preserve_generation_binding();
-- Each generation is recorded once, as the durable key for owner-end evidence.
-- No socket is copied into it; its connection columns are retired history.
CREATE OR REPLACE FUNCTION beeline_bind_command_generation() RETURNS trigger AS $$
BEGIN
  IF NEW.generation_id IS NULL THEN RETURN NULL; END IF;
  INSERT INTO agent_command_generation_owners(command_id,generation_id)
    VALUES(NEW.id,NEW.generation_id) ON CONFLICT DO NOTHING;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_bind_command_generation ON agent_commands;
CREATE TRIGGER beeline_bind_command_generation
  AFTER INSERT OR UPDATE OF generation_id ON agent_commands
  FOR EACH ROW EXECUTE FUNCTION beeline_bind_command_generation();
${OWNED_MODEL_OWNER_END_SCHEMA}
-- Actual owned effects register one ephemeral row per transaction and agent.
-- The deferred trigger re-checks Room access at COMMIT, then removes the row.
-- turn_owned_effect_fences is retired and kept for rollback overlap; serving
-- images on either side of the release register through this one function.
CREATE TABLE IF NOT EXISTS turn_owned_access_checks(
  transaction_id bigint NOT NULL,agent_id text NOT NULL,command_id text NOT NULL,generation_id text NOT NULL,
  PRIMARY KEY(transaction_id,agent_id)
);
CREATE OR REPLACE FUNCTION beeline_register_owned_effect(
  effect_command text,effect_agent text,effect_generation text,effect_connection text DEFAULT NULL,effect_epoch bigint DEFAULT NULL
) RETURNS boolean AS $$
DECLARE previous turn_owned_access_checks%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'owned effect requires read committed' USING ERRCODE='23514';
  END IF;
  SELECT * INTO previous FROM turn_owned_access_checks WHERE transaction_id=txid_current() AND agent_id=effect_agent;
  IF FOUND THEN
    IF previous.command_id IS DISTINCT FROM effect_command OR previous.generation_id IS DISTINCT FROM effect_generation THEN
      RAISE EXCEPTION 'owned transaction crosses execution generations' USING ERRCODE='23514';
    END IF;
    RETURN true;
  END IF;
  INSERT INTO turn_owned_access_checks(transaction_id,agent_id,command_id,generation_id)
    VALUES(txid_current(),effect_agent,effect_command,effect_generation);
  RETURN true;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS beeline_commit_owned_effect ON turn_owned_effect_fences;
DROP FUNCTION IF EXISTS beeline_commit_owned_effect();
-- The retired lease predicate. Its exact signature is dropped on upgrade.
DROP FUNCTION IF EXISTS beeline_command_owner_live(text,text,bigint,timestamptz,timestamptz);
-- Queue writers take membership before command rows, while final effects can
-- already hold command/source rows. Bound the reverse-order wait below the
-- deadlock detector instead of NOWAIT, allowing brief queue contention to clear.
-- Function-local configuration restores the caller's timeout even on failure.
CREATE OR REPLACE FUNCTION beeline_retain_owned_access(access_room uuid,access_agent text,access_control text)
RETURNS SETOF integer LANGUAGE plpgsql SET lock_timeout='500ms' AS $$
BEGIN
  RETURN QUERY ${ownedRoomAccessSql('access_room','access_agent','access_control')}
    FOR SHARE OF room,parent,member,workspace_member;
END; $$;
CREATE OR REPLACE FUNCTION beeline_commit_owned_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM agent_commands command
    WHERE command.id=NEW.command_id AND command.agent_id=NEW.agent_id
      AND EXISTS(${ownedRoomAccessSql('command.room_id','command.agent_id','command.id',true)})) THEN
    RAISE EXCEPTION 'owned effect authority expired before commit' USING ERRCODE='23514';
  END IF;
  DELETE FROM turn_owned_access_checks WHERE transaction_id=NEW.transaction_id AND agent_id=NEW.agent_id;
  RETURN NULL;
END; $$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='turn_owned_access_checks'::regclass
    AND tgname='beeline_commit_owned_access') THEN
    CREATE CONSTRAINT TRIGGER beeline_commit_owned_access AFTER INSERT ON turn_owned_access_checks
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION beeline_commit_owned_access();
  END IF;
END $$;
`;

function prefix(alias?: string): string {
  if (alias !== undefined && !/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error('Invalid command SQL alias');
  return alias ? `${alias}.` : '';
}

/** A claimed command is the running turn's one durable record. Its socket,
 * epoch and server instance are not part of it. */
export function commandOwnerLiveSql(alias?: string): string {
  const p = prefix(alias);
  return `(${p}state='claimed' AND beeline_command_generation_open(${p}id,${p}generation_id))`;
}
/** A claimed helper turn that its helper resumes in the same generation after
 * a restart or a local interruption. Connected-app calls run in their own
 * client, recorded by their claim as execution kind 'mcp'. */
export function helperTurnResumableSql(alias: string): string {
  const p = prefix(alias);
  return `(${p}action IN ('input','resume') AND ${p}execution_kind IS DISTINCT FROM 'mcp' AND ${commandOwnerLiveSql(alias)})`;
}
/** Model work belongs to the invocation, while results remain command-specific. */
export function invocationCommandSql(anchor: string, member: string): string {
  const a=prefix(anchor),m=prefix(member);
  return `${m}room_id=${a}room_id AND ${m}agent_id=${a}agent_id
    AND ${m}generation_id IS NOT DISTINCT FROM ${a}generation_id
    AND ${m}action IN ('input','resume') AND ${commandOwnerLiveSql(member)}`;
}
/** A turn is working only while its exact generation is still claimed. */
export function workingTurnFreshSql(alias: string): string {
  const p=prefix(alias);
  return `EXISTS(SELECT 1 FROM agent_commands working_command
    WHERE working_command.room_id=${p}room_id AND working_command.agent_id=${p}agent_id
      AND working_command.turn_request_id=${p}request_id
      AND working_command.generation_id IS NOT DISTINCT FROM ${p}generation_id
      AND ${commandOwnerLiveSql('working_command')})`;
}

export async function isCommandOwnerLive(database: SqlDatabase, commandId: string): Promise<boolean> {
  const row = await database.query<{ active: boolean }>(`SELECT ${commandOwnerLiveSql('command')} active
    FROM agent_commands command WHERE command.id=$1`, [commandId]);
  return row.rows[0]?.active === true;
}

/** An actual owned effect re-checks Room access when its transaction commits. */
export async function registerOwnedAccessCheck(database: SqlDatabase, command: {
  id: string; agent_id: string; generation_id: string | null;
}): Promise<void> {
  await database.query('SELECT beeline_register_owned_effect($1,$2,$3)', [command.id, command.agent_id, command.generation_id]);
}

/** Archived corners retain only their exact queued cleanup controls. */
export async function lockOwnedTurnRoomAccess(
  database: SqlDatabase, roomId: string, agentId: string, controlId?: string,
): Promise<boolean> {
  const access = await database.query(ownedRoomAccessSql('$1','$2','$3'), [roomId,agentId,controlId??null]);
  return Boolean(access.rowCount);
}

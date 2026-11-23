import type { SqlDatabase } from './database.js';
import { tokenHash } from './free-agents.js';
import { OwnedModelRefusal } from './owned-model-errors.js';

/** Historical per-item credential records retained during the rollout. */
export const RETIRED_OWNED_MODEL_CREDENTIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS owned_model_credentials (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{32}$'),
 key_version text NOT NULL,
 token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 agent_id text NOT NULL, owner_id text NOT NULL, workspace_id uuid NOT NULL, room_id uuid NOT NULL,
 command_id text NOT NULL, generation_id text NOT NULL, request_id text NOT NULL,
 connection_id text, connection_epoch bigint CHECK(connection_epoch>0), instance_id text,
 model text NOT NULL, agent_model text, model_token_hash text,
 expires_ms bigint CHECK(expires_ms>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), revoked_at timestamptz,
 UNIQUE(command_id,generation_id)
);
`;

export interface OwnedModelBinding {
  readonly agentId: string;
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly commandId: string;
  readonly requestId: string;
  readonly invocationId: string | null;
  readonly model: string;
}

interface CurrentRow {
  agent_id: string;
  owner_id: string;
  workspace_id: string;
  room_id: string;
  command_id: string;
  request_id: string;
  invocation_id: string | null;
  model: string;
}

/** The bearer authenticates the agent. The Room only selects among that
 * agent's live turns, with membership and model taken from server rows. */
const CURRENT = `SELECT command.agent_id, starter.owner_id, room.workspace_id, room.id room_id,
 command.id command_id, command.turn_request_id request_id, turn.invocation_id,
 COALESCE(starter.model,$3::text) model
 FROM free_agents starter
 JOIN agents agent ON agent.agent_id=starter.agent_id AND agent.owner_id=starter.owner_id
 JOIN agent_commands command ON command.agent_id=starter.agent_id
 JOIN agent_turns turn ON turn.room_id=command.room_id AND turn.agent_id=command.agent_id
   AND turn.request_id=command.turn_request_id AND turn.status='working'
 JOIN rooms room ON room.id=command.room_id
 JOIN rooms parent ON parent.id=COALESCE(room.parent_id,room.id)
 WHERE starter.model_token_hash=$1 AND room.id::text=$2
   AND ($4::text IS NULL OR command.id=$4)
   AND command.action='input' AND command.state='pending' AND starter.removed_at IS NULL
   AND room.archived_at IS NULL AND parent.archived_at IS NULL
   AND EXISTS(SELECT 1 FROM memberships workspace WHERE workspace.workspace_id=room.workspace_id
     AND workspace.room_id IS NULL AND workspace.identity_id=agent.agent_id AND workspace.removed_at IS NULL)
   AND EXISTS(SELECT 1 FROM memberships member WHERE member.room_id=parent.id
     AND member.identity_id=agent.agent_id AND member.removed_at IS NULL)
 ORDER BY turn.started_at DESC NULLS LAST, command.id LIMIT 1`;

declare const authenticated: unique symbol;
export type AuthenticatedOwnedModel = Readonly<{
  [authenticated]: true;
  binding: OwnedModelBinding;
}>;

export class OwnedModelCredentials {
  private readonly hashes = new WeakMap<AuthenticatedOwnedModel, string>();

  constructor(private readonly defaultModel: string) {}

  async authenticate(database: SqlDatabase, token: string, roomId: string): Promise<AuthenticatedOwnedModel> {
    if (!/^bfm_[A-Za-z0-9_-]{43}$/.test(token)) throw new OwnedModelRefusal();
    const hash = tokenHash(token);
    const current = (await database.query<CurrentRow>(CURRENT, [hash, roomId, this.defaultModel, null])).rows[0];
    if (!current) throw new OwnedModelRefusal();
    const binding = Object.freeze({
      agentId: current.agent_id,
      ownerId: current.owner_id,
      workspaceId: current.workspace_id,
      roomId: current.room_id,
      commandId: current.command_id,
      requestId: current.request_id,
      invocationId: current.invocation_id,
      model: current.model,
    });
    const actor = Object.freeze({ binding }) as AuthenticatedOwnedModel;
    this.hashes.set(actor, hash);
    return actor;
  }

  actor(actor: AuthenticatedOwnedModel): OwnedModelBinding {
    if (!this.hashes.has(actor)) throw new OwnedModelRefusal();
    return actor.binding;
  }

  /** Serialize provider admission with the item's answer and Stop. */
  async lockInvocation(database: SqlDatabase, actor: AuthenticatedOwnedModel): Promise<void> {
    await database.query('SELECT id FROM agent_commands WHERE id=$1 FOR SHARE', [this.actor(actor).commandId]);
  }

  async assertCurrent(database: SqlDatabase, actor: AuthenticatedOwnedModel): Promise<void> {
    const hash = this.hashes.get(actor);
    if (!hash) throw new OwnedModelRefusal();
    const binding = actor.binding;
    const current = (await database.query<CurrentRow>(CURRENT, [
      hash, binding.roomId, this.defaultModel, binding.commandId,
    ])).rows[0];
    if (!current || current.agent_id !== binding.agentId || current.owner_id !== binding.ownerId ||
        current.workspace_id !== binding.workspaceId || current.request_id !== binding.requestId ||
        current.invocation_id !== binding.invocationId || current.model !== binding.model)
      throw new OwnedModelRefusal();
  }
}
